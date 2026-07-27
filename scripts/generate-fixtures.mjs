#!/usr/bin/env node
/**
 * Generate synthetic PuppetDB fixtures in the exact shapes documented for the
 * PuppetDB 8 query API v4.
 *
 *   node scripts/generate-fixtures.mjs
 *
 * These are SYNTHETIC. They encode our reading of the documentation, not an
 * observed estate. They are good enough to build and test the client against,
 * and they are NOT proof that the client works against real infrastructure —
 * see fixtures/README.md.
 *
 * Deterministic by construction: a seeded PRNG and a fixed base instant, no
 * Date.now() and no Math.random(). Regenerating must produce byte-identical
 * files, otherwise every run would show up as a diff.
 *
 * Field names and nesting follow:
 *   /pdb/query/v4/nodes      certname, deactivated, expired, *_timestamp,
 *                            catalog_environment, facts_environment,
 *                            report_environment, latest_report_status,
 *                            latest_report_noop, latest_report_noop_pending,
 *                            latest_report_hash, latest_report_job_id
 *   /pdb/query/v4/factsets   certname, environment, timestamp,
 *                            producer_timestamp, producer, hash,
 *                            facts: { href, data: [{ name, value }] }
 *   /pdb/query/v4/reports    hash, puppet_version, receive_time, report_format,
 *                            start_time, end_time, producer_timestamp,
 *                            producer, transaction_uuid, status, noop,
 *                            noop_pending, environment, configuration_version,
 *                            certname, code_id, catalog_uuid,
 *                            cached_catalog_status,
 *                            resource_events: { href, data: [...] },
 *                            metrics: { href, data: [...] },
 *                            logs: { href, data: [...] }
 *
 * NOTE: reports carry no `duration` field. Duration is derived from
 * start_time/end_time by the client.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** Mulberry32 — small, fast, reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20260727);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/** Fixed base instant so output never depends on when this runs. */
