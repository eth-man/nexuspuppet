import { formatRecord } from '../../logging/pure/log-record';
import type { HostLog } from './log-window';
import {
  attentionItems,
  buildBundle,
  bundleFileName,
  compactTimestamp,
  EXCLUDED_BY_DEFAULT,
  NEVER_INCLUDED,
  PERSONAL_DATA_CONTENTS,
  type BundleInput,
  type ConditionRow,
} from './bundle';

const NOW = '2026-09-30T12:00:00.000Z';
const JWT_SECRET = 'the-signing-secret-that-must-never-leave-0123456789';

const logLine = (ts: string, message: string, host = 'api1') =>
  formatRecord({ ts, level: 'warn', context: 'NodeProjection', message, pid: 1, host });

const hostLog = (host: string, entries: Array<[string, string]>, earliest?: string): HostLog => ({
  host,
  lines: entries.map(([ts, message]) => ({ ts, text: logLine(ts, message, host) })),
  files: [{ name: `api-${host}.log`, bytes: 1234 }],
  earliestOnDisk: earliest ?? entries[0]?.[0] ?? null,
  latestOnDisk: entries[entries.length - 1]?.[0] ?? null,
  unparseable: 0,
});

/** The 2026 incident: the Puppet server VM powered off for six weeks. */
const puppetdbDown: ConditionRow = {
  key: 'puppetdb.unreachable',
  kind: 'puppetdb.unreachable',
  severity: 'critical',
  summary: 'PuppetDB has not answered since 2026-08-19T08:00:00Z',
  consecutiveFailures: 12_000,
  openedAt: '2026-08-19T08:00:00.000Z',
  resolvedAt: null,
  lastEvaluatedAt: '2026-09-30T11:55:00.000Z',
};

const input = (over: Partial<BundleInput> = {}): BundleInput => ({
  generatedAt: NOW,
  hours: 24,
  includesPersonalData: false,
  api: { host: 'api1', version: 'v1.9.0', nodeVersion: 'v22.0.0', pid: 1, uptimeSeconds: 60 },
  logs: {
    directory: '/var/log/nexuspuppet',
    sink: {
      enabled: true,
      directory: '/var/log/nexuspuppet',
      file: 'api-api1.log',
      maxBytes: 20_971_520,
      keep: 5,
    },
    readError: null,
    hosts: [
      hostLog(
        'api1',
        [
          ['2026-09-29T13:00:00.000Z', 'PuppetDB unreachable: connect ECONNREFUSED'],
          ['2026-09-30T11:59:00.000Z', `oops, logged ${JWT_SECRET} by mistake`],
        ],
        '2026-09-28T00:00:00.000Z',
      ),
    ],
  },
  signals: {
    conditions: [],
    materializationFailed: 0,
    materializationPending: 0,
    auditDeliveryQueued: 0,
    newestProjectionAt: '2026-09-30T11:58:00.000Z',
  },
  json: {
    'status/deployment.json': { version: 'v1.9.0' },
    'config/environment.json': { values: { LOG_LEVEL: 'info' } },
  },
  audit: {
    rows: [
      {
        createdAt: '2026-09-30T11:59:30.000Z',
        action: 'system.support-bundle.export',
        entityType: 'SupportBundle',
        entityId: null,
        requestId: null,
      },
    ],
    truncated: 0,
  },
  secrets: [{ name: 'JWT_SECRET', value: JWT_SECRET }],
  ...over,
});

const text = (bundle: ReturnType<typeof buildBundle>, name: string): string =>
  bundle.entries.find((entry) => entry.name === name)?.content.toString('utf8') ?? '';

const manifestOf = (bundle: ReturnType<typeof buildBundle>) =>
  JSON.parse(text(bundle, 'manifest.json')) as Record<string, any>;

