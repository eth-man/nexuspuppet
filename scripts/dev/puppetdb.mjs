#!/usr/bin/env node
/**
 * A local stand-in for PuppetDB, for developing the console without real
 * infrastructure.
 *
 *   node scripts/dev/puppetdb.mjs
 *
 * Serves the synthetic fixtures in /fixtures over REAL mTLS on :8081, and
 * evaluates the PuppetDB query AST that PqlBuilder emits — filters, sorting and
 * pagination behave as a real server would. That matters: an earlier version
 * substring-matched the AST and answered every filtered query with the whole
 * estate, which made the dashboard report "48 failed of 48 nodes" and hid the
 * filtering bugs the stand-in exists to surface.
 *
 * Certificates are generated on first run into scripts/dev/certs/ (gitignored)
 * using openssl. They are throwaway and for local development only.
 *
 * NOT a PuppetDB implementation. It covers the endpoints this console calls,
 * with the shapes documented for the PuppetDB 8 query API v4.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const C = join(here, 'certs');
const F = join(ROOT, 'fixtures');
const PORT = Number(process.env.DEV_PUPPETDB_PORT ?? 8081);

/** Throwaway CA + server + client certs, so the mTLS path is genuinely exercised. */
function ensureCertificates() {
  /*
   * ALL of them, not just client.pem.
   *
   * Guarding on one file means a partially-deleted set is never repaired: the
   * generator returns early, then the server crashes reading the file that is
   * missing. Deleting server.* to force a regeneration — which is exactly what
   * someone does after changing the SAN below — left the stand-in permanently
   * unable to start.
   */
  const REQUIRED = ['ca.pem', 'ca.key', 'server.pem', 'server.key', 'client.pem', 'client.key'];
  if (REQUIRED.every((f) => existsSync(join(C, f)))) return;

  mkdirSync(C, { recursive: true });
  const run = (args) => execFileSync('openssl', args, { cwd: C, stdio: 'pipe' });

  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '365',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-subj',
    '/CN=Dev Puppet CA',
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=localhost',
    /*
     * A SAN, so this is reachable by a name other than localhost.
     *
     * Without one, Node falls back to the CN and the certificate is usable
     * ONLY from the same host — which is fine for `npm run dev:stack` and
     * useless the moment the API runs in a container and resolves this by
     * service name. Staging hit exactly that: mTLS initialised, then every
     * projection failed with "Host: nexuspuppet-puppetdb-standin is not cert's
     * CN: localhost", and the console showed an estate of zero.
     *
     * Extra names can be added for another topology without editing this.
     */
    '-addext',
    `subjectAltName=${process.env['PUPPETDB_STANDIN_SANS'] ?? 'DNS:localhost,DNS:nexuspuppet-puppetdb-standin,IP:127.0.0.1'}`,
  ]);
  run([
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '365',
    '-sha256',
    // Extensions in a CSR are NOT carried into the signed certificate by
    // default, so without this the SAN above is silently dropped and the
    // failure looks identical to never having added it.
    '-copy_extensions',
    'copyall',
    '-out',
    'server.pem',
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'client.key',
    '-out',
    'client.csr',
    '-subj',
    '/CN=nexuspuppet-dev',
  ]);
  run([
    'x509',
    '-req',
    '-in',
    'client.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '365',
    '-sha256',
    '-out',
    'client.pem',
  ]);

  console.log('[dev-puppetdb] generated throwaway certificates in scripts/dev/certs');
}

ensureCertificates();

import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha1 = (value) => createHash('sha1').update(value).digest('hex');

const nodes = JSON.parse(readFileSync(`${F}/nodes-query.sample.json`, 'utf8'));

// The fixtures are generated against a FIXED base instant so they stay
// byte-identical. Served verbatim, every node reads as hours stale and the
// console looks like a broken estate. Shift them to be relative to now.
const FIXTURE_BASE = Date.parse('2026-07-27T09:00:00.000Z');
const shift = Date.now() - FIXTURE_BASE;
const reslide = (iso) => (iso === null ? null : new Date(Date.parse(iso) + shift).toISOString());
for (const n of nodes) {
  n.report_timestamp = reslide(n.report_timestamp);
  n.facts_timestamp = reslide(n.facts_timestamp);
  n.catalog_timestamp = reslide(n.catalog_timestamp);
}
const factset = JSON.parse(readFileSync(`${F}/factset-single-node.sample.json`, 'utf8'))[0];
const successReport = JSON.parse(readFileSync(`${F}/report-success.sample.json`, 'utf8'))[0];
const failureReport = JSON.parse(readFileSync(`${F}/report-failure.sample.json`, 'utf8'))[0];

