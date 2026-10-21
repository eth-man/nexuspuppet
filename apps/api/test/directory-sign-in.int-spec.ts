import { Logger } from '@nestjs/common';
import type { AuditRecord, AuditTransaction, IAuditSink } from '@nexuspuppet/contracts';
import { AuthProviderResolver } from '../src/auth/auth-provider.resolver';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { DirectoryAccountWriter } from '../src/auth/directory-accounts';
import { LocalAuthProvider, LocalUserDirectory } from '../src/auth/local-auth.provider';
import { hashPassword } from '../src/auth/password';
import { ldapConfigSchema } from '../src/directory/ldap/config';
import { LdapAuthProvider } from '../src/directory/ldap/ldap-auth.provider';
import type { LdapDirectory, LdapEntry } from '../src/directory/ldap/ldap-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { roleIdFor } from './support/roles';

/**
 * Directory-first sign-in (ADR-0031) against a REAL PostgreSQL: the migration,
 * the two unique constraints, and the transactions that keep each account
 * change and its audit row together.
 *
 * The directory is a fake — the real one is test/ldap/resolver-login.spec.ts.
 * What only a real database can show is here: that a user row and its audit
 * row commit together and roll back together, and that two first sign-ins of
 * one person at the same moment make one account and no 500.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const PASSWORD = 'directory-password';
const OPS = 'cn=ops,ou=groups,dc=corp,dc=local';
const JANE_ID = '931d4b8a-c0f5-4ae1-9b2a-6c7d8e9f0a1b';

/** Jane as a real AD has her: no mail (no Exchange), a .local UPN. */
const JANE: LdapEntry = {
  dn: 'CN=Jane Doe,OU=People,DC=corp,DC=local',
  email: null,
  displayName: 'Jane Doe',
  groupDns: [OPS],
  upn: 'jdoe@corp.local',
  username: 'jdoe',
  directoryId: JANE_ID,
};

function directory(entry: LdapEntry = JANE, delayMs = 0): LdapDirectory {
  const names = [entry.email, entry.upn, entry.username].filter(
    (n): n is string => typeof n === 'string',
  );
  return {
    findEntry: async (filter) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return names.some((n) => filter.includes(`=${n})`)) ? entry : null;
    },
    verifyCredentials: async (_dn, password) => password === PASSWORD,
    findGroupsContaining: async () => [],
    bindAndRead: async () => ({ bound: false }),
    detectDialect: async () => ({ dialect: 'ad', readAs: 'anonymous' }),
  };
}

/** The real sink, failing on demand AFTER the user row is written. */
class FailingAuditSink implements IAuditSink {
  fail = false;
  constructor(private readonly inner: IAuditSink) {}
  async record(entry: AuditRecord, tx?: AuditTransaction): Promise<string> {
    if (this.fail) throw new Error('audit write failed (test)');
    return this.inner.record(entry, tx);
  }
}