describe('buildBundle', () => {
  it('lays the archive out manifest, summary, data, then logs', () => {
    const names = buildBundle(input()).entries.map((entry) => entry.name);

    expect(names).toEqual([
      'manifest.json',
      'summary.txt',
      'audit/audit-log.jsonl',
      'config/environment.json',
      'status/deployment.json',
      'logs/api-api1.log',
    ]);
  });

  it('is deterministic: identical input, identical bytes', () => {
    const a = buildBundle(input());
    const b = buildBundle(input());
    expect(a.entries.map((e) => e.content.toString('base64'))).toEqual(
      b.entries.map((e) => e.content.toString('base64')),
    );
  });

  it('names the file after the host and the moment, sortably', () => {
    expect(buildBundle(input()).fileName).toBe('nexuspuppet-support-api1-20260930T120000Z.tar.gz');
    expect(compactTimestamp('2026-01-02T03:04:05.678Z')).toBe('20260102T030405Z');
    expect(bundleFileName('bad host/name', NOW)).toBe(
      'nexuspuppet-support-bad_host_name-20260930T120000Z.tar.gz',
    );
  });

  /*
   * THE SECOND LINE OF DEFENCE. A secret should never reach a log line — but
   * if one does, it must not leave in the bundle.
   */
  it('redacts a known secret that reached a log line, and counts it', () => {
    const bundle = buildBundle(input());

    for (const entry of bundle.entries) {
      expect(entry.content.toString('utf8')).not.toContain(JWT_SECRET);
    }
    expect(text(bundle, 'logs/api-api1.log')).toContain('[REDACTED:JWT_SECRET]');
    expect(manifestOf(bundle)['redaction']).toMatchObject({
      counts: { 'secret-value': 1 },
      byFile: { 'logs/api-api1.log': { 'secret-value': 1 } },
      literalSecretsSearched: ['JWT_SECRET'],
    });
  });

  it('redacts inside the JSON files too', () => {
    const bundle = buildBundle(
      input({
        json: {
          'status/system-status.json': {
            lastError: `connect to postgresql://np:pw-${'x'.repeat(10)}@db failed; key ${JWT_SECRET}`,
          },
        },
      }),
    );
    const status = text(bundle, 'status/system-status.json');

    expect(status).not.toContain(JWT_SECRET);
    expect(status).not.toContain('pw-xxxx');
    expect(status).toContain('[REDACTED:URL-CREDENTIALS]@db');
  });

  // Found on the first real run: the url-credentials rule redacted the
  // manifest's own description of it.
  it('describes its redaction rules legibly — no rule mangles its own description', () => {
    const rules = manifestOf(buildBundle(input()))['redaction']['rules'] as string[];
    expect(rules.join('\n')).not.toContain('[REDACTED');
  });

  it('records the window, the version and the sizes of what it contains', () => {
    const manifest = manifestOf(buildBundle(input()));

    expect(manifest['window']).toEqual({
      from: '2026-09-29T12:00:00.000Z',
      to: NOW,
      hours: 24,
    });
    expect(manifest['version']).toBe('v1.9.0');
    expect(manifest['files']).toContainEqual({
      path: 'logs/api-api1.log',
      bytes: Buffer.byteLength(text(buildBundle(input()), 'logs/api-api1.log')),
    });
    expect(manifest['audit']).toEqual({ file: 'audit/audit-log.jsonl', rows: 1, droppedOldest: 0 });
  });

  it('states what it deliberately excludes, and where the rest comes from', () => {
    const manifest = manifestOf(buildBundle(input()));

    expect(manifest['excluded']).toEqual([...NEVER_INCLUDED, ...EXCLUDED_BY_DEFAULT]);
    expect(manifest['neverIncluded']).toEqual([...NEVER_INCLUDED]);
    expect(manifest['hostSideCollection']).toContain('scripts/support-bundle.sh');
    expect(text(buildBundle(input()), 'summary.txt')).toContain('scripts/support-bundle.sh');
  });

  /*
   * The opt-in (ADR-0028 §6). Identities are what was asked for, so the email
   * rule stands down; nothing else does. Every secret rule runs in both.
   */
  describe('with personal data', () => {
    const withPersonal = (over: Partial<BundleInput> = {}) =>
      input({
        includesPersonalData: true,
        json: {
          'personal/users.json': { users: [{ email: 'jane@corp.example', role: 'ADMIN' }] },
          'config/classification.json': {
            groups: [{ name: 'db', parameters: [{ key: 'pw', value: JWT_SECRET }] }],
          },
        },
        ...over,
      });

    it('says so in the filename, so it cannot be mistaken for the safe variant', () => {
      expect(buildBundle(withPersonal()).fileName).toBe(
        'nexuspuppet-support-api1-20260930T120000Z-with-personal-data.tar.gz',
      );
      expect(bundleFileName('h', NOW, false)).not.toContain('personal');
    });

    it('says so at the very top of the manifest, and lists what was added', () => {
      const raw = text(buildBundle(withPersonal()), 'manifest.json');
      const keys = Object.keys(JSON.parse(raw) as object);

      expect(keys.slice(0, 3)).toEqual(['format', 'includesPersonalData', 'personalData']);
      expect(JSON.parse(raw)['personalData']).toEqual([...PERSONAL_DATA_CONTENTS]);
      expect(Object.keys(manifestOf(buildBundle(input())))[1]).toBe('includesPersonalData');
      expect(manifestOf(buildBundle(input()))['includesPersonalData']).toBe(false);
    });

    it('opens the summary with a warning', () => {
      const summary = text(buildBundle(withPersonal()), 'summary.txt');
      expect(summary.split('\n')[3]).toMatch(/^THIS BUNDLE CONTAINS PERSONAL DATA/);
      expect(text(buildBundle(input()), 'summary.txt')).not.toContain('PERSONAL DATA');
    });

    it('keeps email addresses, which the default variant masks', () => {
      const personal = text(buildBundle(withPersonal()), 'personal/users.json');
      expect(personal).toContain('jane@corp.example');

      const masked = buildBundle(
        input({ json: { 'status/x.json': { contact: 'jane@corp.example' } } }),
      );
      expect(text(masked, 'status/x.json')).toContain('[REDACTED:EMAIL]');
    });

    it('still redacts every secret — in a class parameter, in a log, in a key', () => {
      const bundle = buildBundle(
        withPersonal({
          json: {
            'config/classification.json': {
              groups: [
                {
                  parameters: [
                    { key: 'pw', value: JWT_SECRET },
                    {
                      key: 'key',
                      // Assembled: CI refuses a committed private-key header.
                      value: [
                        ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
                        'AAA',
                        ['-----END', 'PRIVATE KEY-----'].join(' '),
                      ].join('\n'),
                    },
                    { key: 'url', value: 'https://u:p4ss@h.example' },
                  ],
                },
              ],
            },
          },
        }),
      );

      for (const entry of bundle.entries) {
        expect(entry.content.toString('utf8')).not.toContain(JWT_SECRET);
      }
      const classification = text(bundle, 'config/classification.json');
      expect(classification).toContain('[REDACTED:JWT_SECRET]');
      expect(classification).toContain('[REDACTED:PEM-PRIVATE-KEY]');
      expect(classification).toContain('https://[REDACTED:URL-CREDENTIALS]@h.example');
    });

    it('lists only the never-included items as excluded, and says the email rule was off', () => {
      const manifest = manifestOf(buildBundle(withPersonal()));
      expect(manifest['excluded']).toEqual([...NEVER_INCLUDED]);
      expect(manifest['redaction']['rules'].join('\n')).toContain('email: NOT applied');
    });
  });

  describe('log coverage — so a reader knows when 24 hours were not 24 hours', () => {
    it('reports full coverage when history reaches past the window start', () => {
      const replica = manifestOf(buildBundle(input()))['logs']['replicas'][0];
      expect(replica).toMatchObject({
        host: 'api1',
        file: 'logs/api-api1.log',
        linesInWindow: 2,
        earliestInWindow: '2026-09-29T13:00:00.000Z',
        latestInWindow: '2026-09-30T11:59:00.000Z',
        coversWindow: true,
      });
    });

    it('flags a replica whose history starts inside the window', () => {
      const bundle = buildBundle(
        input({
          logs: {
            ...input().logs,
            hosts: [hostLog('fresh', [['2026-09-30T09:00:00.000Z', 'started']])],
          },
        }),
      );
      const manifest = manifestOf(bundle);

      expect(manifest['logs']['replicas'][0]['coversWindow']).toBe(false);
      expect(manifest['attention'].join('\n')).toContain(
        'Logs for fresh begin at 2026-09-30T09:00',
      );
    });

    it('says loudly when there are no API logs at all, and why', () => {
      const bundle = buildBundle(
        input({
          logs: {
            directory: '/var/log/nexuspuppet',
            sink: {
              enabled: false,
              directory: '/var/log/nexuspuppet',
              reason: 'ENOENT: no such file or directory',
            },
            readError: 'ENOENT: no such file or directory',
            hosts: [],
          },
        }),
      );
      const attention = manifestOf(bundle)['attention'].join('\n');

      expect(attention).toContain('not keeping a local log copy: ENOENT');
      expect(attention).toContain('NO API LOGS');
      expect(bundle.entries.some((e) => e.name.startsWith('logs/'))).toBe(false);
    });

    it('records truncation, and where the kept history begins', () => {
      const bundle = buildBundle(input({ logCapBytes: 200 }));
      const logs = manifestOf(bundle)['logs'];

      expect(logs['truncated']).toMatchObject({
        droppedLines: 1,
        keptFrom: '2026-09-30T11:59:00.000Z',
      });
      expect(text(bundle, 'logs/api-api1.log')).not.toContain('ECONNREFUSED');
    });
  });

  /*
   * The incident this feature was written after. Six weeks blind to PuppetDB,
   * visible only as a WARN every 30 seconds and one open condition. Whoever
   * opens the bundle must read that first.
   */
  describe('the six-week PuppetDB outage', () => {
    const outage = input({
      signals: {
        conditions: [puppetdbDown],
        materializationFailed: 0,
        materializationPending: 0,
        auditDeliveryQueued: 0,
        newestProjectionAt: '2026-08-19T07:55:00.000Z',
      },
    });

    it('leads the summary with the open condition and how long it has been open', () => {
      const summary = text(buildBundle(outage), 'summary.txt');
      const firstItem = summary.split('\n').find((line) => line.startsWith('  - '));

      expect(firstItem).toContain('OPEN CRITICAL condition "puppetdb.unreachable"');
      expect(firstItem).toContain('since 2026-08-19T08:00:00.000Z (42 days)');
    });

    it('also says the node cache has gone stale', () => {
      expect(manifestOf(buildBundle(outage))['attention']).toContainEqual(
        expect.stringContaining('The newest PuppetDB projection is 42 days old'),
      );
    });
  });

  describe('attentionItems', () => {
    const base = input();

    it('is empty for a healthy deployment', () => {
      expect(attentionItems(base, [])).toEqual([]);
    });

    it('orders critical before warning, and mentions recent resolutions', () => {
      const items = attentionItems(
        input({
          signals: {
            ...base.signals,
            conditions: [
              {
                ...puppetdbDown,
                key: 'w',
                severity: 'warning',
                openedAt: '2026-09-30T10:00:00.000Z',
              },
              { ...puppetdbDown, key: 'c' },
              {
                ...puppetdbDown,
                key: 'r',
                openedAt: '2026-09-30T01:00:00.000Z',
                resolvedAt: '2026-09-30T02:00:00.000Z',
              },
              {
                ...puppetdbDown,
                key: 'old',
                openedAt: '2026-01-01T00:00:00.000Z',
                resolvedAt: '2026-01-02T00:00:00.000Z',
              },
            ],
          },
        }),
        [],
      );

      expect(items[0]).toContain('"c"');
      expect(items[1]).toContain('"w"');
      expect(items[1]).toContain('(2 h)');
      expect(items.some((item) => item.includes('Resolved within the window: "r"'))).toBe(true);
      expect(items.some((item) => item.includes('"old"'))).toBe(false);
    });

    it('names stranded work', () => {
      const items = attentionItems(
        input({
          signals: {
            ...base.signals,
            materializationFailed: 3,
            materializationPending: 500,
            auditDeliveryQueued: 7,
            newestProjectionAt: null,
          },
        }),
        [],
      );

      expect(items.join('\n')).toMatch(/3 ENC materialization job\(s\) FAILED/);
      expect(items.join('\n')).toMatch(/500 ENC materialization jobs are pending/);
      expect(items.join('\n')).toMatch(/7 audit record\(s\) are waiting/);
      expect(items.join('\n')).toMatch(/No node has ever been projected/);
    });
  });
});