// Vary facts per node. A real estate is heterogeneous, and identical facts
// across every node would make the rule-authoring value picker useless.
const base = Object.fromEntries(factset.facts.data.map((f) => [f.name, f.value]));

const OS_VARIANTS = [
  { family: 'RedHat', name: 'RedHat', major: '9' },
  { family: 'RedHat', name: 'CentOS', major: '8' },
  { family: 'Debian', name: 'Ubuntu', major: '24.04' },
  { family: 'Debian', name: 'Debian', major: '12' },
  { family: 'Suse', name: 'SLES', major: '15' },
];

const factRows = [];
const factsByNode = new Map();
let index = 0;
for (const n of nodes) {
  if (n.deactivated || n.expired) continue;

  const os = OS_VARIANTS[index % OS_VARIANTS.length];
  const virtual = index % 3 !== 0;
  index += 1;

  // A per-node `role` fact, mirroring the custom fact most estates deploy.
  // Derived from the certname prefix here; in a real estate it comes from the
  // node's own facter config or a role/profile module.
  const role = n.certname.replace(/[0-9].*$/, '');

  const hostname = n.certname.split('.')[0];

  const facts = {
    ...base,
    role,
    // Identity facts follow the node. Without these, every node in the estate
    // reported the fixture donor's hostname, which reads as a data bug on any
    // page showing facts.
    clientcert: n.certname,
    fqdn: n.certname,
    hostname,
    is_virtual: virtual,
    virtual: virtual ? 'kvm' : 'physical',
    os: {
      ...base.os,
      family: os.family,
      name: os.name,
      release: { ...base.os.release, major: os.major },
    },
    networking: { ...base.networking, fqdn: n.certname, hostname },
  };

  factsByNode.set(n.certname, facts);
  for (const [name, value] of Object.entries(facts)) {
    factRows.push({ certname: n.certname, name, value });
  }
}

/**
 * Minimal PuppetDB AST evaluator, covering the operators PqlBuilder emits.
 * Enough for the stand-in to behave like a real server for filtering and
 * sorting — anything less makes the console show numbers that are simply wrong.
 */
/**
 * An operator this stand-in cannot evaluate. Surfaced as a 400, the way real
 * PuppetDB rejects a query it cannot parse.
 *
 * WHY THIS IS AN ERROR AND NOT `return true`. It used to be `return true`, and
 * that made an unsupported operator indistinguishable from no filter at all:
 * fact filtering (#243) shipped to staging returning the whole estate for every
 * filter, including deliberately-impossible ones, and the honest reading of
 * "48 of 48 nodes match `os.name = Nonsense`" was a broken feature. The feature
 * was fine — the stand-in was silently ignoring the subquery. Failing loudly
 * costs one clear error; failing open costs a day chasing the wrong bug.
 */
class UnsupportedQuery extends Error {}

/**
 * A field's value, resolving the dotted paths inventory queries use.
 *
 * Flat rows win on an exact key first, so a node's `certname` is never mistaken
 * for a walk into an object, and `facts.os.name` walks into the fact map.
 */
