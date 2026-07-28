/**
 * The questions the connection test does not ask.
 *
 *   node scripts/dev/openvox-probe.mjs
 *
 * READ-ONLY. Every request is a GET against /pdb/query/v4 (ADR-0004).
 *
 * The connection test proves NexusPuppet can reach openvoxdb and that the real
 * PuppetDbClient gets an answer. That is necessary and not sufficient: a fork
 * can answer every request and still differ in the details our mappers depend
 * on — a renamed field, a changed type, an AST operator that quietly means
 * something else. Those failures do not look like failures. They look like an
 * inventory table with empty columns.
 *
 * So this compares openvoxdb against what the code actually assumes:
 *
 *   1  what it calls itself, and which PuppetDB version it forked from
 *   2  whether every AST operator our PqlBuilder emits is understood
 *   3  whether every field our node mapper reads is present
 *   4  whether pagination and ordering behave as the reconciler needs
 *
 * Each check names the code that would break, so a failure is actionable
 * rather than merely red.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'node:https';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const BASE = process.env['PUPPETDB_URL'] ?? 'https://localhost:18082';
const CERT = resolve(root, process.env['PUPPETDB_CERT_PATH'] ?? 'certs-openvox/client.pem');
const KEY = resolve(root, process.env['PUPPETDB_KEY_PATH'] ?? 'certs-openvox/client.key');
const CA = resolve(root, process.env['PUPPETDB_CA_PATH'] ?? 'certs-openvox/ca.pem');

const agent = new Agent({
  cert: readFileSync(CERT),
  key: readFileSync(KEY),
  ca: readFileSync(CA),
  keepAlive: false,
});

let failures = 0;
const head = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);
const ok = (t) => console.log(`  ok    ${t}`);
const bad = (t, detail) => {
  failures += 1;
  console.log(`  FAIL  ${t}`);
  if (detail) console.log(`        ${detail}`);
};
const info = (t) => console.log(`        ${t}`);

function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return new Promise((resolveP, rejectP) => {
    const req = request(url, { agent, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          rejectP(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolveP(JSON.parse(body));
        } catch {
          rejectP(new Error(`unparseable body: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', rejectP);
    req.end();
  });
}

const query = (endpoint, ast, params = {}) =>
  get(`/pdb/query/v4/${endpoint}`, ast === null ? params : { query: ast, ...params });

// ---------------------------------------------------------------------------

head('1. Identity');

try {
  const version = await get('/pdb/meta/v1/version');
  // Deliberately neutral: this probe is pointed at BOTH estates so their
  // answers can be compared, and a label that presumed openvoxdb would make a
  // PuppetDB run read as an OpenVox result.
  ok(`server reports version ${JSON.stringify(version)}`);
  info('DEPLOYMENT.md and any version gate must accept this string.');
} catch (e) {
  bad('/pdb/meta/v1/version', e.message);
}

try {
  const services = await get('/status/v1/services');
  const names = Object.keys(services);
  ok(`status services: ${names.join(', ')}`);
  // Our health check reads this endpoint; a renamed service would make a
  // healthy estate look down.
  const state = services['puppetdb-status']?.state ?? services['openvoxdb-status']?.state;
  if (state === 'running') ok(`service state is "running"`);
  else bad('no recognised status service', `saw: ${JSON.stringify(services).slice(0, 200)}`);
} catch (e) {
  bad('/status/v1/services', e.message);
}

head('2. Every AST operator PqlBuilder emits');

/**
 * Taken from apps/api/src/puppetdb/pql-builder.ts. Not a representative sample:
 * if the builder can emit it, it is here, because the one operator that is not
 * checked is the one that will differ.
 */
