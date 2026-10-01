import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AuthenticatedPrincipal, LdapSettings } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { AuthProviderResolver } from '../src/auth/auth-provider.resolver';
import { LocalAuthProvider, LocalUserDirectory } from '../src/auth/local-auth.provider';
import { hashPassword } from '../src/auth/password';
import { TokenService } from '../src/auth/token.service';
import { UsersService } from '../src/auth/users.service';
import type { AuthenticatedRequest } from '../src/auth/auth.guard';
import { LdapAuthProvider } from '../src/directory/ldap/ldap-auth.provider';
import type { LdapConfig } from '../src/directory/ldap/config';
import type { LdapDirectory } from '../src/directory/ldap/ldap-client';
import { OidcAuthProvider } from '../src/directory/oidc/oidc-auth.provider';
import { AuthSettingsResolver } from '../src/settings/auth-settings.resolver';
import { SettingsService } from '../src/settings/settings.service';
import { SettingsStore } from '../src/settings/settings.store';
import { ldapEnvBaseline, oidcEnvBaseline } from '../src/settings/provider-baseline';
import { roleIdFor } from './support/roles';

/**
 * Enabling a directory from the console, with no restart (ADR-0029).
 *
 * The user report this answers: an install upgraded from core showed LDAP and
 * SSO as "NOT ENABLED — set LDAP_URL and restart", because a provider was only
 * registered when the environment configured one.
 *
 * Everything here is the REAL path except the directory server itself: a real
 * PostgreSQL, the real settings store and its encryption, the real
 * AUTH_PROVIDER_SETTINGS reader, real providers built with NO environment
 * baseline, and the real resolver with its timing floor. The LDAP wire
 * protocol is the one stub — it has its own suite against OpenLDAP — and it
 * records which directory a password reached, which is the property at stake.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const KEY = randomBytes(32).toString('base64');
const FLOOR_MS = 150;

const ADMIN_PASSWORD = 'correct horse battery staple';
const LDAP_EMAIL = 'alice@corp.test';
const LDAP_PASSWORD = 'alice-directory-password';

const SETTINGS: LdapSettings = {
  url: 'ldaps://dc.corp.test:636',
  bindDn: 'cn=svc,dc=corp,dc=test',
  bindPassword: 'svc-secret',
  dialect: 'openldap',
  searchBase: 'ou=people,dc=corp,dc=test',
  nestedGroups: false,
  roleMappings: [{ groupDn: 'cn=ops,ou=groups,dc=corp,dc=test', role: 'OPERATOR' }],
  timeoutMs: 10_000,
  tlsRejectUnauthorized: true,
};

/** A directory that knows one person, and records every directory it was built for. */
function fakeDirectory(config: LdapConfig, contacted: string[]): LdapDirectory {
  contacted.push(config.url);
  return {
    findEntry: async () => ({
      dn: 'uid=alice,ou=people,dc=corp,dc=test',
      email: LDAP_EMAIL,
      displayName: 'Alice',
      groupDns: ['cn=ops,ou=groups,dc=corp,dc=test'],
    }),
    verifyCredentials: async (_dn, password) => password === LDAP_PASSWORD,
    findGroupsContaining: async () => [],
  };
}

