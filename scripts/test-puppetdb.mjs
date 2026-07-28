#!/usr/bin/env node
/**
 * Prove the live PuppetDB connection, one layer at a time.
 *
 *   node scripts/test-puppetdb.mjs
 *
 * READ-ONLY. Every request is a GET against /pdb/query/v4 or /status/v1.
 * PuppetDB's write surface is /pdb/cmd, which this script never touches and the
 * application has no code to reach at all (ADR-0004).
 *
 * Staged deliberately. "It doesn't work" has at least five distinct causes —
 * unreadable key, untrusted CA, unauthorised certname, wrong URL, firewall —
 * and they need different people to fix. Each stage isolates one, so the output
 * names the layer that failed instead of leaving you to bisect it.
 *
 *   1  files        present, readable, sane permissions, matching key pair
 *   2  TCP          something is listening
 *   3  TLS          the CA verifies the server, the server accepts our cert
 *   4  authorised   auth.conf lets this certname query
 *   5  data         a real query returns plausible data
 *   6  our client   the code the application actually runs
 *
 * Exits non-zero on the first failed stage.
 */
import { readFileSync, statSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { createConnection } from 'node:net';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { request } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read .env without importing it, so this works with no shell setup. */
function env(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  try {
    for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match?.[1] === key) return match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env is fine when the variables are exported */
  }
  return fallback;
}

const URL_ = env('PUPPETDB_URL');
const CERT = resolve(root, env('PUPPETDB_CERT_PATH', 'certs/client.pem'));
const KEY = resolve(root, env('PUPPETDB_KEY_PATH', 'certs/client.key'));
const CA = resolve(root, env('PUPPETDB_CA_PATH', 'certs/ca.pem'));
const TIMEOUT = Number(env('PUPPETDB_TIMEOUT_MS', '10000'));

let stage = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`    ${m}`);
const head = (m) => console.log(`\n[${++stage}] ${m}`);

function fail(what, why, fix) {
  console.error(`\n  ✗ ${what}`);
  console.error(`    ${why}`);
  if (fix) console.error(`\n    Try: ${fix}`);
  process.exit(1);
}

// --- 1. the files ----------------------------------------------------------

head('Certificate files');

if (URL_ === undefined || URL_ === '') {
  fail(
    'PUPPETDB_URL is not set',
    'Set it in .env or export it.',
    'PUPPETDB_URL=https://puppetdb.internal:8081',
  );
}

const files = { CA: CA, 'client certificate': CERT, 'private key': KEY };
for (const [label, path] of Object.entries(files)) {
  try {
    statSync(path);
  } catch {
    fail(`${label} not found`, `Expected it at ${path}`, 'See certs/README.md');
  }
}
pass('all three files present');

// A world-readable private key is a finding in its own right, and it is the
// kind of thing that gets copied into an image and shipped.
const keyMode = statSync(KEY).mode & 0o077;
if (keyMode !== 0) {
  fail(
    'private key is readable by others',
    `${KEY} is mode ${(statSync(KEY).mode & 0o777).toString(8)}.`,
    `chmod 0600 ${KEY}`,
  );
}
pass('private key is not group- or world-readable');

let certificate;
try {
  certificate = new X509Certificate(readFileSync(CERT));
} catch (error) {
  fail('client certificate is not valid PEM', error.message, `head -1 ${CERT}`);
}

// A key that does not match the certificate produces a TLS handshake error
// several layers down, where the message says nothing about the mismatch.
try {
  const priv = createPrivateKey(readFileSync(KEY));
  const fromKey = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const fromCert = certificate.publicKey.export({ type: 'spki', format: 'der' });
  if (!fromKey.equals(fromCert)) {
    fail(
      'the private key does not match the certificate',
      'These two files are from different key pairs.',
      'Re-copy both from the same certname on the Puppet CA.',
    );
  }
} catch (error) {
  if (error.message?.includes('different key pairs')) throw error;
  fail('private key could not be read', error.message, `chmod 0600 ${KEY}`);
}
pass('private key matches the certificate');

const notAfter = new Date(certificate.validTo);
const notBefore = new Date(certificate.validFrom);
const now = new Date();
if (now > notAfter) {
  fail(
    'client certificate has expired',
    `It expired ${certificate.validTo}.`,
    'puppetserver ca clean --certname <name> && puppetserver ca generate --certname <name>',
  );
}
if (now < notBefore) {
  fail(
    'client certificate is not valid yet',
    `It becomes valid ${certificate.validFrom}.`,
    'Check the clock on this machine and on the CA.',
  );
}
const daysLeft = Math.floor((notAfter - now) / 86_400_000);
pass(`certificate valid for ${daysLeft} more day(s)`);
info(`subject ${certificate.subject.replace(/\n/g, ' ')}`);
if (daysLeft < 30) {
  console.log(`    ! expires in ${daysLeft} days — renew before it does`);
}