function resolveField(row, field) {
  if (row === null || typeof row !== 'object') return undefined;
  if (field in row) return row[field];

  let current = row;
  for (const part of String(field).split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * The values a `["from", <entity>, ["extract", <field>, <condition>]]` subquery
 * yields — the right-hand side of the `in` that fact filters compile to.
 */
function subqueryValues(sub) {
  if (!Array.isArray(sub) || sub[0] !== 'from') {
    throw new UnsupportedQuery(`expected a "from" subquery, got ${JSON.stringify(sub)}`);
  }
  const [, entity, extract] = sub;
  const rows = ENTITIES[entity];
  if (rows === undefined) {
    throw new UnsupportedQuery(`unknown entity "${entity}" in subquery`);
  }
  if (!Array.isArray(extract) || extract[0] !== 'extract') {
    throw new UnsupportedQuery(`expected an "extract" inside "from ${entity}"`);
  }

  const [, field, condition] = extract;
  // PQL permits `["extract", "certname", …]` and `["extract", ["certname"], …]`.
  const name = Array.isArray(field) ? field[0] : field;

  return new Set(
    rows
      .filter((row) => (condition === undefined ? true : evaluate(condition, row)))
      .map((row) => String(resolveField(row, name))),
  );
}

function evaluate(node, row) {
  if (!Array.isArray(node) || node.length === 0) return true;
  const [op, ...rest] = node;

  switch (op) {
    case 'and':
      return rest.every((clause) => evaluate(clause, row));
    case 'or':
      return rest.some((clause) => evaluate(clause, row));
    case 'not':
      return !evaluate(rest[0], row);
    case 'null?': {
      const [field, expected] = rest;
      const value = resolveField(row, field);
      return (value === null || value === undefined) === expected;
    }
    case 'in':
      return subqueryValues(rest[1]).has(String(resolveField(row, rest[0])));
    case '=':
      return String(resolveField(row, rest[0])) === String(rest[1]);
    case '~': {
      const value = resolveField(row, rest[0]);
      // A regex never matches a fact the node does not report. `?? ''` would
      // make `["~", "facts.whatever", ".*"]` — how EXISTS compiles — true for
      // every node in the estate.
      if (value === null || value === undefined) return false;
      try {
        return new RegExp(rest[1]).test(String(value));
      } catch {
        return false;
      }
    }
    case '<': {
      const value = resolveField(row, rest[0]);
      return value !== null && value !== undefined && String(value) < String(rest[1]);
    }
    case '>': {
      const value = resolveField(row, rest[0]);
      return value !== null && value !== undefined && String(value) > String(rest[1]);
    }
    default:
      throw new UnsupportedQuery(`operator "${op}" is not implemented by the stand-in`);
  }
}

function sortNodes(rows, orderBy) {
  if (!orderBy) return rows;
  let spec;
  try {
    spec = JSON.parse(orderBy)[0];
  } catch {
    return rows;
  }
  if (!spec?.field) return rows;

  const direction = spec.order === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[spec.field] ?? '';
    const y = b[spec.field] ?? '';
    return x < y ? -direction : x > y ? direction : 0;
  });
}

/**
 * A factset per node, in the documented /pdb/query/v4/factsets shape.
 * Built from the same per-node facts the projector consumes, so the Facts tab
 * and rule matching cannot disagree about what a node reports.
 */
const factsets = nodes
  .filter((n) => !n.deactivated && !n.expired)
  .map((n) => ({
    certname: n.certname,
    environment: n.report_environment,
    timestamp: n.facts_timestamp,
    producer_timestamp: n.facts_timestamp,
    producer: 'puppetserver01.example.com',
    hash: `factset-${n.certname}`,
    facts: {
      href: `/pdb/query/v4/factsets/${n.certname}/facts`,
      data: Object.entries(factsByNode.get(n.certname) ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    },
  }));

/**
 * A short run history per node.
 *
 * The NEWEST run reuses the node's advertised latest_report_hash and status, so
 * the inventory's "view report" link resolves and the two views agree. Older
 * runs get synthetic hashes. Events come from the fixture reports, attached to
 * runs whose status warrants them.
 */
const successEvents = successReport.resource_events.data;
const failureEvents = failureReport.resource_events.data;

const reports = [];
const eventsByReport = new Map();

for (const n of nodes) {
  if (n.deactivated || n.expired) continue;

  const base = Date.parse(n.report_timestamp);
  const statuses = [n.latest_report_status, 'unchanged', 'changed', 'unchanged', 'failed'];

  statuses.forEach((status, index) => {
    // Index 0 reuses the hash the node advertises, so the inventory's report
    // link resolves. The rest are independently hashed — sharing a prefix made
    // every run render as the same report, since the UI shows 12 characters.
    const hash = index === 0 ? n.latest_report_hash : sha1(`${n.certname}:run:${index}`);
    const start = new Date(base - index * 1800_000);
    const duration = status === 'failed' ? 47 : 12;

    reports.push({
      hash,
      certname: n.certname,
      environment: n.report_environment,
      status,
      noop: false,
      noop_pending: false,
      puppet_version: '8.10.0',
      report_format: 12,
      configuration_version: String(1753000000 + index),
      transaction_uuid: `txn-${hash}`,
      catalog_uuid: `cat-${hash}`,
      cached_catalog_status: 'not_used',
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + duration * 1000).toISOString(),
      receive_time: new Date(start.getTime() + (duration + 2) * 1000).toISOString(),
      producer_timestamp: new Date(start.getTime() + (duration + 1) * 1000).toISOString(),
      producer: 'puppetserver01.example.com',
      metrics: { href: '', data: failureReport.metrics.data },
      logs: { href: '', data: [] },
    });

    eventsByReport.set(
      hash,
      status === 'failed' ? failureEvents : status === 'changed' ? successEvents : [],
    );
  });
}

const environments = [
  ...new Set(nodes.map((n) => n.report_environment).filter((e) => e !== null)),
].sort();

