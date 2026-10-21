import { Logger } from '@nestjs/common';
import type { AuthResult, Credentials, IAuthProvider } from '@nexuspuppet/contracts';
import { ldapConfigSchema, type LdapConfig } from '../directory/ldap/config';
import { LdapAuthProvider } from '../directory/ldap/ldap-auth.provider';
import {
  LdapUnavailableError,
  type LdapDirectory,
  type LdapEntry,
} from '../directory/ldap/ldap-client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthProviderResolver } from './auth-provider.resolver';
import { PrismaAuditSink } from './core-capabilities';
import { DIRECTORY_SIGN_IN_VIA, DirectoryAccountWriter } from './directory-accounts';
import { LocalUserDirectory } from './local-auth.provider';

/**
 * Directory-first sign-in (ADR-0031) through the REAL resolver, the REAL LDAP
 * provider and the REAL account writer — only the directory and the database
 * are fakes.
 *
 * The fake database keeps transactions honest: a write inside `$transaction`
 * is rolled back when the callback throws, and every write records whether it
 * happened inside one. "The account and its audit row are one transaction" is
 * asserted, not assumed. A "concurrent" write made from a hook commits on its
 * own, as another transaction's would, and survives this one's rollback.
 */

const PASSWORD = 'pw-THAT-must-NEVER-be-logged-7731';

const OPS = 'cn=ops,ou=groups,dc=corp,dc=local';
const ADMINS = 'cn=puppet-admins,ou=groups,dc=corp,dc=local';
const ALICE_ID = '931d4b8a-c0f5-4ae1-9b2a-6c7d8e9f0a1b';

function config(overrides: Record<string, unknown> = {}): LdapConfig {
  return ldapConfigSchema.parse({
    url: 'ldaps://dc01.corp.local:636',
    searchBase: 'ou=people,dc=corp,dc=local',
    roleMappings: [
      { groupDn: ADMINS, role: 'ADMIN' },
      { groupDn: OPS, role: 'OPERATOR' },
    ],
    ...overrides,
  });
}

/** Alice as a real AD has her: mail on .com, UPN on .local, a username. */
const ALICE: LdapEntry = {
  dn: 'CN=Alice Ng,OU=People,DC=corp,DC=local',
  email: 'alice@example.com',
  displayName: 'Alice Ng',
  groupDns: [OPS],
  upn: 'alice@corp.local',
  username: 'alice',
  directoryId: ALICE_ID,
};

/** A directory holding one person, found by any of their names; calls counted. */
function fakeDirectory(
  entry: LdapEntry = ALICE,
  overrides: Partial<LdapDirectory> = {},
): LdapDirectory & { calls: string[] } {
  const calls: string[] = [];
  const names = [entry.email, entry.upn, entry.username].filter(
    (n): n is string => typeof n === 'string',
  );
  const base: LdapDirectory = {
    findEntry: async (filter) => {
      calls.push(`find ${filter}`);
      return names.some((name) => filter.includes(`=${name})`)) ? entry : null;
    },
    verifyCredentials: async (dn, password) => {
      calls.push(`bind ${dn}`);
      return password === PASSWORD;
    },
    findGroupsContaining: async () => [],
    bindAndRead: async (identity, password) => {
      calls.push(`bindAndRead ${identity}`);
      return password === PASSWORD ? { bound: true, entry, nestedGroups: null } : { bound: false };
    },
    detectDialect: async () => ({ dialect: 'ad', readAs: 'anonymous' }),
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  roleId: string;
  authSource: string;
  isActive: boolean;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  directoryId: string | null;
}

interface AuditRow {
  data: Record<string, unknown>;
  inTransaction: boolean;
}

const unique = (field: string): Error =>
  Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), {
    code: 'P2002',
  });

