#!/usr/bin/env node
/**
 * What can this PuppetDB certificate actually do?
 *
 * DEPLOYMENT.md §3 makes a claim that operators are entitled to distrust: that
 * the certificate NexusPuppet uses cannot be restricted to reads, because
 * PuppetDB has no per-certname authorization for `/pdb/*`. This script is how
 * you check that against your own estate rather than believing our table.
 *
 *   PUPPETDB_URL=https://puppetdb.internal:8081 \
 *   PUPPETDB_CERT_PATH=... PUPPETDB_KEY_PATH=... PUPPETDB_CA_PATH=... \
 *   node scripts/dev/puppetdb-auth-probe.mjs
 *
 * Read-only by default. The write probe is the one that actually settles the
 * question, and it is opt-in behind --prove-write because it PERSISTS: it
 * submits a `replace_facts` command and the fabricated node it invents stays in
 * your PuppetDB until you deactivate it. Run that against a disposable estate,
 * or accept that you are creating a node.
 *
 * Only ever point this at infrastructure you are responsible for.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const url = process.env.PUPPETDB_URL;
const proveWrite = process.argv.includes('--prove-write');

if (url === undefined || url === '') {
  console.error('PUPPETDB_URL is required.');
  process.exit(2);
}

const base = new URL(url);
const tls = {
  cert: read('PUPPETDB_CERT_PATH'),
  key: read('PUPPETDB_KEY_PATH'),
  ca: read('PUPPETDB_CA_PATH'),
};

function read(name) {
  const path = process.env[name];
  if (path === undefined || path === '') return undefined;
  return readFileSync(path);
}

/** Resolves to a status code, or null when TLS itself refused us. */
function probe(path, { withCert, method = 'GET', body }) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method,
        // The CA is always needed to verify the server; the CLIENT cert is what
        // we are varying, because "no client certificate" is a distinct and
        // important case when jetty is configured with client-auth = want.
        ca: tls.ca,
        ...(withCert ? { cert: tls.cert, key: tls.key } : {}),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('error', () => resolve(null));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const show = (label, code) =>
  console.log(`  ${label.padEnd(46)} ${code === null ? 'refused at TLS' : `HTTP ${code}`}`);

console.log(`\nProbing ${base.origin}\n`);

const noCert = await probe('/pdb/query/v4/nodes?limit=1', { withCert: false });
show('GET /pdb/query, NO client certificate', noCert);

const withCert = await probe('/pdb/query/v4/nodes?limit=1', { withCert: true });
show('GET /pdb/query, with our certificate', withCert);

let wrote = null;
if (proveWrite) {
  const certname = `nexuspuppet-auth-probe-${Date.now()}.invalid`;
  const payload = JSON.stringify({
    certname,
    environment: 'production',
    producer_timestamp: new Date().toISOString(),
    producer: 'nexuspuppet-auth-probe',
    values: { nexuspuppet_auth_probe: 'reached' },
  });
  wrote = await probe(
    `/pdb/cmd/v1?certname=${encodeURIComponent(certname)}&version=5&command=replace_facts`,
    { withCert: true, method: 'POST', body: payload },
  );
  show('POST /pdb/cmd replace_facts', wrote);
  if (wrote !== null && wrote < 300) {
    console.log(`\n  It was accepted. ${certname} now exists in your PuppetDB.`);
    console.log('  Remove it with: puppet node deactivate ' + certname);
  }
}

console.log('');
if (noCert !== null && noCert < 300) {
  console.log('SEVERE: PuppetDB answered a query from a client with NO certificate.');
  console.log('        Set client-auth = need in jetty.ini. See DEPLOYMENT.md §3.\n');
}
if (wrote !== null && wrote < 300) {
  console.log('This certificate can WRITE to PuppetDB. It is not a read-only');
  console.log('credential and cannot be made into one — bound it at the network');
  console.log('layer. See DEPLOYMENT.md §3.\n');
} else if (!proveWrite) {
  console.log('Write access not tested. Re-run with --prove-write to settle it');
  console.log('(this creates a node — read the header first).\n');
}
