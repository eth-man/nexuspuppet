import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ldapSettingsSchema, type LdapSettings } from '@nexuspuppet/contracts';
import { Attribute, Change, Client } from 'ldapts';
import { AuthProviderResolver } from '../../src/auth/auth-provider.resolver';
import type { AuthenticatedRequest } from '../../src/auth/auth.guard';
import { PrismaAuditSink } from '../../src/auth/core-capabilities';
import { DirectoryAccountWriter } from '../../src/auth/directory-accounts';
import { LocalAuthProvider, LocalUserDirectory } from '../../src/auth/local-auth.provider';
import { hashPassword } from '../../src/auth/password';
import { LdapAuthProvider } from '../../src/directory/ldap/ldap-auth.provider';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuthSettingsResolver } from '../../src/settings/auth-settings.resolver';
import { SettingsService } from '../../src/settings/settings.service';
import { SettingsStore } from '../../src/settings/settings.store';
import { roleIdFor } from '../support/roles';

/**
 * Directory-first sign-in (ADR-0031) against the REAL OpenLDAP, through the
 * REAL resolver with the account writer app.module gives it, and a real
 * Postgres — settings saved the way the console saves them.
 *
 * What the report that drove ADR-0031 needed, end to end: a person signs in
 * with their USERNAME; the directory is asked first; the account is the one
 * linked to their entry by its entryUUID — created at first sign-in where that
 * is turned on — and a local account is never reachable with their directory
 * password.
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
const ADMIN_DN = `cn=admin,${BASE_DN}`;
const ADMIN_PASSWORD = 'test-admin-password';

const MAPPINGS = [
  { groupDn: `cn=ops,ou=groups,${BASE_DN}`, role: 'OPERATOR' },
  { groupDn: `cn=viewers,ou=groups,${BASE_DN}`, role: 'VIEWER' },
  { groupDn: `cn=puppet-admins,ou=groups,${BASE_DN}`, role: 'ADMIN' },
];

/** The fixture's own administrator, for reading entryUUID and renaming mail. */
async function asDirectoryAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ url: `ldap://${HOST}:3890` });
  try {
    await client.bind(ADMIN_DN, ADMIN_PASSWORD);
    return await work(client);
  } finally {
    await client.unbind();
  }
}

async function entryUuidOf(uid: string): Promise<string> {
  return asDirectoryAdmin(async (client) => {
    const { searchEntries } = await client.search(`uid=${uid},ou=people,${BASE_DN}`, {
      scope: 'base',
      attributes: ['entryUUID'],
    });
    const value = searchEntries[0]?.['entryUUID'];
    if (typeof value !== 'string') throw new Error(`no entryUUID for ${uid}`);
    return value.toLowerCase();
  });
}

async function setMail(uid: string, mail: string): Promise<void> {
  await asDirectoryAdmin((client) =>
    client.modify(
      `uid=${uid},ou=people,${BASE_DN}`,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'mail', values: [mail] }),
      }),
    ),
  );
}