/** Just enough Postgres: users, roles, audit rows, two unique columns, rollback. */
class FakeDb {
  users: UserRow[] = [];
  audit: AuditRow[] = [];
  readonly roles = [
    { id: 'role-admin', name: 'ADMIN' },
    { id: 'role-operator', name: 'OPERATOR' },
    { id: 'role-viewer', name: 'VIEWER' },
  ];
  transactions = 0;
  /** Each insert of a user, and whether it happened inside a transaction. */
  userCreates: boolean[] = [];
  /** Runs just before a user is inserted or linked: a concurrent sign-in. */
  beforeWrite: (() => void) | null = null;
  failAudit = false;
  inTransaction = false;
  /** What THIS transaction wrote — all a rollback may take back. */
  createdInTransaction: string[] = [];
  linkedInTransaction: string[] = [];
  private nextId = 1;

  add(row: Partial<UserRow> & { email: string; authSource: string }): UserRow {
    const full: UserRow = {
      id: `user-${String(this.nextId++)}`,
      displayName: row.email,
      role: 'VIEWER',
      roleId: 'role-viewer',
      isActive: true,
      passwordHash: null,
      lastLoginAt: null,
      directoryId: null,
      ...row,
    };
    this.users.push(full);
    return full;
  }

  byEmail(email: string): UserRow | undefined {
    return this.users.find((u) => u.email === email);
  }

  concurrent(): void {
    const hook = this.beforeWrite;
    this.beforeWrite = null;
    hook?.();
  }

  client(): PrismaService {
    return fakeClient(this);
  }
}

/** A Prisma-shaped client over the fake's rows. */
function fakeClient(db: FakeDb): PrismaService {
  type Where = { email?: string; id?: string; directoryId?: string };
  const matches = (u: UserRow, where: Where): boolean =>
    where.email !== undefined
      ? u.email === where.email
      : where.directoryId !== undefined
        ? u.directoryId === where.directoryId
        : u.id === where.id;
  const user = {
    findUnique: async ({ where }: { where: Where }) =>
      db.users.find((u) => matches(u, where)) ?? null,
    create: async ({ data }: { data: Omit<UserRow, 'id' | 'lastLoginAt'> }) => {
      db.concurrent();
      db.userCreates.push(db.inTransaction);
      if (db.users.some((u) => u.email === data.email)) throw unique('email');
      if (data.directoryId !== null && db.users.some((u) => u.directoryId === data.directoryId)) {
        throw unique('directoryId');
      }
      const row = db.add({ ...data, lastLoginAt: null });
      if (db.inTransaction) db.createdInTransaction.push(row.id);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; authSource: string; directoryId: null };
      data: { directoryId: string };
    }) => {
      db.concurrent();
      const row = db.users.find(
        (u) => u.id === where.id && u.authSource === where.authSource && u.directoryId === null,
      );
      if (row === undefined) return { count: 0 };
      if (db.users.some((u) => u.directoryId === data.directoryId)) throw unique('directoryId');
      row.directoryId = data.directoryId;
      if (db.inTransaction) db.linkedInTransaction.push(row.id);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      const row = db.users.find((u) => u.id === where.id);
      if (row === undefined) throw new Error('no such user');
      Object.assign(row, data);
      return row;
    },
  };
  const role = {
    findUnique: async ({ where }: { where: { name: string } }) =>
      db.roles.find((r) => r.name === where.name) ?? null,
  };
  const auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (db.failAudit) throw new Error('audit write failed');
      db.audit.push({ data, inTransaction: db.inTransaction });
      return { id: `audit-${String(db.audit.length)}` };
    },
  };
  const client = {
    user,
    role,
    auditLog,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      db.transactions += 1;
      const auditBefore = db.audit.length;
      db.createdInTransaction = [];
      db.linkedInTransaction = [];
      db.inTransaction = true;
      try {
        return await fn(client);
      } catch (error) {
        // Only what THIS transaction wrote is taken back.
        const created = new Set(db.createdInTransaction);
        db.users = db.users.filter((u) => !created.has(u.id));
        for (const id of db.linkedInTransaction) {
          const row = db.users.find((u) => u.id === id);
          if (row !== undefined) row.directoryId = null;
        }
        db.audit = db.audit.slice(0, auditBefore);
        throw error;
      } finally {
        db.inTransaction = false;
      }
    },
  };
  return client as unknown as PrismaService;
}

