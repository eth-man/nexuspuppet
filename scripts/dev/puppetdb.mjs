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
  if (existsSync(join(C, 'client.pem'))) return;

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

  const facts = {
    ...base,
    role,
    is_virtual: virtual,
    virtual: virtual ? 'kvm' : 'physical',
    os: {
      ...base.os,
      family: os.family,
      name: os.name,
      release: { ...base.os.release, major: os.major },
    },
    networking: { ...base.networking, fqdn: n.certname, hostname: n.certname.split('.')[0] },
  };

  for (const [name, value] of Object.entries(facts)) {
    factRows.push({ certname: n.certname, name, value });
  }
}

/**
 * Minimal PuppetDB AST evaluator, covering the operators PqlBuilder emits.
 * Enough for the stand-in to behave like a real server for filtering and
 * sorting — anything less makes the console show numbers that are simply wrong.
 */
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
      return (row[field] === null || row[field] === undefined) === expected;
    }
    case '=':
      return String(row[rest[0]]) === String(rest[1]);
    case '~':
      try {
        return new RegExp(rest[1]).test(String(row[rest[0]] ?? ''));
      } catch {
        return false;
      }
    case '<':
      return row[rest[0]] !== null && String(row[rest[0]]) < String(rest[1]);
    case '>':
      return row[rest[0]] !== null && String(row[rest[0]]) > String(rest[1]);
    default:
      return true;
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

const srv = createServer(
  {
    key: readFileSync(`${C}/server.key`),
    cert: readFileSync(`${C}/server.pem`),
    ca: readFileSync(`${C}/ca.pem`),
    requestCert: true,
    rejectUnauthorized: true,
  },
  (req, res) => {
    const url = new URL(req.url, 'https://x');
    const q = url.searchParams.get('query');
    const ast = q ? JSON.parse(q) : null;
    const isCount = ast && ast[0] === 'extract';
    const limit = Number(url.searchParams.get('limit') ?? 500);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    res.setHeader('content-type', 'application/json');

    if (url.pathname === '/pdb/meta/v1/version')
      return res.end(JSON.stringify({ version: '8.4.0' }));
    if (url.pathname.endsWith('/nodes')) {
      // Evaluate the AST for real. Substring-sniffing it meant every filtered
      // query returned the whole estate, so the dashboard reported 48 failed
      // out of 48 nodes and listed unchanged hosts under "Failing nodes".
      const inner = isCount ? ast[2] : ast;
      let visible = inner ? nodes.filter((n) => evaluate(inner, n)) : nodes;
      visible = sortNodes(visible, url.searchParams.get('order_by'));
      return res.end(
        JSON.stringify(
          isCount ? [{ count: visible.length }] : visible.slice(offset, offset + limit),
        ),
      );
    }
    if (url.pathname.endsWith('/facts'))
      return res.end(
        JSON.stringify(
          isCount ? [{ count: factRows.length }] : factRows.slice(offset, offset + limit),
        ),
      );
    res.end('[]');
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
