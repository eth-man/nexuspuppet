import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { roleIdFor } from './support/roles';

/**
 * The support bundle, end to end: a REAL Nest application with the global
 * guard, a real Postgres, the real log sink writing real files, and the
 * archive read back with the system `tar` (ADR-0028).
 *
 * The properties that matter are negative ones — what is NOT in the archive —
 * and a mock can only confirm what the code already believes about itself. So
 * every leak this feature promises to prevent is planted for real here, and
 * the extracted archive is searched for it byte by byte.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const LOG_DIR = mkdtempSync(join(tmpdir(), 'np-bundle-logs-'));
const ENC_DIR = mkdtempSync(join(tmpdir(), 'np-bundle-enc-'));

/** Planted secrets: every one of these must be absent from the archive. */
const JWT_SECRET = 'bundle-test-jwt-secret-0123456789abcdefghijklmnop';
const POSTGRES_PASSWORD = 'planted-postgres-password-77';
const LEAKED_IN_LOG = 'planted-ldap-bind-password-42';
const ADMIN_EMAIL = 'bundle-admin@example.test';
const VIEWER_EMAIL = 'bundle-viewer@example.test';
const OTHER_ACTOR = 'someone-else@example.test';
const CLIENT_IP = '203.0.113.77';
const USER_AGENT = 'LeakyBrowser/9.9';
const PARAMETER_VALUE = 'classification-parameter-secret-value';
const PASSWORD_HASH = 'scrypt$planted-password-hash-value-do-not-export';
const CLASS_PARAM = 'visible-only-with-personal-data-9f3a';
const SAVED_QUERY_NAME = 'sudoers on the payment boxes';

const ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET,
  DATABASE_URL,
  POSTGRES_PASSWORD,
  LDAP_BIND_PASSWORD: LEAKED_IN_LOG,
  PUPPETDB_URL: 'https://puppetdb.invalid:8081',
  PUPPETDB_CERT_PATH: '/dev/null',
  PUPPETDB_KEY_PATH: '/dev/null',
  PUPPETDB_CA_PATH: '/dev/null',
  ENC_OUTPUT_DIR: ENC_DIR,
  LOG_DIR,
  // Nothing in the background: this test is about one request.
  PUPPETDB_PROJECTION_INTERVAL_MS: '0',
  PUPPETDB_POLL_INTERVAL_MS: '0',
  NOTIFICATION_EVALUATION_INTERVAL_MS: '0',
  AUDIT_RETENTION_INTERVAL_MS: '0',
  ENC_MATERIALIZER_INTERVAL_MS: '3600000',
  ENC_RECONCILE_INTERVAL_MS: '3600000',
};