// --- 2. reachability -------------------------------------------------------

head('Network');

const target = new URL(URL_);
const port = Number(target.port || 8081);

await new Promise((done) => {
  const socket = createConnection({ host: target.hostname, port, timeout: TIMEOUT });
  socket.on('connect', () => {
    pass(`${target.hostname}:${port} accepts connections`);
    socket.end();
    done();
  });
  socket.on('timeout', () =>
    fail(
      'connection timed out',
      `No answer from ${target.hostname}:${port} in ${TIMEOUT}ms.`,
      'Check a firewall between this host and PuppetDB.',
    ),
  );
  socket.on('error', (error) =>
    fail(
      'cannot reach PuppetDB',
      `${error.code ?? error.message} connecting to ${target.hostname}:${port}.`,
      'Confirm PUPPETDB_URL and that puppetdb is running.',
    ),
  );
});

// --- 3. TLS ----------------------------------------------------------------

head('TLS handshake');

await new Promise((done) => {
  const socket = tlsConnect(
    {
      host: target.hostname,
      port,
      cert: readFileSync(CERT),
      key: readFileSync(KEY),
      ca: readFileSync(CA),
      // Verification stays ON. Turning it off here would make the script pass
      // while the application — which does verify — still fails.
      rejectUnauthorized: true,
      servername: target.hostname,
      timeout: TIMEOUT,
    },
    () => {
      if (!socket.authorized) {
        fail(
          'server certificate not trusted',
          socket.authorizationError,
          `Confirm ${CA} is the CA that signed PuppetDB's certificate.`,
        );
      }
      const peer = socket.getPeerCertificate();
      pass('server certificate verified against the CA');
      info(`server subject ${peer.subject?.CN ?? '(unknown)'}`);
      info(`protocol ${socket.getProtocol()}`);
      socket.end();
      done();
    },
  );
  socket.on('error', (error) => {
    const hint = /unknown ca|self.signed/i.test(error.message)
      ? `The server does not trust our certificate, or ${CA} is not its CA.`
      : /handshake|alert/i.test(error.message)
        ? 'The server rejected the handshake — often an unauthorised or wrong-CA client certificate.'
        : error.message;
    fail('TLS handshake failed', hint, 'Verify the certname was issued by THIS Puppet CA.');
  });
});

// --- 4 & 5. HTTP -----------------------------------------------------------