describe('directory-first sign-in against the real directory', () => {
  let prisma: PrismaService;
  let resolver: AuthProviderResolver;
  let settings: SettingsService;
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

  /**
   * Regular bind over LDAPS, as the console saves it — with NO search filter,
   * so the OpenLDAP default (uid or mail) applies, as on a fresh deployment.
   */
  const save = async (body: Record<string, unknown> = {}): Promise<void> => {
    await settings.saveLdap(
      ldapSettingsSchema.parse({
        host: HOST,
        port: 6360,
        protocol: 'ldaps',
        bindType: 'regular',
        bindDn: `cn=svc-nexuspuppet,${BASE_DN}`,
        bindPassword: 'svc-password',
        searchBase: `ou=people,${BASE_DN}`,
        roleMappings: MAPPINGS,
        caPem: CA_PEM,
        timeoutMs: 5000,
        ...body,
      }) as LdapSettings,
      request(),
    );
  };

  const ldapAccount = async (email: string): Promise<{ id: string }> =>
    prisma.user.create({
      data: {
        email,
        displayName: email,
        role: 'VIEWER',
        roleId: await roleIdFor(prisma, 'VIEWER'),
        authSource: 'ldap',
      },
    });

  const directoryUsers = async () =>
    prisma.user.findMany({ where: { authSource: { not: 'local' } }, orderBy: { email: 'asc' } });

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

    const store = new SettingsStore(prisma, KEY, 'db');
    const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
    // Exactly what app.module builds on a deployment with no LDAP_* set.
    const ldap = new LdapAuthProvider({
      config: null,
      directory: null,
      identities: new LocalUserDirectory(prisma),
      logger: silent,
      settings: new AuthSettingsResolver(store),
    });
    resolver = new AuthProviderResolver(
      [new LocalAuthProvider(prisma), ldap],
      prisma,
      50,
      new DirectoryAccountWriter(prisma, new PrismaAuditSink(prisma)),
    );
    settings = new SettingsService(
      store,
      prisma,
      new PrismaAuditSink(prisma),
      () => null,
      () => null,
      (candidate) => ldap.verifyConfiguration(candidate),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('alice signs in by USERNAME with no account: created, linked by entryUUID, OPERATOR', async () => {
    await save({ autoCreateAccounts: true });

    const first = await resolver.authenticate({ email: 'alice', password: 'alice-password' });

    expect(first).toMatchObject({
      ok: true,
      principal: { email: 'alice@nexuspuppet.test', role: 'OPERATOR', displayName: 'Alice Ng' },
    });
    const [alice] = await directoryUsers();
    expect(alice).toMatchObject({
      email: 'alice@nexuspuppet.test',
      authSource: 'ldap',
      role: 'OPERATOR',
      roleId: await roleIdFor(prisma, 'OPERATOR'),
      directoryId: await entryUuidOf('alice'),
      passwordHash: null,
    });
    expect(await prisma.auditLog.findMany({ where: { action: 'user.create' } })).toEqual([
      expect.objectContaining({
        actorUserId: null,
        actorEmail: 'directory:ldap',
        entityId: alice?.id,
      }),
    ]);

    // Again, by MAIL this time: the same account, nothing new written.
    const second = await resolver.authenticate({
      email: 'Alice@NexusPuppet.test',
      password: 'alice-password',
    });
    expect(second).toMatchObject({ ok: true, principal: { userId: alice?.id } });
    expect(await directoryUsers()).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'user.' } } })).toBe(1);
  });

  it('the link survives the entry’s mail changing — the account follows entryUUID', async () => {
    await save({ autoCreateAccounts: true });
    const first = await resolver.authenticate({ email: 'alice', password: 'alice-password' });
    expect(first.ok).toBe(true);

    await setMail('alice', 'alice.renamed@nexuspuppet.test');
    try {
      const after = await resolver.authenticate({ email: 'alice', password: 'alice-password' });
      expect(after).toMatchObject({
        ok: true,
        principal: { userId: first.ok ? first.principal.userId : 'none' },
      });
      // Still one account, and still the address it was created with.
      expect(await directoryUsers()).toEqual([
        expect.objectContaining({ email: 'alice@nexuspuppet.test' }),
      ]);
    } finally {
      await setMail('alice', 'alice@nexuspuppet.test');
    }
  });

  it('carol authenticates but is in no mapped group: refused, nothing created', async () => {
    await save({ autoCreateAccounts: true });

    await expect(
      resolver.authenticate({ email: 'carol', password: 'carol-password' }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(await directoryUsers()).toEqual([]);
  });

  it('automatic creation OFF: bob with no account is refused, nothing created', async () => {
    await save();

    await expect(
      resolver.authenticate({ email: 'bob', password: 'bob-password' }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(await directoryUsers()).toEqual([]);
  });

  it('a manually created account is LINKED on first sign-in by username, then found by the link', async () => {
    await save();
    const made = await ldapAccount('bob@nexuspuppet.test');

    await expect(
      resolver.authenticate({ email: 'bob', password: 'bob-password' }),
    ).resolves.toMatchObject({ ok: true, principal: { userId: made.id, role: 'VIEWER' } });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: made.id } })).directoryId).toBe(
      await entryUuidOf('bob'),
    );
    expect(await prisma.auditLog.findMany({ where: { action: 'user.directory.link' } })).toEqual([
      expect.objectContaining({ actorEmail: 'directory:ldap', entityId: made.id }),
    ]);
  });

  it('an account whose email is NOT the mail links when the directory vouches for that address', async () => {
    // Henry: the account was made with his "UPN", henry@corp.local; his mail
    // is henry.hart@…. The filter matches cn, which plays UPN here.
    await save({
      searchFilter:
        '(&(objectClass=inetOrgPerson)(|(uid={{input}})(cn={{input}})(mail={{input}})))',
    });
    const made = await ldapAccount('henry@corp.local');

    await expect(
      resolver.authenticate({ email: 'henry@corp.local', password: 'henry-password' }),
    ).resolves.toMatchObject({ ok: true, principal: { userId: made.id } });
    // From now on his username is enough: the link, not an address, finds it.
    await expect(
      resolver.authenticate({ email: 'henry', password: 'henry-password' }),
    ).resolves.toMatchObject({ ok: true, principal: { userId: made.id } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: made.id } })).directoryId).toBe(
      await entryUuidOf('henry'),
    );
  });

  it('a LOCAL account carrying a directory user’s mail is never linked nor opened by the directory password', async () => {
    await save({ autoCreateAccounts: true });
    const local = await prisma.user.create({
      data: {
        email: 'dave@nexuspuppet.test',
        displayName: 'Local Dave',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        authSource: 'local',
        passwordHash: await hashPassword('a-separate-local-password'),
      },
    });

    // By username: the directory says dave, whose mail is that local account.
    await expect(
      resolver.authenticate({ email: 'dave', password: 'dave-password' }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    // By the address itself: local only, and the directory password is wrong there.
    await expect(
      resolver.authenticate({ email: 'dave@nexuspuppet.test', password: 'dave-password' }),
    ).resolves.toMatchObject({ ok: false });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: local.id } })).toMatchObject({
      authSource: 'local',
      directoryId: null,
      lastLoginAt: null,
    });
    expect(await directoryUsers()).toEqual([]);
    // Its own password still works, through the local provider.
    await expect(
      resolver.authenticate({
        email: 'dave@nexuspuppet.test',
        password: 'a-separate-local-password',
      }),
    ).resolves.toMatchObject({ ok: true, principal: { userId: local.id, authSource: 'local' } });
  });

  it('frank’s "UPN" is also grace’s mail: an ambiguous address links nothing', async () => {
    await save({
      searchFilter:
        '(&(objectClass=inetOrgPerson)(|(uid={{input}})(cn={{input}})(mail={{input}})))',
    });
    const made = await ldapAccount('frank@corp.local');

    // Typed: the search finds two entries and refuses.
    await expect(
      resolver.authenticate({ email: 'frank@corp.local', password: 'frank-password' }),
    ).resolves.toMatchObject({ ok: false });
    // By grace's username: her mail is that address, but it does not name her
    // alone, so the account made for it is not linked to her.
    await expect(
      resolver.authenticate({ email: 'grace', password: 'grace-password' }),
    ).resolves.toMatchObject({ ok: false });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: made.id } })).directoryId,
    ).toBeNull();
  });

  it('a wrong password and a name nobody has both take the floor and say nothing different', async () => {
    await save({ autoCreateAccounts: true });

    for (const [email, password] of [
      ['alice', 'wrong-password'],
      ['nobody-at-all', 'whatever'],
    ] as const) {
      const started = Date.now();
      await expect(resolver.authenticate({ email, password })).resolves.toEqual({
        ok: false,
        reason: 'INVALID_CREDENTIALS',
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    }
    expect(await directoryUsers()).toEqual([]);
  });
});