describe('Directory-first sign-in (integration)', () => {
  let prisma: PrismaService;
  let audit: FailingAuditSink;

  const resolverFor = (
    options: { autoCreate?: boolean; entry?: LdapEntry; delayMs?: number } = {},
  ): AuthProviderResolver => {
    const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
    const ldap = new LdapAuthProvider({
      config: ldapConfigSchema.parse({
        url: 'ldaps://dc01.corp.local:636',
        searchBase: 'dc=corp,dc=local',
        dialect: 'ad',
        roleMappings: [{ groupDn: OPS, role: 'OPERATOR' }],
        autoCreateAccounts: options.autoCreate ?? true,
      }),
      directory: directory(options.entry, options.delayMs),
      identities: new LocalUserDirectory(prisma),
      logger: silent,
    });
    return new AuthProviderResolver(
      [new LocalAuthProvider(prisma), ldap],
      prisma,
      0,
      new DirectoryAccountWriter(prisma, audit),
    );
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
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    audit = new FailingAuditSink(new PrismaAuditSink(prisma));
  });

  afterEach(() => jest.restoreAllMocks());

  it('has the column, nullable and unique, from the migration', async () => {
    const columns = await prisma.$queryRaw<Array<{ is_nullable: string; data_type: string }>>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'directoryId'`;
    expect(columns).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);

    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_directoryId_key'`;
    expect(indexes[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX .* \("directoryId"\)/);
  });

  it('refuses a second account with the same directory id — the database says so', async () => {
    const roleId = await roleIdFor(prisma, 'VIEWER');
    await prisma.user.create({
      data: {
        email: 'a@example.com',
        displayName: 'a',
        roleId,
        authSource: 'ldap',
        directoryId: JANE_ID,
      },
    });
    await expect(
      prisma.user.create({
        data: {
          email: 'b@example.com',
          displayName: 'b',
          roleId,
          authSource: 'ldap',
          directoryId: JANE_ID,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('creates the account and its audit row TOGETHER, by username, keyed by the UPN', async () => {
    const result = await resolverFor().authenticate(
      { email: 'JDOE', password: PASSWORD },
      { ipAddress: '10.1.2.3', userAgent: 'jest' },
    );

    expect(result).toMatchObject({ ok: true, principal: { email: 'jdoe@corp.local' } });
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: 'jdoe@corp.local',
      authSource: 'ldap',
      directoryId: JANE_ID,
      role: 'OPERATOR',
      roleId: await roleIdFor(prisma, 'OPERATOR'),
      passwordHash: null,
      isActive: true,
    });
    expect(users[0]?.lastLoginAt).not.toBeNull();

    const rows = await prisma.auditLog.findMany();
    expect(rows).toEqual([
      expect.objectContaining({
        actorUserId: null,
        actorEmail: 'directory:ldap',
        action: 'user.create',
        entityType: 'User',
        entityId: users[0]?.id,
        ipAddress: '10.1.2.3',
        after: expect.objectContaining({ directoryId: JANE_ID, via: 'directory-sign-in' }),
      }),
    ]);
  });

  it('rolls the account back with its audit row — nothing half-written', async () => {
    audit.fail = true;

    await expect(
      resolverFor().authenticate({ email: 'jdoe', password: PASSWORD }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('links an existing ldap account, with its audit row, and rolls the link back with it', async () => {
    const made = await prisma.user.create({
      data: {
        email: 'jdoe@corp.local',
        displayName: 'Jane',
        roleId: await roleIdFor(prisma, 'VIEWER'),
        authSource: 'ldap',
      },
    });

    audit.fail = true;
    await expect(
      resolverFor({ autoCreate: false }).authenticate({ email: 'jdoe', password: PASSWORD }),
    ).resolves.toMatchObject({ ok: false });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: made.id } })).directoryId,
    ).toBeNull();
    expect(await prisma.auditLog.count()).toBe(0);

    audit.fail = false;
    await expect(
      resolverFor({ autoCreate: false }).authenticate({ email: 'jdoe', password: PASSWORD }),
    ).resolves.toMatchObject({ ok: true, principal: { userId: made.id } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: made.id } })).directoryId).toBe(
      JANE_ID,
    );
    expect(await prisma.auditLog.findMany()).toEqual([
      expect.objectContaining({ action: 'user.directory.link', entityId: made.id }),
    ]);
  });

  it('two first sign-ins of one person at once: one account, no 500', async () => {
    /*
     * A barrier after each sign-in's last lookup: neither may write until both
     * have looked and found nothing. Without it the connection pool can
     * serialise them, the second finds the first's account, and the conflict
     * path this test is about never runs.
     */
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothLooked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identities = new LocalUserDirectory(prisma);
    const findByEmail = identities.findByEmail.bind(identities);
    identities.findByEmail = async (email) => {
      const found = await findByEmail(email);
      arrived += 1;
      if (arrived === 2) release();
      await bothLooked;
      return found;
    };
    const ldap = new LdapAuthProvider({
      config: ldapConfigSchema.parse({
        url: 'ldaps://dc01.corp.local:636',
        searchBase: 'dc=corp,dc=local',
        dialect: 'ad',
        roleMappings: [{ groupDn: OPS, role: 'OPERATOR' }],
        autoCreateAccounts: true,
      }),
      directory: directory(),
      identities,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const resolver = new AuthProviderResolver(
      [new LocalAuthProvider(prisma), ldap],
      prisma,
      0,
      new DirectoryAccountWriter(prisma, audit),
    );

    const results = await Promise.all([
      resolver.authenticate({ email: 'jdoe', password: PASSWORD }),
      resolver.authenticate({ email: 'jdoe@corp.local', password: PASSWORD }),
    ]);

    expect(await prisma.user.count()).toBe(1);
    const only = await prisma.user.findFirstOrThrow();
    for (const result of results) {
      expect(result).toMatchObject({ ok: true, principal: { userId: only.id } });
    }
    expect(await prisma.auditLog.count({ where: { action: 'user.create' } })).toBe(1);
    // The loser really did hit Postgres's unique constraint and recover from
    // it, rather than the two happening not to overlap.
    const said = (Logger.prototype.log as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(
      said.filter((line) => /by a concurrent sign-in; this one uses it/.test(line)),
    ).toHaveLength(1);
  });

  it('never links or opens a LOCAL account carrying the entry’s address', async () => {
    const local = await prisma.user.create({
      data: {
        email: 'jdoe@corp.local',
        displayName: 'Local Jane',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        role: 'ADMIN',
        authSource: 'local',
        passwordHash: await hashPassword('a-local-password-123'),
      },
    });

    await expect(
      resolverFor().authenticate({ email: 'jdoe', password: PASSWORD }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    // And typed by its own email, the directory password is refused by local.
    await expect(
      resolverFor().authenticate({ email: 'jdoe@corp.local', password: PASSWORD }),
    ).resolves.toMatchObject({ ok: false });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: local.id } });
    expect(after).toMatchObject({ directoryId: null, authSource: 'local', lastLoginAt: null });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});
