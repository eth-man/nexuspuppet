import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ldapSettingsSchema, type LdapSettings } from '@nexuspuppet/contracts';
import { AuthProviderResolver } from '../../src/auth/auth-provider.resolver';
import type { AuthenticatedRequest } from '../../src/auth/auth.guard';
import { PrismaAuditSink } from '../../src/auth/core-capabilities';
import { LocalAuthProvider, LocalUserDirectory } from '../../src/auth/local-auth.provider';
import { LdapAuthProvider } from '../../src/directory/ldap/ldap-auth.provider';
import { ANONYMOUS_REFUSED } from '../../src/directory/ldap/ldap-client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuthSettingsResolver } from '../../src/settings/auth-settings.resolver';
import { SettingsService } from '../../src/settings/settings.service';
import { SettingsStore } from '../../src/settings/settings.store';
import { roleIdFor } from '../support/roles';

/**
 * Signing in THROUGH THE RESOLVER, against the real OpenLDAP, with settings
 * saved the way the console saves them.
 *
 * The staging run against a real AD found what the provider-level suites
 * could not: the resolver finds the account by the address TYPED, so what
 * reaches a Simple-bind pattern is always an email — `alice@example.com`, never
 * `alice`. A test that hands the provider `alice` proves a path no user can
 * take. Every sign-in here starts where a user's does: an account row with a
 * real email, `AuthProviderResolver.authenticate`, the timing floor.
 *
 * Needs the fixture (`npm run ldap:up`) AND the integration database
 * (TEST_DATABASE_URL, migrated with `npm run db:test:setup`).
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const BASE_DN = 'dc=nexuspuppet,dc=test';
const HOST = process.env['TEST_LDAP_HOST'] ?? 'localhost';
const CA_PEM = readFileSync(join(__dirname, 'certs', 'ca.crt'), 'utf8');
const KEY = randomBytes(32).toString('base64');

const MAPPINGS = [
  { groupDn: `cn=ops,ou=groups,${BASE_DN}`, role: 'OPERATOR' },
  { groupDn: `cn=viewers,ou=groups,${BASE_DN}`, role: 'VIEWER' },
  { groupDn: `cn=puppet-admins,ou=groups,${BASE_DN}`, role: 'ADMIN' },
];

const TRANSPORTS = [
  ['STARTTLS', { host: HOST, port: 3890, protocol: 'starttls' }],
  ['LDAPS', { host: HOST, port: 6360, protocol: 'ldaps' }],
] as const;

describe('directory sign-in through the real resolver', () => {
  let prisma: PrismaService;
  let resolver: AuthProviderResolver;
  let settings: SettingsService;
  let ldap: LdapAuthProvider;
  let adminId = '';

  const request = (): AuthenticatedRequest =>
    ({
      principal: {
        userId: adminId,
        email: 'admin@example.com',
        role: 'ADMIN',
        displayName: 'Admin',
        authSource: 'local',
      },
      headers: { 'user-agent': 'jest' },
      ip: '10.0.0.1',
    }) as unknown as AuthenticatedRequest;

  /** Save as the console does: the request body through the controller's schema. */
  const save = async (body: Record<string, unknown>): Promise<void> => {
    await settings.saveLdap(
      ldapSettingsSchema.parse({
        searchBase: `ou=people,${BASE_DN}`,
        roleMappings: MAPPINGS,
        caPem: CA_PEM,
        timeoutMs: 5000,
        ...body,
      }) as LdapSettings,
      request(),
    );
  };

  const account = async (email: string): Promise<void> => {
    await prisma.user.create({
      data: {
        email,
        displayName: email,
        role: 'VIEWER',
        roleId: await roleIdFor(prisma, 'VIEWER'),
        authSource: 'ldap',
      },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await prisma.providerSetting.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();

    adminId = (
      await prisma.user.create({
        data: {
          email: 'admin@example.com',
          displayName: 'Admin',
          role: 'ADMIN',
          roleId: await roleIdFor(prisma, 'ADMIN'),
          authSource: 'local',
        },
      })
    ).id;
    for (const email of [
      'alice@nexuspuppet.test',
      'bob@nexuspuppet.test',
      'dave@nexuspuppet.test',
      'erin@nexuspuppet.test',
      // Same local part as dave, a different domain: what {username} cannot
      // tell apart, and the mail check must.
      'dave@elsewhere.test',
    ]) {
      await account(email);
    }

    const store = new SettingsStore(prisma, KEY, 'db');
    const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
    // Exactly what app.module builds on a deployment with no LDAP_* set.
    ldap = new LdapAuthProvider({
      config: null,
      directory: null,
      identities: new LocalUserDirectory(prisma),
      logger: silent,
      settings: new AuthSettingsResolver(store),
    });
    resolver = new AuthProviderResolver([new LocalAuthProvider(prisma), ldap], prisma, 50);
    settings = new SettingsService(
      store,
      prisma,
      new PrismaAuditSink(prisma),
      () => null,
      () => null,
      (candidate) => ldap.detectDialect(candidate),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe.each(TRANSPORTS)('over %s', (_name, transport) => {
    it('Regular: alice signs in with her email, as OPERATOR', async () => {
      await save({
        ...transport,
        bindType: 'regular',
        bindDn: `cn=svc-nexuspuppet,${BASE_DN}`,
        bindPassword: 'svc-password',
        searchFilter: '(&(objectClass=inetOrgPerson)(mail={{input}}))',
      });

      // Saved as the console saves: the RootDSE read said OpenLDAP.
      expect((await settings.describeLdap()).config?.detectedDialect).toBe('openldap');
      await expect(
        resolver.authenticate({ email: 'Alice@NexusPuppet.test', password: 'alice-password' }),
      ).resolves.toMatchObject({ ok: true, principal: { role: 'OPERATOR' } });
    });

    it('Anonymous: bob signs in with his email, as VIEWER', async () => {
      await save({
        ...transport,
        bindType: 'anonymous',
        searchFilter: '(&(objectClass=inetOrgPerson)(mail={{input}}))',
      });

      await expect(
        resolver.authenticate({ email: 'bob@nexuspuppet.test', password: 'bob-password' }),
      ).resolves.toMatchObject({ ok: true, principal: { role: 'VIEWER' } });
    });

    it('Simple uid={username}: dave signs in with his EMAIL and binds as uid=dave, ADMIN', async () => {
      await save({
        ...transport,
        bindType: 'simple',
        userDnPattern: `uid={username},ou=people,${BASE_DN}`,
      });

      await expect(
        resolver.authenticate({ email: ' Dave@NexusPuppet.test ', password: 'dave-password' }),
      ).resolves.toMatchObject({
        ok: true,
        principal: { role: 'ADMIN', email: 'dave@nexuspuppet.test', displayName: 'Dave Okafor' },
      });
    });

    it('Simple cn={email}: erin signs in with her email, bound by her full address, VIEWER', async () => {
      await save({
        ...transport,
        bindType: 'simple',
        userDnPattern: `cn={email},ou=people,${BASE_DN}`,
      });

      await expect(
        resolver.authenticate({ email: 'erin@nexuspuppet.test', password: 'erin-password' }),
      ).resolves.toMatchObject({ ok: true, principal: { role: 'VIEWER' } });
    });

    /**
     * dave@elsewhere.test also reaches uid=dave. Knowing dave's password must
     * not sign anybody in as the elsewhere account: the entry's mail says whose
     * it is.
     */
    it('Simple uid={username}: dave’s password does not open a same-named account elsewhere', async () => {
      await save({
        ...transport,
        bindType: 'simple',
        userDnPattern: `uid={username},ou=people,${BASE_DN}`,
      });

      await expect(
        resolver.authenticate({ email: 'dave@elsewhere.test', password: 'dave-password' }),
      ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    });

    it.each([
      ['a wrong password', 'dave@nexuspuppet.test', 'nope'],
      ['an empty password, which this server would accept', 'dave@nexuspuppet.test', ''],
      ['a DN hidden in the address', 'dave,ou=people@nexuspuppet.test', 'dave-password'],
      [
        'a second RDN value hidden in the address',
        'dave+cn=Dave Okafor@nexuspuppet.test',
        'dave-password',
      ],
    ])('Simple: %s is refused like a wrong password', async (_why, email, password) => {
      await save({
        ...transport,
        bindType: 'simple',
        userDnPattern: `uid={username},ou=people,${BASE_DN}`,
      });
      // The adversarial addresses need an account to reach the provider at all.
      await prisma.user.upsert({
        where: { email: email.trim().toLowerCase() },
        update: {},
        create: {
          email: email.trim().toLowerCase(),
          displayName: 'x',
          role: 'VIEWER',
          roleId: await roleIdFor(prisma, 'VIEWER'),
          authSource: 'ldap',
        },
      });

      await expect(resolver.authenticate({ email, password })).resolves.toEqual({
        ok: false,
        reason: 'INVALID_CREDENTIALS',
      });
    });

    it('Simple {email} against OpenLDAP: refused at Test, which says it needs AD', async () => {
      const result = await ldap.verifyConfiguration({
        ...transport,
        bindType: 'simple',
        userDnPattern: '{email}',
        searchBase: `ou=people,${BASE_DN}`,
        caPem: CA_PEM,
      });

      expect(result).toMatchObject({ ok: false, detectedDialect: 'openldap' });
      expect(result.message).toMatch(/only works against Active Directory/);
    });

    it('Anonymous over a subtree hidden from anonymous readers: named, not raw', async () => {
      const result = await ldap.verifyConfiguration({
        ...transport,
        bindType: 'anonymous',
        searchBase: `ou=groups,${BASE_DN}`,
        caPem: CA_PEM,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/search base was not found — or this directory hides it/);
      expect(result.details).toContainEqual({
        label: 'Directory said',
        value: expect.stringMatching(/NoSuchObject/i),
      });
    });
  });

  /**
   * An OpenLDAP that refuses ALL unauthenticated access (`olcRequires: authc`,
   * set on the fixture's TLS-less directory). Reached unencrypted here only
   * because that directory has no TLS; the console cannot save this.
   */
  it('Anonymous against a directory that requires authentication: the plain message', async () => {
    const result = await ldap.verifyConfiguration({
      host: '127.0.0.1',
      port: 3892,
      protocol: 'ldap',
      bindType: 'anonymous',
      searchBase: `ou=people,${BASE_DN}`,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(ANONYMOUS_REFUSED);
    expect(result.details).toContainEqual({
      label: 'Directory said',
      value: expect.stringMatching(/authentication required/),
    });
  });
});