/** A local provider that refuses everybody, and says it was asked. */
function localProvider(): IAuthProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    source: 'local',
    asked,
    authenticate: async (credentials: Credentials): Promise<AuthResult> => {
      asked.push(credentials.email);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    },
    resolve: async () => null,
  };
}

interface Env {
  db: FakeDb;
  resolver: AuthProviderResolver;
  directory: LdapDirectory & { calls: string[] };
  lines: string[];
  local: IAuthProvider & { asked: string[] };
}

function setup(
  parts: {
    config?: LdapConfig;
    directory?: LdapDirectory & { calls: string[] };
    floorMs?: number;
    withWriter?: boolean;
  } = {},
): Env {
  const db = new FakeDb();
  const prisma = db.client();
  const lines: string[] = [];
  const capture = (m: string): void => {
    lines.push(m);
  };
  const directory = parts.directory ?? fakeDirectory();
  const local = localProvider();
  const ldap = new LdapAuthProvider({
    config: parts.config ?? config(),
    directory,
    identities: new LocalUserDirectory(prisma),
    logger: { log: capture, warn: capture, error: capture },
  });
  const resolver = new AuthProviderResolver(
    [local, ldap],
    prisma,
    parts.floorMs ?? 0,
    parts.withWriter === false
      ? null
      : new DirectoryAccountWriter(prisma, new PrismaAuditSink(prisma)),
  );
  return { db, resolver, directory, lines, local };
}

const as = (identifier: string, password = PASSWORD): Credentials => ({
  email: identifier,
  password,
});

const CONTEXT = { ipAddress: '10.0.0.9', userAgent: 'jest' };
const AUTO = config({ autoCreateAccounts: true });
const REFUSED = { ok: false, reason: 'INVALID_CREDENTIALS' };