describe('enabling a directory from the console (integration)', () => {
  let prisma: PrismaService;
  let resolver: AuthProviderResolver;
  let settings: SettingsService;
  let users: UsersService;
  let contacted: string[];
  let adminId: string;

  const actor = (): AuthenticatedPrincipal => ({
    userId: adminId,
    email: 'admin@example.com',
    role: 'ADMIN',
    displayName: 'Admin',
    authSource: 'local',
  });

  const request = (): AuthenticatedRequest =>
    ({
      principal: actor(),
      headers: { 'user-agent': 'jest' },
      ip: '10.0.0.1',
    }) as unknown as AuthenticatedRequest;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await prisma.providerSetting.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();

    const admin = await prisma.user.create({
      data: {
        email: 'admin@example.com',
        displayName: 'Admin',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        authSource: 'local',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
      },
    });
    adminId = admin.id;

    contacted = [];
    const store = new SettingsStore(prisma, KEY, 'db');
    const reader = new AuthSettingsResolver(store);
    const identities = new LocalUserDirectory(prisma);
    const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

    // Exactly what app.module builds on a deployment with no LDAP_* / OIDC_*.
    const ldap = new LdapAuthProvider({
      config: null,
      directory: null,
      identities,
      logger: silent,
      settings: reader,
      directoryFor: (config) => fakeDirectory(config, contacted),
    });
    const oidc = new OidcAuthProvider({
      config: null,
      identities,
      logger: silent,
      settings: reader,
    });

    resolver = new AuthProviderResolver(
      [new LocalAuthProvider(prisma), ldap, oidc],
      prisma,
      FLOOR_MS,
    );
    settings = new SettingsService(
      store,
      prisma,
      new PrismaAuditSink(prisma),
      () => ldapEnvBaseline(resolver),
      () => oidcEnvBaseline(resolver),
    );
    const tokens = new TokenService(prisma, resolver, {
      secret: 'x'.repeat(48),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
    users = new UsersService(prisma, new PrismaAuditSink(prisma), tokens, resolver);
  });

  afterEach(() => jest.restoreAllMocks());

  const provisionAlice = () =>
    users.create(
      { email: LDAP_EMAIL, displayName: 'Alice', role: 'VIEWER', authSource: 'ldap' },
      actor(),
      { ipAddress: '10.0.0.1', userAgent: 'jest' },
    );

  it('starts dormant: off the login page, but a source accounts can be created for', async () => {
    expect((await resolver.descriptors()).map((d) => d.source)).toEqual(['local']);
    expect(await resolver.provisionableSources()).toEqual([
      expect.objectContaining({ source: 'ldap', configured: false }),
      expect.objectContaining({ source: 'local', configured: true }),
      expect.objectContaining({ source: 'oidc', configured: false }),
    ]);

    // Pre-provisioning, before the directory is enabled (ADR-0029 §2).
    const created = await provisionAlice();
    expect(created.authSource).toBe('ldap');
  });

  it('refuses a provisioned account generically, within the floor, while dormant', async () => {
    await provisionAlice();

    const startedAt = Date.now();
    const result = await resolver.authenticate({ email: LDAP_EMAIL, password: LDAP_PASSWORD });

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FLOOR_MS - 20);
    // Nothing was contacted: there is nothing to contact.
    expect(contacted).toEqual([]);
  });

  it('tests a candidate before anything is saved, on a deployment with no boot configuration', async () => {
    const result = await settings.verifyLdap(SETTINGS, resolver);

    expect(result.ok).toBe(true);
    expect(contacted).toEqual(['ldaps://dc.corp.test:636']);
    expect(await prisma.providerSetting.count()).toBe(0);
  });

  it('a SAVE activates it for the very next sign-in — same resolver, same providers, no restart', async () => {
    await provisionAlice();

    const view = await settings.saveLdap(SETTINGS, request());
    expect(view).toMatchObject({
      source: 'database',
      liveReload: true,
      secretsHeld: ['bindPassword'],
    });

    expect((await resolver.descriptors()).map((d) => d.source)).toEqual(['ldap', 'local']);
    const result = await resolver.authenticate({ email: LDAP_EMAIL, password: LDAP_PASSWORD });
    expect(result).toMatchObject({ ok: true, principal: { authSource: 'ldap', role: 'OPERATOR' } });
    expect(contacted).toContain('ldaps://dc.corp.test:636');

    // Audited, with the secret kept out of the trail.
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'settings.auth.ldap.update' },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry)).not.toContain('svc-secret');
  });

  it('a DISCARD returns it to dormant: the login is refused, sessions end, local is untouched', async () => {
    await provisionAlice();
    await settings.saveLdap(SETTINGS, request());
    const signedIn = await resolver.authenticate({ email: LDAP_EMAIL, password: LDAP_PASSWORD });
    expect(signedIn.ok).toBe(true);

    await settings.clearLdap(request());

    await expect(
      resolver.authenticate({ email: LDAP_EMAIL, password: LDAP_PASSWORD }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect((await resolver.descriptors()).map((d) => d.source)).toEqual(['local']);

    // A refresh for the directory account fails closed (ADR-0015 §3).
    const alice = await prisma.user.findUniqueOrThrow({ where: { email: LDAP_EMAIL } });
    await expect(resolver.resolve(alice.id)).resolves.toBeNull();

    // Local accounts never depended on any of it (ADR-0015).
    await expect(
      resolver.authenticate({ email: 'admin@example.com', password: ADMIN_PASSWORD }),
    ).resolves.toMatchObject({ ok: true, principal: { authSource: 'local' } });

    expect(await prisma.auditLog.count({ where: { action: 'settings.auth.ldap.clear' } })).toBe(1);
  });

  it('refuses a stored configuration that no longer parses LOUDLY, not as dormant', async () => {
    await provisionAlice();
    // Written behind the API's back, as a downgrade or a hand edit would.
    await prisma.providerSetting.create({
      data: { kind: 'auth.ldap', config: { url: 'not-a-url' }, updatedByEmail: 'x' },
    });

    // Still offered: it is configured, just broken — and says so in the log.
    expect((await resolver.descriptors()).map((d) => d.source)).toContain('ldap');
    await expect(
      resolver.authenticate({ email: LDAP_EMAIL, password: LDAP_PASSWORD }),
    ).resolves.toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });
});