function get(path) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: target.hostname,
        port,
        path,
        method: 'GET', // never anything else: /pdb/cmd is the write surface
        cert: readFileSync(CERT),
        key: readFileSync(KEY),
        ca: readFileSync(CA),
        rejectUnauthorized: true,
        timeout: TIMEOUT,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${TIMEOUT}ms`)));
    req.on('error', reject);
    req.end();
  });
}

head('Authorisation');

const status = await get('/status/v1/services');
if (status.status === 403) {
  fail(
    'PuppetDB refused this certificate',
    `HTTP 403. The TLS handshake succeeded, so the certificate is valid — it is simply not authorised.`,
    'Grant query access for this certname in /etc/puppetlabs/puppetdb/conf.d/auth.conf, then reload puppetdb.',
  );
}
// 404 is not a failure: auth.conf can expose /pdb/query while restricting
// /status, and blocking there would stop a deployment that actually works.
// Stage 5 proves query authorisation on its own.
if (status.status === 404) {
  info('/status/v1/services is not exposed — authorisation will be proven by the query below');
} else if (status.status !== 200) {
  fail(
    'unexpected status endpoint response',
    `HTTP ${status.status}: ${status.body.slice(0, 200)}`,
  );
} else {
  pass('certname is authorised to query');
}

try {
  const services = JSON.parse(status.body);
  const version = services['puppetdb-status']?.service_version;
  const state = services['puppetdb-status']?.state;
  if (version) info(`PuppetDB ${version}, state: ${state}`);
} catch {
  info('(status body was not JSON — continuing)');
}

head('A real query');

// Deliberately tiny. This is someone's production database.
const nodes = await get('/pdb/query/v4/nodes?limit=1');
if (nodes.status === 403) {
  fail(
    'PuppetDB refused the query',
    'HTTP 403. The certificate is valid and trusted; this certname is not permitted to query.',
    'Grant it query access in /etc/puppetlabs/puppetdb/conf.d/auth.conf, then reload puppetdb.',
  );
}
if (nodes.status !== 200) {
  fail('query endpoint refused', `HTTP ${nodes.status}: ${nodes.body.slice(0, 200)}`);
}

let rows;
try {
  rows = JSON.parse(nodes.body);
} catch {
  fail('query returned something that is not JSON', nodes.body.slice(0, 200));
}
if (!Array.isArray(rows)) {
  fail('query did not return a list', JSON.stringify(rows).slice(0, 200));
}

pass(`query succeeded, ${rows.length} row(s) returned`);
if (rows.length === 0) {
  console.log('    ! PuppetDB answered but has no nodes. Correct for a fresh install;');
  console.log('      suspicious for an estate that should have some.');
} else {
  const node = rows[0];
  info(`certname        ${node.certname}`);
  info(`report_timestamp ${node.report_timestamp ?? '(never reported)'}`);
  info(`latest_report_status ${node.latest_report_status ?? '(none)'}`);
}

const count = await get(
  '/pdb/query/v4/nodes?query=%5B%22extract%22%2C%5B%5B%22function%22%2C%22count%22%5D%5D%5D',
);
if (count.status === 200) {
  try {
    const parsed = JSON.parse(count.body);
    if (parsed[0]?.count !== undefined) info(`estate size     ${parsed[0].count} nodes`);
  } catch {
    /* the count is a nicety, not a gate */
  }
}

// --- 6. the application's own client ---------------------------------------

head("The application's client");

const clientPath = resolve(root, 'apps/api/dist/puppetdb/puppetdb.client.js');
let PuppetDbClient;
try {
  ({ PuppetDbClient } = await import(clientPath));
} catch {
  console.log('    - skipped: apps/api is not built. Run `npm run build` to include this stage.');
  console.log('\nEverything up to here passed. The certificates and authorisation are good.\n');
  process.exit(0);
}

// The stages above prove the CERTIFICATES work. This proves OUR CODE works with
// them, which is not the same claim: a bespoke request can succeed while the
// client's own agent construction, timeouts or query building fail.
try {
  const client = new PuppetDbClient({
    baseUrl: URL_,
    certPath: CERT,
    keyPath: KEY,
    caPath: CA,
    timeoutMs: TIMEOUT,
  });

  const page = await client.listNodes({}, { limit: 1, offset: 0 });
  pass('PuppetDbClient connected and returned a page');
  info(`total nodes ${page.total ?? '(not reported)'}`);

  if (rows.length > 0) {
    const facts = await client.getFacts(rows[0].certname);
    const names = Object.keys(facts);
    pass(`fact retrieval works — ${names.length} fact(s) for ${rows[0].certname}`);

    // The projection only stores facts named in PUPPETDB_PROJECTED_FACTS, and a
    // rule on an unprojected fact can never match. Worth seeing now rather than
    // after writing a rule that silently matches nothing.
    const projected = (env('PUPPETDB_PROJECTED_FACTS', '') || '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const missing = projected.filter((f) => !names.includes(f.split('.')[0]));
    if (missing.length > 0) {
      console.log(
        `    ! PUPPETDB_PROJECTED_FACTS names facts this node does not have: ${missing.join(', ')}`,
      );
      console.log('      A classification rule on one of those can never match.');
    }
    const custom = names.filter(
      (n) =>
        ![
          'os',
          'networking',
          'processors',
          'memory',
          'virtual',
          'is_virtual',
          'fqdn',
          'domain',
          'kernel',
          'path',
          'uptime',
          'identity',
          'ruby',
          'facterversion',
          'aio_agent_version',
          'clientcert',
          'clientversion',
          'system_uptime',
          'timezone',
          'hostname',
        ].includes(n),
    );
    if (custom.length > 0) {
      info(
        `custom facts available: ${custom.slice(0, 12).join(', ')}${custom.length > 12 ? ` (+${custom.length - 12} more)` : ''}`,
      );
      info('add the ones you classify on to PUPPETDB_PROJECTED_FACTS');
    }
  }
} catch (error) {
  fail(
    "the application's client failed where a raw request succeeded",
    error.message,
    'This is a bug in NexusPuppet rather than a certificate problem — report the message above.',
  );
}

console.log('\nAll stages passed. PuppetDB is reachable, authorised, and readable.\n');