const BASE = Date.parse('2026-07-27T09:00:00.000Z');
const iso = (offsetSeconds) => new Date(BASE + offsetSeconds * 1000).toISOString();
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const uuid = (s) => {
  const h = createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const DOMAIN = 'example.com';
const ENVIRONMENTS = ['production', 'production', 'production', 'staging', 'development'];
const OS = [
  { name: 'RedHat', family: 'RedHat', major: '9', full: '9.4', codename: null, arch: 'x86_64' },
  { name: 'CentOS', family: 'RedHat', major: '8', full: '8.10', codename: null, arch: 'x86_64' },
  {
    name: 'Ubuntu',
    family: 'Debian',
    major: '24.04',
    full: '24.04.1',
    codename: 'noble',
    arch: 'x86_64',
  },
  {
    name: 'Debian',
    family: 'Debian',
    major: '12',
    full: '12.7',
    codename: 'bookworm',
    arch: 'x86_64',
  },
  { name: 'SLES', family: 'Suse', major: '15', full: '15.6', codename: null, arch: 'x86_64' },
];
const ROLES = ['web', 'db', 'app', 'cache', 'lb', 'mq', 'worker', 'monitor'];

// PuppetDB latest_report_status values.
const REPORT_STATUS = ['changed', 'unchanged', 'unchanged', 'unchanged', 'failed'];

// ---------------------------------------------------------------------------
// 1. Node inventory — /pdb/query/v4/nodes
// ---------------------------------------------------------------------------

const nodes = [];
for (let i = 1; i <= 50; i += 1) {
  const role = ROLES[i % ROLES.length];
  const certname = `${role}${String(i).padStart(2, '0')}.${DOMAIN}`;
  const environment = pick(ENVIRONMENTS);
  const status = pick(REPORT_STATUS);

  // A handful of nodes are stale, deactivated, or expired — the states an
  // inventory UI must render distinctly rather than silently omit.
  const isDeactivated = i === 47;
  const isExpired = i === 48;
  const isStale = i === 49 || i === 50;

  const ageSeconds = isStale ? -int(200000, 900000) : -int(60, 1800);

  nodes.push({
    certname,
    deactivated: isDeactivated ? iso(-86400 * 3) : null,
    expired: isExpired ? iso(-86400 * 8) : null,
    catalog_timestamp: isDeactivated ? null : iso(ageSeconds + 2),
    facts_timestamp: isDeactivated ? null : iso(ageSeconds),
    report_timestamp: isDeactivated ? null : iso(ageSeconds + 5),
    catalog_environment: isDeactivated ? null : environment,
    facts_environment: isDeactivated ? null : environment,
    report_environment: isDeactivated ? null : environment,
    latest_report_status: isDeactivated ? null : status,
    latest_report_noop: environment === 'development',
    latest_report_noop_pending: environment === 'development' && status === 'changed',
    latest_report_hash: isDeactivated ? null : sha1(`${certname}:report`),
    latest_report_job_id: null,
  });
}

// ---------------------------------------------------------------------------
// 2. Full factset for one node — /pdb/query/v4/factsets
// ---------------------------------------------------------------------------

const factNode = nodes[0].certname;
const factOs = OS[0];

const factData = [
  { name: 'aio_agent_version', value: '8.10.0' },
  { name: 'architecture', value: factOs.arch },
  { name: 'clientcert', value: factNode },
  { name: 'clientversion', value: '8.10.0' },
  { name: 'domain', value: DOMAIN },
  { name: 'fqdn', value: factNode },
  { name: 'hostname', value: factNode.split('.')[0] },
  { name: 'is_virtual', value: true },
  { name: 'kernel', value: 'Linux' },
  { name: 'kernelmajversion', value: '5.14' },
  { name: 'kernelrelease', value: '5.14.0-427.40.1.el9_4.x86_64' },
  { name: 'kernelversion', value: '5.14.0' },
  {
    name: 'memory',
    value: {
      system: {
        available: '12.04 GiB',
        available_bytes: 12928204800,
        capacity: '24.75%',
        total: '15.61 GiB',
        total_bytes: 16763875328,
        used: '3.86 GiB',
        used_bytes: 4148412416,
      },
      swap: {
        available: '4.00 GiB',
        available_bytes: 4294967296,
        capacity: '0.00%',
        total: '4.00 GiB',
        total_bytes: 4294967296,
        used: '0 bytes',
        used_bytes: 0,
      },
    },
  },
  {
    name: 'networking',
    value: {
      domain: DOMAIN,
      fqdn: factNode,
      hostname: factNode.split('.')[0],
      interfaces: {
        eth0: {
          bindings: [{ address: '10.20.30.41', netmask: '255.255.255.0', network: '10.20.30.0' }],
          ip: '10.20.30.41',
          mac: '52:54:00:1a:2b:3c',
          mtu: 1500,
          netmask: '255.255.255.0',
          network: '10.20.30.0',
        },
        lo: {
          bindings: [{ address: '127.0.0.1', netmask: '255.0.0.0', network: '127.0.0.0' }],
          ip: '127.0.0.1',
          mtu: 65536,
          netmask: '255.0.0.0',
          network: '127.0.0.0',
        },
      },
      ip: '10.20.30.41',
      mac: '52:54:00:1a:2b:3c',
      mtu: 1500,
      primary: 'eth0',
    },
  },
  {
    name: 'os',
    value: {
      architecture: factOs.arch,
      family: factOs.family,
      hardware: factOs.arch,
      name: factOs.name,
      release: { full: factOs.full, major: factOs.major, minor: factOs.full.split('.')[1] ?? '0' },
      selinux: { config_mode: 'enforcing', enabled: true, enforced: true },
    },
  },
  {
    name: 'processors',
    value: {
      cores: 4,
      count: 8,
      isa: 'x86_64',
      models: Array.from({ length: 8 }, () => 'Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz'),
      physicalcount: 1,
      threads: 2,
    },
  },
  { name: 'puppetversion', value: '8.10.0' },
  { name: 'role', value: factNode.split(/\d/)[0] },
  { name: 'timezone', value: 'UTC' },
  { name: 'virtual', value: 'kvm' },
  // A string that looks like a number and one that looks like a boolean:
  // both are classic YAML/JSON round-trip traps for the ENC renderer.
  { name: 'selinux_mode', value: 'enforcing' },
  { name: 'rack_position', value: '0755' },
  { name: 'maintenance_window', value: 'yes' },
];

const factset = [
  {
    certname: factNode,
    environment: 'production',
    timestamp: iso(-300),
    producer_timestamp: iso(-302),
    producer: `puppetserver01.${DOMAIN}`,
    hash: sha1(`${factNode}:factset`),
    facts: {
      href: `/pdb/query/v4/factsets/${factNode}/facts`,
      data: factData,
    },
  },
];

// ---------------------------------------------------------------------------
// 3. Reports — /pdb/query/v4/reports
// ---------------------------------------------------------------------------

function report({ certname, status, startOffset, durationSeconds, events, logs }) {
  // Reuse the hash the node list advertises as latest_report_hash, so the
  // inventory's report link actually resolves to this report.
  const hash = sha1(`${certname}:report`);
  return [
    {
      hash,
      certname,
      puppet_version: '8.10.0',
      report_format: 12,
      transaction_uuid: uuid(`${hash}:txn`),
      catalog_uuid: uuid(`${hash}:cat`),
      code_id: null,
      job_id: null,
      cached_catalog_status: 'not_used',
      environment: 'production',
      status,
      noop: false,
      noop_pending: false,
      corrective_change: null,
      start_time: iso(startOffset),
      end_time: iso(startOffset + durationSeconds),
      producer_timestamp: iso(startOffset + durationSeconds + 1),
      producer: `puppetserver01.${DOMAIN}`,
      receive_time: iso(startOffset + durationSeconds + 2),
      configuration_version: String(1753000000 + Math.abs(startOffset)),
      resource_events: {
        href: `/pdb/query/v4/reports/${hash}/events`,
        data: events,
      },
      metrics: {
        href: `/pdb/query/v4/reports/${hash}/metrics`,
        data: [
          { category: 'time', name: 'total', value: durationSeconds },
          { category: 'time', name: 'config_retrieval', value: 2.14 },
          { category: 'time', name: 'file', value: 0.31 },
          { category: 'time', name: 'package', value: 1.02 },
          { category: 'resources', name: 'total', value: 214 },
          {
            category: 'resources',
            name: 'changed',
            value: events.filter((e) => e.status === 'success').length,
          },
          {
            category: 'resources',
            name: 'failed',
            value: events.filter((e) => e.status === 'failure').length,
          },
          {
            category: 'resources',
            name: 'skipped',
            value: events.filter((e) => e.status === 'skipped').length,
          },
          { category: 'resources', name: 'out_of_sync', value: events.length },
          { category: 'events', name: 'total', value: events.length },
          {
            category: 'changes',
            name: 'total',
            value: events.filter((e) => e.status === 'success').length,
          },
        ],
      },
      logs: {
        href: `/pdb/query/v4/reports/${hash}/logs`,
        data: logs,
      },
    },
  ];
}

// Chosen FROM the generated node list. Naming a certname that the estate does
// not contain makes the fixture set internally inconsistent: a report would
// reference a node the inventory has never heard of.
const successCertname =
  nodes.find((n) => n.latest_report_status !== 'failed' && !n.deactivated)?.certname ??
  nodes[0].certname;
const successEvents = [
  {
    status: 'success',
    timestamp: iso(-1795),
    resource_type: 'File',
    resource_title: '/etc/ntp.conf',
    property: 'content',
    name: 'content',
    old_value: '{md5}5d41402abc4b2a76b9719d911017c592',
    new_value: '{md5}7d793037a0760186574b0282f2f435e7',
    message:
      "content changed '{md5}5d41402abc4b2a76b9719d911017c592' to '{md5}7d793037a0760186574b0282f2f435e7'",
    file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/base/ntp.pp',
    line: 24,
    containment_path: ['Stage[main]', 'Profile::Base::Ntp', 'File[/etc/ntp.conf]'],
    containing_class: 'Profile::Base::Ntp',
    corrective_change: true,
  },
  {
    status: 'success',
    timestamp: iso(-1793),
    resource_type: 'Service',
    resource_title: 'ntpd',
    property: 'ensure',
    name: 'ensure',
    old_value: 'stopped',
    new_value: 'running',
    message: "ensure changed 'stopped' to 'running'",
    file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/base/ntp.pp',
    line: 31,
    containment_path: ['Stage[main]', 'Profile::Base::Ntp', 'Service[ntpd]'],
    containing_class: 'Profile::Base::Ntp',
    corrective_change: false,
  },
];

const failureCertname =
  nodes.find((n) => n.latest_report_status === 'failed')?.certname ?? nodes[1].certname;
const failureEvents = [
  {
    status: 'failure',
    timestamp: iso(-895),
    resource_type: 'Package',
    resource_title: 'postgresql16-server',
    property: 'ensure',
    name: 'ensure',
    old_value: 'absent',
    new_value: '16.4',
    message:
      "Could not update: Execution of '/usr/bin/dnf -d 0 -e 1 -y install postgresql16-server-16.4' returned 1: Error: Unable to find a match: postgresql16-server-16.4",
    file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/db/postgres.pp',
    line: 18,
    containment_path: ['Stage[main]', 'Profile::Db::Postgres', 'Package[postgresql16-server]'],
    containing_class: 'Profile::Db::Postgres',
    corrective_change: false,
  },
  {
    // Skipped because it depends on the failed package — the dependency chain
    // an operator actually needs to see when triaging.
    status: 'skipped',
    timestamp: iso(-894),
    resource_type: 'Service',
    resource_title: 'postgresql-16',
    property: null,
    name: null,
    old_value: null,
    new_value: null,
    message: null,
    file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/db/postgres.pp',
    line: 42,
    containment_path: ['Stage[main]', 'Profile::Db::Postgres', 'Service[postgresql-16]'],
    containing_class: 'Profile::Db::Postgres',
    corrective_change: null,
  },
  {
    status: 'skipped',
    timestamp: iso(-894),
    resource_type: 'Exec',
    resource_title: 'initdb-postgresql-16',
    property: null,
    name: null,
    old_value: null,
    new_value: null,
    message: null,
    file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/db/postgres.pp',
    line: 55,
    containment_path: ['Stage[main]', 'Profile::Db::Postgres', 'Exec[initdb-postgresql-16]'],
    containing_class: 'Profile::Db::Postgres',
    corrective_change: null,
  },
  {
    status: 'noop',
    timestamp: iso(-893),
    resource_type: 'File',
    resource_title: '/var/lib/pgsql/16/data/postgresql.conf',
    property: 'content',
    name: 'content',
    old_value: '{md5}0cc175b9c0f1b6a831c399e269772661',
    new_value: '{md5}92eb5ffee6ae2fec3ad71c777531578f',
    message:
      'current_value {md5}0cc175b9c0f1b6a831c399e269772661, should be {md5}92eb5ffee6ae2fec3ad71c777531578f (noop)',
    file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/db/postgres.pp',
    line: 63,
    containment_path: [
      'Stage[main]',
      'Profile::Db::Postgres',
      'File[/var/lib/pgsql/16/data/postgresql.conf]',
    ],
    containing_class: 'Profile::Db::Postgres',
    corrective_change: null,
  },
];

const successReport = report({
  certname: successCertname,
  status: 'changed',
  startOffset: -1800,
  durationSeconds: 12,
  events: successEvents,
  logs: [
    {
      file: null,
      line: null,
      level: 'info',
      message: 'Applying configuration version 1753001800',
      source: 'Puppet',
      tags: ['info'],
      time: iso(-1799),
    },
    {
      file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/base/ntp.pp',
      line: 24,
      level: 'notice',
      message:
        "content changed '{md5}5d41402abc4b2a76b9719d911017c592' to '{md5}7d793037a0760186574b0282f2f435e7'",
      source: '/Stage[main]/Profile::Base::Ntp/File[/etc/ntp.conf]/content',
      tags: ['notice', 'file', 'content', 'profile::base::ntp'],
      time: iso(-1795),
    },
    {
      file: null,
      line: null,
      level: 'notice',
      message: 'Applied catalog in 12.04 seconds',
      source: 'Puppet',
      tags: ['notice'],
      time: iso(-1788),
    },
  ],
});

const failureReport = report({
  certname: failureCertname,
  status: 'failed',
  startOffset: -900,
  durationSeconds: 47,
  events: failureEvents,
  logs: [
    {
      file: null,
      line: null,
      level: 'info',
      message: 'Applying configuration version 1753000900',
      source: 'Puppet',
      tags: ['info'],
      time: iso(-899),
    },
    {
      file: '/etc/puppetlabs/code/environments/production/modules/profile/manifests/db/postgres.pp',
      line: 18,
      level: 'err',
      message:
        "Could not update: Execution of '/usr/bin/dnf -d 0 -e 1 -y install postgresql16-server-16.4' returned 1: Error: Unable to find a match: postgresql16-server-16.4",
      source: '/Stage[main]/Profile::Db::Postgres/Package[postgresql16-server]/ensure',
      tags: ['err', 'package', 'ensure', 'profile::db::postgres'],
      time: iso(-895),
    },
    {
      file: null,
      line: null,
      level: 'notice',
      message: 'Skipping because of failed dependencies',
      source: '/Stage[main]/Profile::Db::Postgres/Service[postgresql-16]',
      tags: ['notice', 'service', 'profile::db::postgres'],
      time: iso(-894),
    },
    {
      file: null,
      line: null,
      level: 'notice',
      message: 'Applied catalog in 47.21 seconds',
      source: 'Puppet',
      tags: ['notice'],
      time: iso(-853),
    },
  ],
});

// ---------------------------------------------------------------------------

const files = {
  'nodes-query.sample.json': nodes,
  'factset-single-node.sample.json': factset,
  'report-success.sample.json': successReport,
  'report-failure.sample.json': failureReport,
};

for (const [name, payload] of Object.entries(files)) {
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`wrote ${name.padEnd(34)} ${JSON.stringify(payload).length} bytes`);
}

console.log(`\n${nodes.length} nodes, ${factData.length} facts, 2 reports.`);
console.log(
  'SYNTHETIC — generated from the PuppetDB 8 v4 API documentation, not from a real estate.',
);