describe('GET /system/support-bundle (integration)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
    await prisma.refreshToken.deleteMany();
    await prisma.auditDeliveryJob.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.savedQuery.deleteMany();
    await prisma.user.deleteMany();
    await prisma.notificationCondition.deleteMany();
    await prisma.nodeGroup.deleteMany({ where: { name: 'bundle-test-group' } });

    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        displayName: 'Admin',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        authSource: 'local',
        // Never exported, in either variant.
        passwordHash: PASSWORD_HASH,
      },
    });

    // Classification and a saved query: only in the opt-in variant.
    await prisma.nodeGroup.create({
      data: {
        name: 'bundle-test-group',
        classes: { create: [{ className: 'profile::db', params: { api_key: CLASS_PARAM } }] },
        parameters: {
          create: [
            { key: 'visible', value: CLASS_PARAM },
            // A parameter equal to an environment secret is still redacted.
            { key: 'db_password', value: POSTGRES_PASSWORD },
          ],
        },
        pins: { create: [{ certname: 'pinned.example.test' }] },
      },
    });
    await prisma.savedQuery.create({
      data: {
        userId: admin.id,
        ownerEmail: ADMIN_EMAIL,
        name: SAVED_QUERY_NAME,
        kind: 'node',
        filter: { status: 'failed' },
      },
    });
    const viewer = await prisma.user.create({
      data: {
        email: VIEWER_EMAIL,
        displayName: 'Viewer',
        role: 'VIEWER',
        roleId: await roleIdFor(prisma, 'VIEWER'),
        authSource: 'local',
      },
    });

    // The incident this feature exists for, planted as it would really look.
    await prisma.notificationCondition.create({
      data: {
        key: 'puppetdb.unreachable',
        kind: 'puppetdb.unreachable',
        severity: 'critical',
        summary: 'PuppetDB is unreachable',
        consecutiveFailures: 9000,
        openedAt: new Date(Date.now() - 42 * 86_400_000),
        lastEvaluatedAt: new Date(),
      },
    });

    // An audit row carrying everything the bundle promises to leave out.
    await prisma.auditLog.create({
      data: {
        actorEmail: OTHER_ACTOR,
        action: 'node-group.update',
        entityType: 'NodeGroup',
        entityId: 'group-1',
        entityLabel: 'payment boxes',
        before: { parameters: { password: PARAMETER_VALUE } },
        after: { parameters: { password: PARAMETER_VALUE } },
        ipAddress: CLIENT_IP,
        userAgent: USER_AGENT,
      },
    });

    // The real bootstrap path: a sink in LOG_DIR, the tee logger, the module.
    const { AppModule } = await import('../src/app.module');
    const { FileLogSink } = await import('../src/logging/file-log-sink');
    const { TeeConsoleLogger } = await import('../src/logging/tee-console-logger');
    const { TokenService } = await import('../src/auth/token.service');

    const logSink = FileLogSink.open({
      directory: LOG_DIR,
      host: 'itest',
      maxBytes: 1_000_000,
      keep: 2,
    });
    const logger = new TeeConsoleLogger(logSink);
    logger.setLogLevels(['log', 'warn', 'error']);

    const { runWithRequestId } = await import('../src/common/request-context');

    app = await NestFactory.create(await AppModule.bootstrap({ logSink }), { logger });
    // As main.ts does, so audit rows are correlated the way they are in production.
    app.use(
      (_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
        runWithRequestId((requestId) => {
          res.setHeader('x-request-id', requestId);
          next();
        });
      },
    );
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${String((app.getHttpServer().address() as AddressInfo).port)}`;

    // A secret that reached a log line by mistake — the redaction pass's job.
    new Logger('Directory').warn(`bind failed with password ${LEAKED_IN_LOG}`);

    const tokens = app.get(TokenService);
    const principal = (user: typeof admin) => ({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      authSource: 'local',
    });
    adminToken = (await tokens.issue(principal(admin))).accessToken;
    viewerToken = (await tokens.issue(principal(viewer))).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.onModuleDestroy();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  it('refuses an anonymous caller', async () => {
    expect((await get('/system/support-bundle')).status).toBe(401);
  });

  it('refuses a signed-in caller without settings:manage', async () => {
    const response = await get('/system/support-bundle', viewerToken);
    expect(response.status).toBe(403);
  });

  it.each(['0', '73', '1.5', 'abc'])('rejects hours=%s', async (hours) => {
    expect((await get(`/system/support-bundle?hours=${hours}`, adminToken)).status).toBe(400);
  });

  /** Download a bundle and extract it with the system tar — what support will use. */
  const download = async (
    query: string,
  ): Promise<{ headers: Headers; body: Buffer; files: Map<string, string> }> => {
    const response = await get(`/system/support-bundle?${query}`, adminToken);
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());

    const dir = mkdtempSync(join(tmpdir(), 'np-bundle-out-'));
    const archive = join(dir, 'bundle.tar.gz');
    writeFileSync(archive, body);
    const extracted = join(dir, 'x');
    execFileSync('mkdir', ['-p', extracted]);
    execFileSync('tar', ['-xzf', archive, '-C', extracted]);

    const files = new Map<string, string>();
    const walk = (relative: string): void => {
      for (const name of readdirSync(join(extracted, relative))) {
        const path = relative === '' ? name : `${relative}/${name}`;
        if (statSync(join(extracted, path)).isDirectory()) walk(path);
        else files.set(path, readFileSync(join(extracted, path), 'utf8'));
      }
    };
    walk('');
    return { headers: response.headers, body, files };
  };

  const exportRows = () =>
    prisma.auditLog.findMany({
      where: { action: 'system.support-bundle.export' },
      orderBy: { createdAt: 'asc' },
    });

  /** Values that must never leave, in EITHER variant. */
  const neverExported = (): Array<[string, string]> => [
    ['JWT_SECRET', JWT_SECRET],
    ['POSTGRES_PASSWORD', POSTGRES_PASSWORD],
    ['a password that reached a log line', LEAKED_IN_LOG],
    ['a password hash', PASSWORD_HASH],
    ["the admin's access token", adminToken],
    ["the viewer's access token", viewerToken],
  ];

  describe('for an administrator, by default', () => {
    let body: Buffer;
    let headers: Headers;
    let files: Map<string, string>;

    beforeAll(async () => {
      ({ headers, body, files } = await download('hours=24'));
    });

    it('is a gzip download with a dated filename and no caching', () => {
      expect(headers.get('content-type')).toBe('application/gzip');
      // Never Content-Encoding: the web relay's fetch would decode and strip it.
      expect(headers.get('content-encoding')).toBeNull();
      expect(headers.get('cache-control')).toBe('no-store');
      expect(headers.get('content-disposition')).toMatch(
        /^attachment; filename="nexuspuppet-support-[A-Za-z0-9.-]+-\d{8}T\d{6}Z\.tar\.gz"$/,
      );
      expect(body[0]).toBe(0x1f);
      expect(body[1]).toBe(0x8b);
    });

    it('contains the manifest, the summary and every section — and no personal files', () => {
      const tarList = execFileSync('tar', ['-t'], { input: gunzipSync(body) })
        .toString()
        .trim()
        .split('\n');

      expect(tarList[0]).toBe('manifest.json');
      for (const expected of [
        'summary.txt',
        'status/system-status.json',
        'status/deployment.json',
        'status/conditions.json',
        'status/propagation.json',
        'status/log-level.json',
        'config/environment.json',
        'config/providers.json',
        'database/migrations.json',
        'database/materialization-jobs.json',
        'database/users-and-roles.json',
        'audit/audit-log.jsonl',
        'logs/api-itest.log',
      ]) {
        expect(tarList).toContain(expected);
      }
      for (const absent of [
        'personal/users.json',
        'config/classification.json',
        'config/saved-queries.json',
      ]) {
        expect(tarList).not.toContain(absent);
      }
      expect(JSON.parse(files.get('manifest.json') ?? '{}').includesPersonalData).toBe(false);
    });

    it('carries the API log, with the secret that reached it redacted', () => {
      const log = files.get('logs/api-itest.log') ?? '';
      expect(log).toContain('bind failed with password [REDACTED:LDAP_BIND_PASSWORD]');
      expect(
        JSON.parse(files.get('manifest.json') ?? '{}').redaction.counts['secret-value'],
      ).toBeGreaterThan(0);
    });

    it('leads with the open PuppetDB condition', () => {
      expect(files.get('summary.txt')).toMatch(
        /OPEN CRITICAL condition "puppetdb.unreachable" since .* \(42 days\)/,
      );
    });

    it('reports secrets as set, never their values', () => {
      const environment = JSON.parse(files.get('config/environment.json') ?? '{}');
      expect(environment.secrets).toMatchObject({
        JWT_SECRET: 'set',
        DATABASE_URL: 'set',
        POSTGRES_PASSWORD: 'set',
        LDAP_BIND_PASSWORD: 'set',
      });
      expect(environment.values.LOG_DIR).toBe(LOG_DIR);
    });

    it('omits identities, client addresses, user agents and audit payloads', () => {
      const audit = (files.get('audit/audit-log.jsonl') ?? '')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(audit.map((row) => row['action'])).toEqual(
        expect.arrayContaining(['node-group.update', 'system.support-bundle.export']),
      );
      for (const row of audit) {
        expect(Object.keys(row).sort()).toEqual(
          ['action', 'createdAt', 'entityId', 'entityType', 'requestId'].sort(),
        );
      }
    });

    /*
     * THE ONE THAT MATTERS. Every planted value, searched for in every file of
     * the extracted archive — not just where we expect it might appear.
     */
    it.each([
      ["the exporting admin's email", ADMIN_EMAIL],
      ["the viewer's email", VIEWER_EMAIL],
      ["another actor's email (actorEmail)", OTHER_ACTOR],
      ['a client IP address (ipAddress)', CLIENT_IP],
      ['a user agent', USER_AGENT],
      ['an audit payload value', PARAMETER_VALUE],
      ['an entity label', 'payment boxes'],
      ['a class parameter value', CLASS_PARAM],
      ['a saved query name', SAVED_QUERY_NAME],
    ])('never contains %s', (label, value) => {
      for (const [path, content] of files) {
        if (content.includes(value)) throw new Error(`${path} contains ${label}`);
      }
    });

    it('never contains a secret, a hash or a token', async () => {
      const refreshHashes = (await prisma.refreshToken.findMany()).map((row) => row.tokenHash);
      expect(refreshHashes.length).toBeGreaterThan(0);
      for (const [label, value] of [
        ...neverExported(),
        ...refreshHashes.map((hash) => ['a refresh token hash', hash] as [string, string]),
      ]) {
        for (const [path, content] of files) {
          if (content.includes(value)) throw new Error(`${path} contains ${label}`);
        }
      }
    });

    it('writes an audit row for the export, through the audit sink', async () => {
      const rows = await exportRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorEmail: ADMIN_EMAIL,
        entityType: 'SupportBundle',
        after: { hours: 24, includePersonalData: false },
      });
      // Correlated like every other request (#229).
      expect(rows[0]?.requestId).not.toBeNull();
    });

    it('reports the local log copy as working', () => {
      const manifest = JSON.parse(files.get('manifest.json') ?? '{}');
      expect(manifest.logs.thisReplicaSink).toMatchObject({ enabled: true, file: 'api-itest.log' });
      expect(manifest.logs.replicas[0]).toMatchObject({ host: 'itest', coversWindow: false });
      expect(manifest.window.hours).toBe(24);
    });
  });

  /*
   * The opt-in (ADR-0028 §6): the operator ticked "include configuration and
   * personal data". Identities and the classification come out; secrets still
   * do not.
   */
  describe('for an administrator who ticked personal data', () => {
    let headers: Headers;
    let files: Map<string, string>;

    beforeAll(async () => {
      ({ headers, files } = await download('hours=24&includePersonalData=true'));
    });

    it('marks the filename, so it cannot pass for the safe variant', () => {
      expect(headers.get('content-disposition')).toMatch(
        /filename="nexuspuppet-support-[A-Za-z0-9.-]+-\d{8}T\d{6}Z-with-personal-data\.tar\.gz"$/,
      );
    });

    it('says so first in the manifest', () => {
      const raw = files.get('manifest.json') ?? '{}';
      expect(Object.keys(JSON.parse(raw) as object).slice(0, 2)).toEqual([
        'format',
        'includesPersonalData',
      ]);
      expect(JSON.parse(raw).includesPersonalData).toBe(true);
      expect(files.get('summary.txt')).toContain('THIS BUNDLE CONTAINS PERSONAL DATA');
    });

    it('includes the audit trail with actors, addresses and payloads', () => {
      const audit = files.get('audit/audit-log.jsonl') ?? '';
      for (const value of [OTHER_ACTOR, CLIENT_IP, USER_AGENT, PARAMETER_VALUE, 'payment boxes']) {
        expect(audit).toContain(value);
      }
    });

    it('includes users — without hashes — and counts their sessions', () => {
      const users = JSON.parse(files.get('personal/users.json') ?? '{}').users as Array<
        Record<string, unknown>
      >;
      const admin = users.find((user) => user['email'] === ADMIN_EMAIL);

      expect(admin).toMatchObject({ role: 'ADMIN', authSource: 'local', isActive: true });
      expect(admin?.['activeSessions']).toBeGreaterThanOrEqual(1);
      expect(Object.keys(admin ?? {})).not.toContain('passwordHash');
      expect(users.map((user) => user['email'])).toContain(VIEWER_EMAIL);
    });

    it('includes the classification in full, and saved queries', () => {
      const classification = files.get('config/classification.json') ?? '';
      expect(classification).toContain(CLASS_PARAM);
      expect(classification).toContain('pinned.example.test');
      // A parameter equal to an environment secret is STILL redacted.
      expect(classification).toContain('[REDACTED:POSTGRES_PASSWORD]');

      expect(files.get('config/saved-queries.json')).toContain(SAVED_QUERY_NAME);
    });

    it('still never contains a secret, a hash or a token', async () => {
      const refreshHashes = (await prisma.refreshToken.findMany()).map((row) => row.tokenHash);
      for (const [label, value] of [
        ...neverExported(),
        ...refreshHashes.map((hash) => ['a refresh token hash', hash] as [string, string]),
      ]) {
        for (const [path, content] of files) {
          if (content.includes(value)) throw new Error(`${path} contains ${label}`);
        }
      }
    });

    it('records in the audit trail that personal data went out', async () => {
      const rows = await exportRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        actorEmail: ADMIN_EMAIL,
        entityLabel: 'with personal data',
        after: { hours: 24, includePersonalData: true },
      });
    });
  });

  // Exactly "true" or "false". Anything looser is how "false" ends up meaning yes.
  it.each(['yes', '1', 'TRUE', ''])('rejects includePersonalData=%s', async (value) => {
    const response = await get(`/system/support-bundle?includePersonalData=${value}`, adminToken);
    expect(response.status).toBe(400);
  });
});