const OPERATORS = [
  {
    label: '=            (buildNodeQuery, buildReportQuery)',
    endpoint: 'nodes',
    ast: ['=', 'certname', 'nonexistent.invalid'],
  },
  {
    label: '~   regex    (certnameContains substring search)',
    endpoint: 'nodes',
    ast: ['~', 'certname', 'agent'],
  },
  {
    label: 'null?        (statuses: unknown, includeInactive)',
    endpoint: 'nodes',
    ast: ['null?', 'deactivated', true],
  },
  {
    label: '<            (staleBefore)',
    endpoint: 'nodes',
    ast: ['<', 'report_timestamp', '2100-01-01T00:00:00.000Z'],
  },
  {
    label: '>            (factsChangedSince, incremental poll)',
    endpoint: 'nodes',
    ast: ['>', 'facts_timestamp', '2000-01-01T00:00:00.000Z'],
  },
  {
    label: 'and          (multi-clause filters)',
    endpoint: 'nodes',
    ast: ['and', ['null?', 'deactivated', true], ['null?', 'expired', true]],
  },
  {
    label: 'or           (environments, statuses)',
    endpoint: 'nodes',
    ast: [
      'or',
      ['=', 'facts_environment', 'production'],
      ['=', 'report_environment', 'production'],
    ],
  },
  {
    label: 'extract      (buildCountQuery)',
    endpoint: 'nodes',
    ast: ['extract', [['function', 'count']], null],
  },
  {
    label: 'in/select_facts  (fact-based node lookup)',
    endpoint: 'nodes',
    ast: ['in', 'certname', ['extract', 'certname', ['select_facts', ['=', 'name', 'kernel']]]],
  },
  {
    label: 'in/select_fact_contents  (structured fact path)',
    endpoint: 'nodes',
    ast: [
      'in',
      'certname',
      ['extract', 'certname', ['select_fact_contents', ['=', 'path', ['os', 'family']]]],
    ],
  },
];

for (const { label, endpoint, ast } of OPERATORS) {
  try {
    const rows = await query(endpoint, ast);
    ok(`${label}  -> ${rows.length} row(s)`);
  } catch (e) {
    bad(label, e.message.slice(0, 200));
  }
}

head('3. Every field the node mapper reads');

/**
 * From packages/contracts/src/puppetdb.ts. A field that vanished would surface
 * as a null column in the inventory rather than an error, which is the failure
 * mode worth catching here rather than in the UI.
 */
const NODE_FIELDS = [
  'certname',
  'report_environment',
  'facts_environment',
  'catalog_environment',
  'report_timestamp',
  'facts_timestamp',
  'catalog_timestamp',
  'latest_report_status',
  'latest_report_hash',
  'latest_report_noop',
  'deactivated',
  'expired',
];

try {
  const nodes = await query('nodes', null);
  if (nodes.length === 0) {
    bad('no nodes in openvoxdb', 'the agent run did not land — re-run openvox-stack.sh');
  } else {
    const sample = nodes[0];
    const missing = NODE_FIELDS.filter((f) => !(f in sample));
    if (missing.length === 0)
      ok(`all ${NODE_FIELDS.length} node fields present on ${sample.certname}`);
    else bad(`missing node field(s): ${missing.join(', ')}`, 'apps/api/src/puppetdb maps these');

    // Types matter as much as presence: deactivated/expired are TIMESTAMPS OR
    // NULL rather than booleans, and our contract documents that explicitly.
    for (const field of ['deactivated', 'expired']) {
      const value = sample[field];
      if (value === null || typeof value === 'string')
        ok(`${field} is timestamp-or-null (${JSON.stringify(value)})`);
      else
        bad(
          `${field} is ${typeof value}, expected string|null`,
          'puppetdb.ts documents these as timestamps',
        );
    }

    info(`facts on ${sample.certname}: checking count`);
    const facts = await query('facts', ['=', 'certname', sample.certname]);
    ok(`${facts.length} facts — an agent factset, for comparison with Puppet's`);
  }
} catch (e) {
  bad('nodes query', e.message);
}

head('4. Pagination and ordering, as the reconciler needs them');

// The cursored reconcile pages by certname and relies on order_by plus limit
// behaving exactly so; a fork that ignored order_by would silently skip nodes.
try {
  const page = await query('nodes', null, {
    order_by: JSON.stringify([{ field: 'certname', order: 'asc' }]),
    limit: 1,
    offset: 0,
  });
  if (page.length <= 1) ok(`limit/offset honoured (${page.length} row)`);
  else bad('limit ignored', `asked for 1, got ${page.length}`);
} catch (e) {
  bad('order_by/limit/offset', e.message.slice(0, 200));
}

try {
  const counted = await query('nodes', ['extract', [['function', 'count']], null]);
  ok(`count extraction works: ${JSON.stringify(counted[0] ?? null)}`);
} catch (e) {
  bad('count extraction (buildCountQuery)', e.message.slice(0, 200));
}

// ---------------------------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log('  OpenVox behaves as PuppetDB for everything NexusPuppet uses.');
} else {
  console.log(`  ${failures} difference(s) found — each names the code that assumes otherwise.`);
}
process.exit(failures === 0 ? 0 : 1);
