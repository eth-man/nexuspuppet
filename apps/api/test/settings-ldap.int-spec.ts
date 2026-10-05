import { randomBytes } from 'node:crypto';
import type {
  IAuditSink,
  LdapDialectName,
  LdapSettings,
  ProviderVerification,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { SettingsService } from '../src/settings/settings.service';
import { SettingsStore } from '../src/settings/settings.store';
import type { AuthProviderResolver } from '../src/auth/auth-provider.resolver';
import type { AuthenticatedRequest } from '../src/auth/auth.guard';
import { roleIdFor } from './support/roles';

/**
 * The LDAP settings API against a REAL PostgreSQL (ADR-0016).
 *
 * What matters here is not that a value round-trips — the store's own suite
 * covers that — but that the bind password never leaves the server, that a save
 * which omits it does not wipe it, and that Test asks the provider rather than
 * pretending.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const KEY = randomBytes(32).toString('base64');

const SETTINGS: LdapSettings = {
  host: 'directory.example.test',
  port: 636,
  protocol: 'ldaps',
  bindType: 'regular',
  bindDn: 'cn=svc,dc=example,dc=test',
  bindPassword: 'a-bind-secret',
  searchBase: 'ou=people,dc=example,dc=test',
  nestedGroups: false,
  roleMappings: [{ groupDn: 'cn=ops,dc=example,dc=test', role: 'OPERATOR' }],
  timeoutMs: 10_000,
  tlsRejectUnauthorized: true,
};

/**
 * A request from a REAL user row.
 *
 * actorUserId is a uuid with a foreign key to users, so a made-up identifier
 * fails at the database rather than in the code under test — and the audit
 * assertions below would then be testing the fixture.
 */
let actorId = '';

const request = (email = 'admin@example.com') =>
  ({
    principal: { userId: actorId, email, role: 'ADMIN', displayName: email, authSource: 'local' },
    headers: { 'user-agent': 'jest' },
    ip: '10.0.0.1',
  }) as unknown as AuthenticatedRequest;

describe('LDAP settings API (integration)', () => {
  let prisma: PrismaService;
  let audit: IAuditSink;

  /** A resolver holding a provider that verifies whatever it is given. */
  const resolverWith = (
    verify?: (config: unknown) => Promise<ProviderVerification>,
  ): AuthProviderResolver =>
    ({
      forSource: (source: string) =>
        source === 'ldap'
          ? { source: 'ldap', ...(verify === undefined ? {} : { verifyConfiguration: verify }) }
          : null,
    }) as unknown as AuthProviderResolver;

  const service = (
    _resolver: AuthProviderResolver = resolverWith(),
    key: string | null = KEY,
    /** What the directory's RootDSE says at Save (ADR-0030 §4). */
    detect?: (candidate: LdapSettings) => Promise<LdapDialectName | null>,
  ) =>
    new SettingsService(
      new SettingsStore(prisma, key ?? undefined, 'db'),
      // A REAL PrismaService here, so the transaction that binds a settings
      // change to its audit record is a real one (#103).
      prisma,
      audit,
      () => null,
      // No OIDC in these tests: this suite is about the LDAP kind.
      () => null,
      detect,
    );

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
    audit = new PrismaAuditSink(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.providerSetting.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();

    const actor = await prisma.user.create({
      data: {
        email: 'admin@example.com',
        displayName: 'Admin',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        authSource: 'local',
      },
    });
    actorId = actor.id;
  });

  describe('reading', () => {
    it('answers when nothing is configured, rather than erroring', async () => {
      const view = await service().describeLdap();

      expect(view.source).toBe('unset');
      expect(view.config).toBeNull();
    });

    it('NEVER returns the bind password', async () => {
      // The property this whole design exists for.
      await service().saveLdap(SETTINGS, request());

      const view = await service().describeLdap();

      expect(view.config?.bindPassword).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain('a-bind-secret');
    });

    it('reports that a password is HELD, so the UI can say "set" rather than "empty"', async () => {
      await service().saveLdap(SETTINGS, request());

      expect((await service().describeLdap()).secretsHeld).toEqual(['bindPassword']);
    });

    it('always reports live reload — the first configuration needs no restart either', async () => {
      // Before ADR-0029 a deployment with no LDAP_URL had no provider, and this
      // was false: "saved, restart to apply". Both providers are registered on
      // every deployment now, so even an unset deployment reloads live.
      expect((await service().describeLdap()).liveReload).toBe(true);

      await service().saveLdap(SETTINGS, request());
      expect((await service().describeLdap()).liveReload).toBe(true);
    });

    it('says up front whether a bind password can be stored at all', async () => {
      expect((await service().describeLdap()).secretsStorable).toBe(true);
      expect((await service(resolverWith(), null).describeLdap()).secretsStorable).toBe(false);
    });
  });

  describe('writing', () => {
    it('keeps the stored password when a save omits it', async () => {
      // The console never receives the password, so it cannot send it back.
      // Treating absence as "clear it" would wipe the credential every time
      // somebody corrected a search base.
      await service().saveLdap(SETTINGS, request());

      const { bindPassword: _omitted, ...withoutPassword } = SETTINGS;
      await service().saveLdap(
        { ...withoutPassword, searchBase: 'ou=staff,dc=example,dc=test' } as LdapSettings,
        request(),
      );

      const stored = await new SettingsStore(prisma, KEY, 'db').resolve<LdapSettings>(
        'auth.ldap',
        () => null,
      );

      expect(stored.config?.searchBase).toBe('ou=staff,dc=example,dc=test');
      expect(stored.config?.bindPassword).toBe('a-bind-secret');
    });

    it('audits the change without recording the secret', async () => {
      // The audit trail must record that the directory changed and who changed
      // it. It must not become the one place a bind password is kept in clear.
      await prisma.user.create({
        data: {
          email: 'operator@example.com',
          displayName: 'Operator',
          role: 'ADMIN',
          roleId: await roleIdFor(prisma, 'ADMIN'),
          authSource: 'local',
        },
      });

      await service().saveLdap(SETTINGS, request('operator@example.com'));

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'settings.auth.ldap.update' },
      });

      expect(entry?.actorEmail).toBe('operator@example.com');
      expect(JSON.stringify(entry)).not.toContain('a-bind-secret');
    });

    it('stores the change and its audit record in one transaction', async () => {
      // The audit row is written with the transaction client, so a failure of
      // either rolls back both. Observable here as: both exist, and the audit
      // row's AFTER is the redacted configuration that was saved.
      await service().saveLdap(SETTINGS, request());

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'settings.auth.ldap.update' },
      });
      expect(entry?.after).toMatchObject({
        host: SETTINGS.host,
        protocol: SETTINGS.protocol,
        searchBase: SETTINGS.searchBase,
      });
      expect(entry?.after).not.toHaveProperty('bindPassword');
      expect(await prisma.providerSetting.count()).toBe(1);
    });

    it('refuses a bind password without CONFIG_ENCRYPTION_KEY, saying what to run', async () => {
      // ADR-0029 §6. Staging and at least one real deployment ran without a key,
      // so the console could not store a bind password at all — and the error
      // said "holds a secret" without saying which, or what to do.
      await expect(service(resolverWith(), null).saveLdap(SETTINGS, request())).rejects.toThrow(
        /Saving a bind password needs CONFIG_ENCRYPTION_KEY\. Re-run scripts\/deploy\.sh/,
      );
      expect(await prisma.providerSetting.count()).toBe(0);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('stores a configuration without a password even with no key', async () => {
      // Anonymous search is legitimate; the key is only needed for a secret.
      const { bindPassword: _p, bindDn: _d, ...rest } = SETTINGS;
      const anonymous: LdapSettings = { ...rest, bindType: 'anonymous' };

      await service(resolverWith(), null).saveLdap(anonymous, request());

      expect(await prisma.providerSetting.count()).toBe(1);
    });

    it('clearing restores the environment and is audited', async () => {
      await service().saveLdap(SETTINGS, request());
      await service().clearLdap(request());

      expect((await service().describeLdap()).source).toBe('unset');
      expect(await prisma.auditLog.count({ where: { action: 'settings.auth.ldap.clear' } })).toBe(
        1,
      );
    });
  });

  /** ADR-0030: the connection fields, against the real store. */
  describe('connection fields', () => {
    /** A row exactly as v1.12 saved it: url + dialect + bindDn, password sealed. */
    async function saveLegacyRow(config: Record<string, unknown>, secret?: string): Promise<void> {
      await new SettingsStore(prisma, KEY, 'db').save(
        'auth.ldap',
        { ...config, ...(secret === undefined ? {} : { bindPassword: secret }) },
        ['bindPassword'],
        'v1.12@example.com',
      );
    }

    const LEGACY = {
      url: 'ldaps://dc01.example.test:636',
      dialect: 'ad',
      bindDn: 'cn=svc,dc=example,dc=test',
      searchBase: 'ou=people,dc=example,dc=test',
      nestedGroups: false,
      roleMappings: [{ groupDn: 'cn=ops,dc=example,dc=test', role: 'OPERATOR' }],
      timeoutMs: 10_000,
      tlsRejectUnauthorized: true,
    };

    it('shows a v1.12 row as host, port, protocol, Regular and its dialect — no migration', async () => {
      await saveLegacyRow(LEGACY, 'legacy-secret');

      const view = await service().describeLdap();

      expect(view.config).toMatchObject({
        host: 'dc01.example.test',
        port: 636,
        protocol: 'ldaps',
        bindType: 'regular',
        bindDn: 'cn=svc,dc=example,dc=test',
        detectedDialect: 'ad',
      });
      expect(view.config).not.toHaveProperty('url');
      expect(view.secretsHeld).toEqual(['bindPassword']);
      expect(JSON.stringify(view)).not.toContain('legacy-secret');
    });

    it('shows a v1.12 unencrypted row as legacy, and refuses to save it unchanged', async () => {
      await saveLegacyRow({ ...LEGACY, url: 'ldap://dc01.example.test' }, 'legacy-secret');

      const view = await service().describeLdap();
      expect(view.config).toMatchObject({ protocol: 'ldap', port: 389 });

      await expect(service().saveLdap(view.config!, request())).rejects.toThrow(
        /Unencrypted LDAP can no longer be saved/,
      );
    });

    it('stores what the RootDSE said, never what the body claimed', async () => {
      await service(resolverWith(), KEY, async () => 'ad').saveLdap(
        { ...SETTINGS, detectedDialect: 'openldap' },
        request(),
      );

      expect((await service().describeLdap()).config?.detectedDialect).toBe('ad');
    });

    it('keeps what it knew when the directory is unreachable at Save, for the same server', async () => {
      await service(resolverWith(), KEY, async () => 'ad').saveLdap(SETTINGS, request());
      await service(resolverWith(), KEY, async () => null).saveLdap(
        { ...SETTINGS, searchBase: 'ou=staff,dc=example,dc=test' },
        request(),
      );

      expect((await service().describeLdap()).config?.detectedDialect).toBe('ad');
    });

    it('forgets it when the server changed, rather than carrying AD to a new host', async () => {
      await service(resolverWith(), KEY, async () => 'ad').saveLdap(SETTINGS, request());
      await service(resolverWith(), KEY, async () => null).saveLdap(
        { ...SETTINGS, host: 'other.example.test' },
        request(),
      );

      expect((await service().describeLdap()).config).not.toHaveProperty('detectedDialect');
    });

    it('detects with the STORED password when the body omits it', async () => {
      await service().saveLdap(SETTINGS, request());

      let seen: LdapSettings | null = null;
      const { bindPassword: _omitted, ...withoutPassword } = SETTINGS;
      await service(resolverWith(), KEY, async (candidate) => {
        seen = candidate;
        return 'openldap';
      }).saveLdap(withoutPassword, request());

      expect((seen as unknown as LdapSettings).bindPassword).toBe('a-bind-secret');
    });

    it('discards the stored password when the bind type no longer uses one', async () => {
      await service().saveLdap(SETTINGS, request());
      expect((await service().describeLdap()).secretsHeld).toEqual(['bindPassword']);

      const { bindPassword: _p, bindDn: _d, ...rest } = SETTINGS;
      await service().saveLdap(
        { ...rest, bindType: 'simple', userDnPattern: '{username}@corp.example' },
        request(),
      );

      const view = await service().describeLdap();
      expect(view.secretsHeld).toEqual([]);
      expect(view.config).toMatchObject({
        bindType: 'simple',
        userDnPattern: '{username}@corp.example',
      });
      const resolved = await new SettingsStore(prisma, KEY, 'db').resolve<LdapSettings>(
        'auth.ldap',
        () => null,
      );
      expect(resolved.config).not.toHaveProperty('bindPassword');
    });

    it('refuses Regular with no password typed and none stored', async () => {
      const { bindPassword: _omitted, ...withoutPassword } = SETTINGS;
      await expect(service().saveLdap(withoutPassword, request())).rejects.toThrow(
        /Regular bind needs the password for the User DN/,
      );
      expect(await prisma.providerSetting.count()).toBe(0);
    });

    it('saves STARTTLS and its port', async () => {
      await service().saveLdap({ ...SETTINGS, protocol: 'starttls', port: 389 }, request());

      expect((await service().describeLdap()).config).toMatchObject({
        protocol: 'starttls',
        port: 389,
      });
    });

    it('never returns the password from Save', async () => {
      const view = await service().saveLdap(SETTINGS, request());
      expect(JSON.stringify(view)).not.toContain('a-bind-secret');
    });
  });

  describe('testing a candidate', () => {
    it('asks the provider and returns what it says', async () => {
      const resolver = resolverWith(async () => ({
        ok: true,
        message: 'Bound and found 4 users.',
        details: [{ label: 'Directory', value: 'ldaps://directory.example.test:636' }],
      }));

      const result = await service(resolver).verifyLdap(SETTINGS, resolver);

      expect(result.ok).toBe(true);
      expect(result.message).toContain('4 users');
    });

    it('tests with the STORED password when the candidate omits it', async () => {
      // Otherwise Test fails for an operator changing only a search base, and
      // they learn nothing about the change they actually made.
      await service().saveLdap(SETTINGS, request());

      let seen: LdapSettings | null = null;
      const resolver = resolverWith(async (config) => {
        seen = config as LdapSettings;
        return { ok: true, message: 'ok' };
      });

      const { bindPassword: _omitted, ...withoutPassword } = SETTINGS;
      await service(resolver).verifyLdap(withoutPassword as LdapSettings, resolver);

      expect(seen).not.toBeNull();
      expect((seen as unknown as LdapSettings).bindPassword).toBe('a-bind-secret');
    });

    it('does not persist anything', async () => {
      const resolver = resolverWith(async () => ({ ok: true, message: 'ok' }));

      await service(resolver).verifyLdap(SETTINGS, resolver);

      expect(await prisma.providerSetting.count()).toBe(0);
    });

    it('is not audited — a test changes nothing', async () => {
      const resolver = resolverWith(async () => ({ ok: true, message: 'ok' }));

      await service(resolver).verifyLdap(SETTINGS, resolver);

      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('says so plainly if no provider is registered — a wiring fault since ADR-0029', async () => {
      const result = await service(resolverWith()).verifyLdap(SETTINGS, {
        forSource: () => null,
      } as unknown as AuthProviderResolver);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no ldap provider is registered/i);
    });

    it('reports a provider that throws as a failed test, not a 500', async () => {
      // The operator's question — does this configuration work — is answered
      // either way. A stack trace is not the answer.
      const resolver = resolverWith(async () => {
        throw new Error('ECONNREFUSED 10.0.0.9:636');
      });

      const result = await service(resolver).verifyLdap(SETTINGS, resolver);

      expect(result.ok).toBe(false);
      // And the raw error does not reach the browser.
      expect(result.message).not.toContain('ECONNREFUSED');
    });
  });
});
