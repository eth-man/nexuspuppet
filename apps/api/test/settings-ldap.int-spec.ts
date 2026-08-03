import { randomBytes } from 'node:crypto';
import type { IAuditSink, LdapSettings, ProviderVerification } from '@nexuspuppet/contracts';
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
  url: 'ldaps://directory.example.test:636',
  bindDn: 'cn=svc,dc=example,dc=test',
  bindPassword: 'a-bind-secret',
  dialect: 'openldap',
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

  const service = (resolver: AuthProviderResolver = resolverWith()) =>
    new SettingsService(
      new SettingsStore(prisma, KEY, 'db'),
      audit,
      () => null,
      () => resolver.forSource('ldap') !== null,
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

    it('reports whether a change takes effect without a restart', async () => {
      // Configuring LDAP for the first time needs a restart, because
      // registration builds the DI graph. The console has to say so.
      await service().saveLdap(SETTINGS, request());

      const withProvider = await service(
        resolverWith(async () => ({ ok: true, message: 'y' })),
      ).describeLdap();
      expect(withProvider.liveReload).toBe(true);

      const noProvider = new SettingsService(
        new SettingsStore(prisma, KEY, 'db'),
        audit,
        () => null,
        () => false,
      );
      expect((await noProvider.describeLdap()).liveReload).toBe(false);
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

    it('clearing restores the environment and is audited', async () => {
      await service().saveLdap(SETTINGS, request());
      await service().clearLdap(request());

      expect((await service().describeLdap()).source).toBe('unset');
      expect(await prisma.auditLog.count({ where: { action: 'settings.auth.ldap.clear' } })).toBe(
        1,
      );
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

    it('says so plainly when no provider is running', async () => {
      const result = await service(resolverWith()).verifyLdap(SETTINGS, {
        forSource: () => null,
      } as unknown as AuthProviderResolver);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no ldap provider is running/i);
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
