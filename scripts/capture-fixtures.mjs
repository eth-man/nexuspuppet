#!/usr/bin/env node
/**
 * Capture PuppetDB fixtures from a REAL estate.
 *
 *   PUPPETDB_URL=https://localhost:18081 node scripts/capture-fixtures.mjs
 *
 * READ-ONLY. Every request is a GET against /pdb/query/v4 (ADR-0004).
 *
 * WHY THIS REPLACED THE GENERATOR
 * -------------------------------
 * These fixtures used to be synthesised from the PuppetDB 8 API documentation.
 * They encoded our reading of the docs, and the test suite then encoded them —
 * so a wrong assumption was self-confirming. It cost us a real bug: the
 * synthetic factset invented `role`, `fqdn` and `domain`, those names reached
 * the default PUPPETDB_PROJECTED_FACTS, and a classification rule written
 * against `role` silently matched nothing on every real estate. Nothing failed,
 * because the fixture agreed with the code.
 *
 * The synthetic factset had 23 facts. A real node reports 114, and did not have
 * three of the 23. The real node row also carries two fields the synthetic one
 * never did — `cached_catalog_status` and `latest_report_corrective_change` —
 * so the mapper had never once seen them.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * ----------------------------
 * Being precise about this matters more than the fixtures themselves, because
 * the failure above came from believing invented data was observed.
 *
 *   factsets   100% captured. Only hardware identifiers are masked.
 *   reports    100% captured, both a real `changed` run and a real `failed` one.
 *   nodes      Field names, types and value formats are captured from a real
 *              node row. The ESTATE is synthesised: one node cannot exhibit the
 *              deactivated, expired and stale states an inventory has to render,
 *              and the tests need an estate with variety. Every field is copied
 *              from the observed row; only which node is in which state is ours.
 *
 * A re-capture is a new SNAPSHOT and will differ — timestamps move, facts
 * change. That is correct for a capture and is the opposite of the old
 * generator's byte-identical guarantee, which is what made it feel trustworthy
 * while being wrong.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'node:https';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'fixtures');

const BASE = process.env['PUPPETDB_URL'] ?? 'https://localhost:18081';
const CERT = resolve(root, process.env['PUPPETDB_CERT_PATH'] ?? 'certs/client.pem');
const KEY = resolve(root, process.env['PUPPETDB_KEY_PATH'] ?? 'certs/client.key');
const CA = resolve(root, process.env['PUPPETDB_CA_PATH'] ?? 'certs/ca.pem');

const agent = new Agent({
  cert: readFileSync(CERT),
  key: readFileSync(KEY),
  ca: readFileSync(CA),
  keepAlive: false,
});

function query(endpoint, ast) {
  const url = new URL(`${BASE}/pdb/query/v4/${endpoint}`);
  if (ast !== undefined) url.searchParams.set('query', JSON.stringify(ast));
  return new Promise((res, rej) => {
    const req = request(url, { agent, method: 'GET' }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => (body += c));
      r.on('end', () => {
        if (r.statusCode !== 200)
          return rej(new Error(`HTTP ${r.statusCode}: ${body.slice(0, 300)}`));
        try {
          res(JSON.parse(body));
        } catch {
          rej(new Error(`unparseable: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', rej);
    req.end();
  });
}

const write = (name, data) => {
  writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`  wrote fixtures/${name}`);
};

/**
 * Hardware identifiers, masked.
 *
 * These fixtures live in a PUBLIC repository. The values are not secret in any
 * meaningful sense — this is a throwaway container — but a serial number and a
 * MAC address are the kind of thing that should never be committed by habit,
 * and a fixture is exactly where that habit gets established. Masked to a value
 * of the SAME shape, so the schema and mapper still see what they would see.
 */
const MASKS = {
  uuid: 'ec2f4a1c-0000-4000-8000-000000000000',
  serialnumber: '0000000000',
  boardserialnumber: '0000000000',
  macaddress: '02:00:00:00:00:01',
  macaddress_eth0: '02:00:00:00:00:01',
};

function maskFacts(data) {
  let masked = 0;
  const out = data.map((f) => {
    if (Object.prototype.hasOwnProperty.call(MASKS, f.name)) {
      masked += 1;
      return { ...f, value: MASKS[f.name] };
    }
    return f;
  });
  console.log(`  masked ${masked} hardware identifier(s)`);
  return out;
}

// ---------------------------------------------------------------------------

console.log(`Capturing from ${BASE}`);

const realNodes = await query('nodes');
if (realNodes.length === 0)
  throw new Error('no nodes in PuppetDB — run scripts/dev/puppet-stack.sh');

const template = realNodes[0];
const certname = template.certname;
console.log(`  template node: ${certname} (${Object.keys(template).length} fields)`);

// --- factsets: entirely real ------------------------------------------------

const factsets = await query('factsets', ['=', 'certname', certname]);
if (factsets.length === 0) throw new Error(`no factset for ${certname}`);
factsets[0].facts.data = maskFacts(factsets[0].facts.data);
console.log(`  ${factsets[0].facts.data.length} facts captured`);
write('factset-single-node.sample.json', factsets);