describe('Directory-first sign-in (ADR-0031)', () => {
  /** Every line the Nest loggers write, so nothing escapes the password check. */
  const nest: string[] = [];

  beforeEach(() => {
    nest.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => nest.push(String(args[0])));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('created at first sign-in (turned on)', () => {
    it('by USERNAME: one account, keyed by the entry’s mail, linked, audited, one transaction', async () => {
      const { db, resolver } = setup({ config: AUTO });

      const result = await resolver.authenticate(as('Alice'), CONTEXT);

      expect(result).toMatchObject({
        ok: true,
        principal: { email: 'alice@example.com', role: 'OPERATOR', authSource: 'ldap' },
      });
      expect(db.users).toHaveLength(1);
      const [user] = db.users;
      expect(user).toMatchObject({
        email: 'alice@example.com',
        displayName: 'Alice Ng',
        role: 'OPERATOR',
        // Both columns, consistent: the drift ADR-0018 §1 warns about.
        roleId: 'role-operator',
        authSource: 'ldap',
        directoryId: ALICE_ID,
        isActive: true,
        passwordHash: null,
      });
      // Then an ordinary LDAP login: recordLogin stamped it.
      expect(user?.lastLoginAt).toBeInstanceOf(Date);
      if (result.ok) expect(result.principal.userId).toBe(user?.id);

      expect(db.audit).toHaveLength(1);
      expect(db.audit[0]?.data).toMatchObject({
        actorUserId: null,
        actorEmail: 'directory:ldap',
        action: 'user.create',
        entityType: 'User',
        entityId: user?.id,
        after: {
          email: 'alice@example.com',
          role: 'OPERATOR',
          authSource: 'ldap',
          directoryId: ALICE_ID,
          via: DIRECTORY_SIGN_IN_VIA,
        },
        ipAddress: '10.0.0.9',
        userAgent: 'jest',
      });
      expect(db.transactions).toBe(1);
      expect(db.userCreates).toEqual([true]);
      expect(db.audit[0]?.inTransaction).toBe(true);
    });

    it('then by mail, and by UPN, opens the SAME account and writes nothing', async () => {
      const { db, resolver } = setup({ config: AUTO });

      await resolver.authenticate(as('alice'));
      const byMail = await resolver.authenticate(as('alice@example.com'));
      const byUpn = await resolver.authenticate(as('ALICE@corp.local'));

      expect(byMail).toMatchObject({ ok: true, principal: { email: 'alice@example.com' } });
      expect(byUpn).toMatchObject({ ok: true, principal: { email: 'alice@example.com' } });
      expect(db.users).toHaveLength(1);
      expect(db.audit).toHaveLength(1);
    });

    it('keys the account by the UPN when mail is empty (no Exchange)', async () => {
      const directory = fakeDirectory({ ...ALICE, email: null });
      const { db, resolver } = setup({ config: AUTO, directory });

      await expect(resolver.authenticate(as('alice'))).resolves.toMatchObject({ ok: true });
      expect(db.users[0]?.email).toBe('alice@corp.local');
    });

    it('refuses, creating nothing, an entry with no address to key an account by', async () => {
      const directory = fakeDirectory({ ...ALICE, email: null, upn: null });
      const { db, resolver, lines } = setup({ config: AUTO, directory });

      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(db.users).toHaveLength(0);
      expect(lines.join('\n')).toMatch(/no email address \(mail or userPrincipalName\)/);
    });

    it('gives the primary role when several mapped groups apply', async () => {
      const directory = fakeDirectory({ ...ALICE, groupDns: [OPS, ADMINS] });
      const { db, resolver } = setup({ config: AUTO, directory });

      await expect(resolver.authenticate(as('alice'))).resolves.toMatchObject({
        ok: true,
        principal: { role: 'ADMIN' },
      });
      expect(db.users[0]).toMatchObject({ role: 'ADMIN', roleId: 'role-admin' });
    });

    it('works through Simple bind with {username} — the same code path', async () => {
      const directory = fakeDirectory();
      const { db, resolver } = setup({
        config: config({
          autoCreateAccounts: true,
          bindType: 'simple',
          userDnPattern: '{username}@corp.local',
        }),
        directory,
      });

      await expect(resolver.authenticate(as('alice'))).resolves.toMatchObject({ ok: true });
      expect(db.users).toHaveLength(1);
      expect(directory.calls).toEqual(['bindAndRead alice@corp.local']);
    });
  });

  describe('linked at sign-in', () => {
    it('links an existing ldap account whose email is the entry’s mail — signing in by username', async () => {
      const { db, resolver } = setup();
      const made = db.add({ email: 'alice@example.com', authSource: 'ldap' });

      const result = await resolver.authenticate(as('alice'), CONTEXT);

      expect(result).toMatchObject({ ok: true, principal: { userId: made.id } });
      expect(made.directoryId).toBe(ALICE_ID);
      expect(db.audit).toHaveLength(1);
      expect(db.audit[0]).toMatchObject({
        inTransaction: true,
        data: {
          actorUserId: null,
          actorEmail: 'directory:ldap',
          action: 'user.directory.link',
          entityId: made.id,
          before: { directoryId: null },
          after: { email: 'alice@example.com', directoryId: ALICE_ID, via: DIRECTORY_SIGN_IN_VIA },
        },
      });
      expect(db.userCreates).toEqual([]);
    });

    it('links by UPN too, and then finds the account by the link alone', async () => {
      const { db, resolver } = setup();
      const made = db.add({ email: 'alice@corp.local', authSource: 'ldap' });

      await resolver.authenticate(as('alice'));
      // The entry's addresses no longer matter: the link does.
      made.email = 'renamed@example.com';
      const again = await resolver.authenticate(as('alice'));

      expect(again).toMatchObject({ ok: true, principal: { userId: made.id } });
      expect(db.audit).toHaveLength(1);
    });

    it('keeps working for an account found by the typed email — and links it', async () => {
      const { db, resolver } = setup();
      const made = db.add({ email: 'alice@example.com', authSource: 'ldap' });

      await expect(resolver.authenticate(as('alice@example.com'))).resolves.toMatchObject({
        ok: true,
      });
      expect(made.directoryId).toBe(ALICE_ID);
    });

    it.each([
      ['also matches another entry', 'ambiguous'],
      ['finds a different entry', 'other'],
      ['finds nothing through the search', 'none'],
    ])('does not link by a mail the person did not type when it %s', async (_name, answer) => {
      const BOB: LdapEntry = { ...ALICE, dn: 'CN=Bob,DC=corp,DC=local', directoryId: null };
      const inner = fakeDirectory();
      const directory = {
        ...inner,
        findEntry: async (filter: string) => {
          if (!filter.includes('=alice@example.com)')) return inner.findEntry(filter);
          if (answer === 'ambiguous') {
            throw new LdapUnavailableError('More than one directory entry carries this name.');
          }
          return answer === 'other' ? BOB : null;
        },
      };
      const { db, resolver, lines } = setup({ config: AUTO, directory });
      const made = db.add({ email: 'alice@example.com', authSource: 'ldap' });

      // By username: the mail is unproven, so not used — and creation then
      // collides with that account's email, so nothing is created either.
      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(made.directoryId).toBeNull();
      expect(db.users).toHaveLength(1);
      expect(lines.join('\n')).toMatch(/does not identify only that entry/);
    });

    it('never re-links an account linked to a DIFFERENT entry', async () => {
      const { db, resolver, lines } = setup();
      const other = db.add({
        email: 'alice@example.com',
        authSource: 'ldap',
        directoryId: '00000000-0000-4000-8000-000000000000',
      });

      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(other.directoryId).toBe('00000000-0000-4000-8000-000000000000');
      expect(db.audit).toHaveLength(0);
      expect(lines.join('\n')).toMatch(/linked to a different directory entry/);
    });

    it('a concurrent sign-in that linked the same account first is fine', async () => {
      const { db, resolver } = setup();
      const made = db.add({ email: 'alice@example.com', authSource: 'ldap' });
      db.beforeWrite = () => {
        made.directoryId = ALICE_ID;
      };

      await expect(resolver.authenticate(as('alice'))).resolves.toMatchObject({
        ok: true,
        principal: { userId: made.id },
      });
      expect(db.audit).toHaveLength(0);
    });
  });

  describe('a LOCAL account is never reachable with a directory password', () => {
    it('typed by its own email: the local provider only — the directory is never asked', async () => {
      const { db, resolver, directory, local } = setup({ config: AUTO });
      db.add({ email: 'alice@example.com', authSource: 'local', passwordHash: 'scrypt$x' });

      await expect(resolver.authenticate(as('alice@example.com'))).resolves.toEqual(REFUSED);
      expect(local.asked).toEqual(['alice@example.com']);
      expect(directory.calls).toEqual([]);
    });

    it('reached by username: not linked, not opened, and nothing created over it', async () => {
      const { db, resolver, lines } = setup({ config: AUTO });
      const localAccount = db.add({
        email: 'alice@example.com',
        authSource: 'local',
        passwordHash: 'scrypt$x',
      });

      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(db.users).toEqual([localAccount]);
      expect(localAccount).toMatchObject({ directoryId: null, lastLoginAt: null });
      expect(db.audit).toHaveLength(0);
      expect(lines.join('\n')).toMatch(/is a "local" account, which is never linked/);
      expect(nest.join('\n')).toMatch(/already exists \(authSource "local"\)/);
    });
  });

  describe('refused, writing nothing, with the same answer as a wrong password', () => {
    const refusedCleanly = async (
      parts: Parameters<typeof setup>[0],
      credentials: Credentials,
    ): Promise<Env> => {
      const env = setup(parts);
      await expect(env.resolver.authenticate(credentials, CONTEXT)).resolves.toEqual(REFUSED);
      expect(env.db.users.filter((u) => u.directoryId !== null)).toEqual([]);
      expect(env.db.audit).toHaveLength(0);
      expect(env.db.userCreates).toEqual([]);
      return env;
    };

    it('no account, none linkable, automatic creation off — but the directory WAS asked', async () => {
      const { lines, directory } = await refusedCleanly({}, as('alice'));
      expect(directory.calls.length).toBeGreaterThan(0);
      expect(lines.join('\n')).toMatch(
        /no NexusPuppet account is linked to that entry or carries one of its addresses \(alice@example\.com, alice@corp\.local\)/,
      );
    });

    it('a wrong password', async () => {
      const { lines } = await refusedCleanly({ config: AUTO }, as('alice', 'wrong'));
      expect(lines.join('\n')).toMatch(/directory rejected the password/);
    });

    it('no such entry', async () => {
      const { lines } = await refusedCleanly({ config: AUTO }, as('nobody'));
      expect(lines.join('\n')).toMatch(/no directory entry matched/);
    });

    it('authenticated, but in no mapped group', async () => {
      const directory = fakeDirectory({ ...ALICE, groupDns: ['cn=contractors,dc=corp,dc=local'] });
      const { lines } = await refusedCleanly({ config: AUTO, directory }, as('alice'));
      expect(lines.join('\n')).toMatch(
        /authenticated as .*, but member of no mapped group — no account linked or created/,
      );
    });

    it('the directory unreachable — INVALID_CREDENTIALS, not a distinguishable error', async () => {
      const directory = fakeDirectory(ALICE, {
        findEntry: async () => {
          throw new LdapUnavailableError('connect ECONNREFUSED 10.0.0.5:636');
        },
      });
      const { lines } = await refusedCleanly({ config: AUTO, directory }, as('alice'));
      expect(lines.join('\n')).toMatch(/LDAP authentication error .*ECONNREFUSED/);
    });

    it('their group maps to a role this deployment does not define', async () => {
      await refusedCleanly(
        {
          config: config({ autoCreateAccounts: true, roleMappings: [{ groupDn: OPS, role: 'X' }] }),
        },
        as('alice'),
      );
      expect(nest.join('\n')).toMatch(/maps to the role "X", which this deployment does not/);
    });

    it('the directory hides the entry’s stable id — nothing created without a link', async () => {
      const directory = fakeDirectory({ ...ALICE, directoryId: null });
      const { lines } = await refusedCleanly({ config: AUTO, directory }, as('alice'));
      expect(lines.join('\n')).toMatch(/did not return its stable id \(entryUUID\)/);
    });

    it('a typed address that is not the entry’s own, with Simple {username}', async () => {
      const { lines } = await refusedCleanly(
        {
          config: config({
            autoCreateAccounts: true,
            bindType: 'simple',
            userDnPattern: '{username}@corp.local',
          }),
        },
        as('alice@elsewhere.example'),
      );
      expect(lines.join('\n')).toMatch(/not the one signed in with/);
    });
  });

  it('the audit row cannot be written — the account is rolled back with it', async () => {
    const { db, resolver } = setup({ config: AUTO });
    db.failAudit = true;

    await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
    expect(db.userCreates).toEqual([true]);
    expect(db.users).toHaveLength(0);
  });

  it('the audit row cannot be written — the link is rolled back with it', async () => {
    const { db, resolver } = setup();
    const made = db.add({ email: 'alice@example.com', authSource: 'ldap' });
    db.failAudit = true;

    await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
    expect(made.directoryId).toBeNull();
  });

  it('falls back to the account by address, unlinked, when the directory hides the id', async () => {
    const directory = fakeDirectory({ ...ALICE, directoryId: null });
    const { db, resolver, lines } = setup({ directory });
    const made = db.add({ email: 'alice@example.com', authSource: 'ldap' });

    await expect(resolver.authenticate(as('alice'))).resolves.toMatchObject({ ok: true });
    expect(made.directoryId).toBeNull();
    expect(db.audit).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/used without being linked/);
  });

  describe('a deactivated account', () => {
    it('linked: refused, never recreated or reactivated', async () => {
      const { db, resolver } = setup({ config: AUTO });
      const gone = db.add({
        email: 'alice@example.com',
        authSource: 'ldap',
        directoryId: ALICE_ID,
        isActive: false,
      });

      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(db.users).toEqual([gone]);
      expect(gone.isActive).toBe(false);
      expect(db.audit).toHaveLength(0);
    });

    it('not yet linked: refused, and not linked either', async () => {
      const { db, resolver } = setup({ config: AUTO });
      const gone = db.add({ email: 'alice@example.com', authSource: 'ldap', isActive: false });

      await expect(resolver.authenticate(as('alice@example.com'))).resolves.toMatchObject({
        ok: false,
      });
      expect(gone).toMatchObject({ isActive: false, directoryId: null });
      expect(db.userCreates).toEqual([]);
    });
  });

  describe('concurrent first sign-ins (the unique email and directory id)', () => {
    it('uses the account the other sign-in created — no 500, no second row', async () => {
      const { db, resolver } = setup({ config: AUTO });
      db.beforeWrite = () => {
        db.add({ email: 'alice@example.com', authSource: 'ldap', directoryId: ALICE_ID });
      };

      const result = await resolver.authenticate(as('alice'));

      expect(result).toMatchObject({ ok: true, principal: { email: 'alice@example.com' } });
      expect(db.users).toHaveLength(1);
      if (result.ok) expect(result.principal.userId).toBe(db.users[0]?.id);
      // This sign-in's transaction rolled back; the winner audited its own.
      expect(db.audit).toHaveLength(0);
    });

    it('refuses when what took the email meanwhile is a LOCAL account', async () => {
      const { db, resolver } = setup({ config: AUTO });
      db.beforeWrite = () => {
        db.add({ email: 'alice@example.com', authSource: 'local', passwordHash: 'scrypt$x' });
      };

      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(db.users).toEqual([
        expect.objectContaining({ authSource: 'local', directoryId: null, lastLoginAt: null }),
      ]);
    });
  });

  describe('without a writer, or for another source', () => {
    it('a resolver given no writer dispatches by authSource only, as before', async () => {
      const { db, resolver, directory } = setup({ config: AUTO, withWriter: false });

      await expect(resolver.authenticate(as('alice'))).resolves.toEqual(REFUSED);
      expect(directory.calls).toEqual([]);
      expect(db.users).toHaveLength(0);
      expect(nest.join('\n')).toMatch(/Login refused for "alice": no account exists/);
    });

    it('only LDAP signs in directory-first — another source offering it is never asked', async () => {
      const db = new FakeDb();
      const prisma = db.client();
      const asked = jest.fn();
      const other: IAuthProvider = {
        source: 'oidc',
        authenticate: async () => ({ ok: false, reason: 'INVALID_CREDENTIALS' }),
        resolve: async () => null,
        authenticateDirectory: asked,
      };
      const resolver = new AuthProviderResolver(
        [localProvider(), other],
        prisma,
        0,
        new DirectoryAccountWriter(prisma, new PrismaAuditSink(prisma)),
      );

      await expect(resolver.authenticate(as('alice'))).resolves.toMatchObject({ ok: false });
      expect(asked).not.toHaveBeenCalled();
    });

    it('the writer never writes a local account', async () => {
      const db = new FakeDb();
      const prisma = db.client();
      const writer = new DirectoryAccountWriter(prisma, new PrismaAuditSink(prisma));

      expect(() => writer.forSignIn('local', false)).toThrow(/never writes a local account/);
      await expect(
        writer.create('local', {
          email: 'x@example.com',
          displayName: 'x',
          role: 'ADMIN',
          directoryId: ALICE_ID,
        }),
      ).rejects.toThrow(/never created at sign-in/);
      expect(db.users).toHaveLength(0);
    });
  });

  /**
   * Every identifier with no local account now reaches the directory, which
   * costs a round trip the old early return did not. The floor is what keeps
   * that from saying which names the directory knows (ADR-0015 §2).
   */
  describe('the timing floor', () => {
    const FLOOR = 150;
    const slowly = (ms: number, entry: LdapEntry = ALICE): LdapDirectory & { calls: string[] } => {
      const inner = fakeDirectory(entry);
      return {
        ...inner,
        findEntry: async (filter) => {
          await new Promise((r) => setTimeout(r, ms));
          return inner.findEntry(filter);
        },
      };
    };

    const cases: Array<[string, Parameters<typeof setup>[0], Credentials]> = [
      ['no such user', { config: AUTO, directory: slowly(20) }, as('ghost')],
      ['a wrong password', { config: AUTO, directory: slowly(20) }, as('alice', 'wrong')],
      [
        'no mapped group',
        { config: AUTO, directory: slowly(5, { ...ALICE, groupDns: [] }) },
        as('alice'),
      ],
      ['nothing linkable, creation off', { directory: slowly(5) }, as('alice')],
      [
        'the directory down',
        {
          config: AUTO,
          directory: fakeDirectory(ALICE, {
            findEntry: async () => {
              throw new LdapUnavailableError('down');
            },
          }),
        },
        as('alice'),
      ],
    ];

    it.each(cases)('pads %s to the floor', async (_name, parts, credentials) => {
      const { resolver } = setup({ ...parts, floorMs: FLOOR });

      const started = Date.now();
      const result = await resolver.authenticate(credentials);
      const elapsed = Date.now() - started;

      expect(result).toEqual(REFUSED);
      // Timers may fire a millisecond early; never meaningfully so.
      expect(elapsed).toBeGreaterThanOrEqual(FLOOR - 5);
    });
  });

  it('never writes the password to any log line, on any path', async () => {
    const runs: Array<[Parameters<typeof setup>[0], Credentials, ((db: FakeDb) => void)?]> = [
      [{ config: AUTO }, as('alice')],
      [{ config: AUTO }, as('alice', `${PASSWORD}-wrong`)],
      [{ config: AUTO }, as('nobody')],
      [{}, as('alice')],
      [{}, as('alice'), (db) => db.add({ email: 'alice@example.com', authSource: 'ldap' })],
      [
        { config: AUTO },
        as('alice'),
        (db) => db.add({ email: 'alice@example.com', authSource: 'local' }),
      ],
      [{ config: AUTO, directory: fakeDirectory({ ...ALICE, groupDns: [] }) }, as('alice')],
      [{ config: AUTO, directory: fakeDirectory({ ...ALICE, directoryId: null }) }, as('alice')],
      [
        {
          config: AUTO,
          directory: fakeDirectory(ALICE, {
            findEntry: async () => {
              throw new LdapUnavailableError('down');
            },
          }),
        },
        as('alice'),
      ],
      [
        {
          config: config({ autoCreateAccounts: true, roleMappings: [{ groupDn: OPS, role: 'X' }] }),
        },
        as('alice'),
      ],
    ];

    const everything: string[] = [];
    for (const [parts, credentials, arrange] of runs) {
      const env = setup(parts);
      arrange?.(env.db);
      await env.resolver.authenticate(credentials, CONTEXT);
      everything.push(...env.lines);
    }
    everything.push(...nest);

    expect(everything.length).toBeGreaterThan(8);
    for (const line of everything) expect(line).not.toContain(PASSWORD);
  });

  it('throttles refusals of identifiers no account has, and counts what it swallowed', async () => {
    const { resolver, lines } = setup({ config: AUTO });

    for (let i = 0; i < 25; i += 1) {
      await resolver.authenticate(as(`stranger${String(i)}`));
    }

    const refusals = lines.filter((line) => /no directory entry matched/.test(line));
    expect(refusals).toHaveLength(10);
  });

  it('does NOT throttle refusals for an account’s own email', async () => {
    const { db, resolver, lines } = setup();
    db.add({ email: 'alice@example.com', authSource: 'ldap' });

    for (let i = 0; i < 15; i += 1) {
      await resolver.authenticate(as('alice@example.com', 'wrong'));
    }

    expect(lines.filter((line) => /rejected the password/.test(line))).toHaveLength(15);
  });
});