/**
 * The `inventory` entity, in the documented shape: one row per node with its
 * facts nested under `facts`, queried as `facts.os.name`.
 *
 * Fact filters (#243) compile to `["in", "certname", ["from", "inventory", …]]`
 * rather than a join, so this is the entity that decides which nodes a filter
 * keeps. Only nodes with a factset appear — a deactivated node reports nothing,
 * here and in a real estate.
 */
const inventory = nodes
  .filter((n) => factsByNode.has(n.certname))
  .map((n) => ({
    certname: n.certname,
    timestamp: n.facts_timestamp,
    environment: n.facts_environment ?? n.report_environment,
    facts: factsByNode.get(n.certname),
    trusted: { certname: n.certname, authenticated: 'remote' },
  }));

/** Entities a `["from", …]` subquery may name. */
const ENTITIES = { inventory, nodes, factsets };

function route(req, res) {
  const url = new URL(req.url, 'https://x');
  const q = url.searchParams.get('query');
  const ast = q ? JSON.parse(q) : null;
  const isCount = ast && ast[0] === 'extract';
  const limit = Number(url.searchParams.get('limit') ?? 500);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  res.setHeader('content-type', 'application/json');

  if (url.pathname === '/pdb/meta/v1/version') return res.end(JSON.stringify({ version: '8.4.0' }));
  if (url.pathname.endsWith('/nodes')) {
    // Evaluate the AST for real. Substring-sniffing it meant every filtered
    // query returned the whole estate, so the dashboard reported 48 failed
    // out of 48 nodes and listed unchanged hosts under "Failing nodes".
    const inner = isCount ? ast[2] : ast;
    let visible = inner ? nodes.filter((n) => evaluate(inner, n)) : nodes;
    visible = sortNodes(visible, url.searchParams.get('order_by'));
    return res.end(
      JSON.stringify(isCount ? [{ count: visible.length }] : visible.slice(offset, offset + limit)),
    );
  }
  if (url.pathname.endsWith('/inventory')) {
    const inner = isCount ? ast[2] : ast;
    const visible = inner ? inventory.filter((r) => evaluate(inner, r)) : inventory;
    return res.end(
      JSON.stringify(isCount ? [{ count: visible.length }] : visible.slice(offset, offset + limit)),
    );
  }

  if (url.pathname.endsWith('/facts')) {
    const inner = isCount ? ast[2] : ast;
    const visible = inner ? factRows.filter((r) => evaluate(inner, r)) : factRows;
    return res.end(
      JSON.stringify(isCount ? [{ count: visible.length }] : visible.slice(offset, offset + limit)),
    );
  }

  if (url.pathname.endsWith('/factsets')) {
    const inner = isCount ? ast[2] : ast;
    const visible = inner ? factsets.filter((f) => evaluate(inner, f)) : factsets;
    return res.end(
      JSON.stringify(isCount ? [{ count: visible.length }] : visible.slice(offset, offset + limit)),
    );
  }

  if (url.pathname.endsWith('/reports')) {
    const inner = isCount ? ast[2] : ast;
    let visible = inner ? reports.filter((r) => evaluate(inner, r)) : reports;
    visible = sortNodes(visible, url.searchParams.get('order_by'));
    return res.end(
      JSON.stringify(isCount ? [{ count: visible.length }] : visible.slice(offset, offset + limit)),
    );
  }

  if (url.pathname.endsWith('/events')) {
    // Queried as ["=", "report", <hash>].
    const hash = Array.isArray(ast) && ast[0] === '=' ? ast[2] : null;
    return res.end(JSON.stringify(eventsByReport.get(hash) ?? []));
  }

  if (url.pathname.endsWith('/environments'))
    return res.end(JSON.stringify(environments.map((name) => ({ name }))));

  res.end('[]');
}

const srv = createServer(
  {
    key: readFileSync(`${C}/server.key`),
    cert: readFileSync(`${C}/server.pem`),
    ca: readFileSync(`${C}/ca.pem`),
    requestCert: true,
    rejectUnauthorized: true,
  },
  (req, res) => {
    try {
      route(req, res);
    } catch (error) {
      if (!(error instanceof UnsupportedQuery)) throw error;
      // Real PuppetDB rejects a query it cannot parse. So must this: a query
      // answered with the whole estate is indistinguishable from no filter,
      // which is how an unsupported operator masquerades as a broken feature.
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
    }
  },
);

srv.listen(PORT, '0.0.0.0', () => {
  console.log(
    'pdb stand-in on',
    srv.address().port,
    '|',
    nodes.length,
    'nodes,',
    factRows.length,
    'fact rows',
  );
});