// --- reports: entirely real -------------------------------------------------

const reports = await query('reports');
const success = reports.filter((r) => r.status !== 'failed');
const failed = reports.filter((r) => r.status === 'failed');
if (success.length === 0) throw new Error('no non-failed report captured');
if (failed.length === 0) {
  throw new Error(
    'no FAILED report in PuppetDB. A failed run is a distinct code path in the ' +
      'report mapper and must not be synthesised. Break a manifest, run the ' +
      'agent once, and re-capture.',
  );
}

/**
 * Captured verbatim. PuppetDB already returns `resource_events`, `metrics` and
 * `logs` inline on the reports endpoint, and an earlier version of this script
 * re-queried events and overwrote them — which silently emptied the failed
 * report, because that failure was a CATALOG COMPILATION failure with no
 * resources to have events about.
 *
 * The failed report must contain resource-level failures: the event mapper's
 * failure path, the containment path and the triage message are what the detail
 * view renders, and a compile failure exercises none of them.
 */
const pickFailed = failed.find((r) => (r.resource_events?.data?.length ?? 0) > 0);
if (!pickFailed) {
  throw new Error(
    `captured ${failed.length} failed report(s) but none has resource events — ` +
      'those are compilation failures. Make a RESOURCE fail (an exec that ' +
      'returns non-zero), run the agent once, and re-capture.',
  );
}
const pickSuccess = success.find((r) => (r.resource_events?.data?.length ?? 0) > 0) ?? success[0];

write('report-success.sample.json', [pickSuccess]);
write('report-failure.sample.json', [pickFailed]);
console.log(
  `  success: ${pickSuccess.resource_events?.data?.length ?? 0} event(s), ` +
    `failure: ${pickFailed.resource_events?.data?.length ?? 0} event(s)`,
);

// --- nodes: real shape, synthesised estate ----------------------------------

/**
 * Deterministic given the captured template, so a re-run against an unchanged
 * estate produces an unchanged file and a diff means the estate moved.
 */
let seed = parseInt(createHash('sha1').update(certname).digest('hex').slice(0, 8), 16);
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo));

const baseMs = Date.parse(template.facts_timestamp ?? template.report_timestamp);
if (Number.isNaN(baseMs)) throw new Error('template node has no usable timestamp');
const iso = (offsetSeconds) => new Date(baseMs + offsetSeconds * 1000).toISOString();

const DOMAIN = certname.split('.').slice(1).join('.') || 'nexuspuppet.test';
const ROLES = ['web', 'db', 'app', 'cache', 'lb', 'mq', 'worker', 'monitor'];
const ENVIRONMENTS = ['production', 'staging', 'development'];
const REPORT_STATUS = ['changed', 'unchanged', 'unchanged', 'unchanged', 'failed'];

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

const nodes = [];
for (let i = 1; i <= 50; i += 1) {
  const role = ROLES[i % ROLES.length];
  const name = `${role}${String(i).padStart(2, '0')}.${DOMAIN}`;
  const environment = pick(ENVIRONMENTS);
  const status = pick(REPORT_STATUS);

  // The states an inventory must render distinctly rather than silently omit.
  // One real node cannot be in all of them at once.
  const isDeactivated = i === 47;
  const isExpired = i === 48;
  const isStale = i === 49 || i === 50;
  const age = isStale ? -int(200000, 900000) : -int(60, 1800);

  // Built by SPREADING the real row, so any field PuppetDB returns that we do
  // not know about is carried through rather than dropped. That is precisely
  // how cached_catalog_status and latest_report_corrective_change were missing
  // from the synthetic fixtures for the entire life of the project.
  nodes.push({
    ...template,
    certname: name,
    deactivated: isDeactivated ? iso(-86400 * 3) : null,
    expired: isExpired ? iso(-86400 * 8) : null,
    catalog_timestamp: isDeactivated ? null : iso(age + 2),
    facts_timestamp: isDeactivated ? null : iso(age),
    report_timestamp: isDeactivated ? null : iso(age + 5),
    catalog_environment: isDeactivated ? null : environment,
    facts_environment: isDeactivated ? null : environment,
    report_environment: isDeactivated ? null : environment,
    latest_report_status: isDeactivated ? null : status,
    latest_report_noop: environment === 'development',
    latest_report_noop_pending: environment === 'development' && status === 'changed',
    latest_report_hash: isDeactivated ? null : sha1(`${name}:report`),
  });
}

// The first node keeps the captured row verbatim, so at least one entry in the
// file is an unmodified observation rather than a derivative of one.
nodes.unshift({ ...template });
nodes.length = 50;

write('nodes-query.sample.json', nodes);
console.log(`\n  ${nodes.length} node rows, ${Object.keys(nodes[0]).length} fields each`);
console.log('  fixtures/README.md records what is captured and what is synthesised.');
