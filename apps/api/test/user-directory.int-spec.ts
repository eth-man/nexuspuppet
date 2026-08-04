import { PrismaService } from '../src/prisma/prisma.service';
import { LocalUserDirectory } from '../src/auth/local-auth.provider';
import { hashPassword } from '../src/auth/password';
import { roleIdFor } from './support/roles';

/**
 * IUserDirectory lookup and login-state caching, against a REAL PostgreSQL.
 *
 * These exist for the external-provider path (LDAP, SAML). Such a provider
 * authenticates against a directory but must still hand back a principal whose
 * userId is a row here — refresh_tokens and audit_logs both carry a foreign key
 * to it. `findById` is what lets it re-resolve on token refresh, and
 * `recordLogin` is what keeps refresh from disagreeing with login about a
 * user's role.
 *
 * Integration rather than unit tests: the value is in the Prisma query and the
 * enum round-trip, and a mock would confirm only what the code already
 * believes.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

describe('LocalUserDirectory (integration)', () => {
  let prisma: PrismaService;
  let directory: LocalUserDirectory;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
    directory = new LocalUserDirectory(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    // Custom roles a test created. In beforeEach and not at the end of the test
    // that makes one, because an assertion that fails skips every line after it
    // — and the leftover row then fails the NEXT run on the unique name, which
    // reads as a bug in the code under test rather than in the fixture.
    await prisma.role.deleteMany({ where: { builtIn: false } });
  });

  async function seed(
    overrides: Partial<{
      email: string;
      displayName: string;
      role: 'VIEWER' | 'OPERATOR' | 'ADMIN';
      isActive: boolean;
      authSource: string;
    }> = {},
  ): Promise<{ id: string }> {
    return prisma.user.create({
      data: {
        email: overrides.email ?? 'alice@example.com',
        displayName: overrides.displayName ?? 'Alice Ng',
        role: overrides.role ?? 'VIEWER',
        roleId: await roleIdFor(prisma, (overrides.role ?? 'VIEWER') as string),
        isActive: overrides.isActive ?? true,
        authSource: overrides.authSource ?? 'ldap',
        // An externally-authenticated account owns no local password.
        passwordHash: overrides.authSource === 'local' ? await hashPassword('x'.repeat(16)) : null,
      },
      select: { id: true },
    });
  }

  describe('findById', () => {
    it('returns the principal for a known id', async () => {
      const user = await seed({ role: 'OPERATOR' });

      const principal = await directory.findById(user.id);

      expect(principal).not.toBeNull();
      expect(principal?.userId).toBe(user.id);
      expect(principal?.email).toBe('alice@example.com');
      expect(principal?.role).toBe('OPERATOR');
      expect(principal?.authSource).toBe('ldap');
    });

    it('returns null for an unknown id rather than throwing', async () => {
      // A refresh token surviving its user must end the session, not 500.
      expect(await directory.findById('11111111-1111-4111-8111-111111111111')).toBeNull();
    });

    it('agrees with findByEmail for the same row', async () => {
      const user = await seed();
      expect(await directory.findById(user.id)).toEqual(
        await directory.findByEmail('alice@example.com'),
      );
    });

    /**
     * findById deliberately does NOT filter on isActive. Deciding what a
     * deactivated account means belongs to the auth provider — it returns null
     * from resolve() — and a directory that hid the row would also hide it from
     * user administration.
     *
     * That only works because the status is REPORTED. A directory that returned
     * the row while omitting isActive would leave every provider unable to
     * enforce a deactivation, and `!user.isActive` on an absent field is
     * `true` — which silently locks out everyone instead.
     */
    it('still returns a deactivated user, and says that it is deactivated', async () => {
      const user = await seed({ isActive: false });
      const found = await directory.findById(user.id);

      expect(found).not.toBeNull();
      expect(found?.isActive).toBe(false);
    });

    it('reports an active account as active', async () => {
      const user = await seed({ isActive: true });
      expect((await directory.findById(user.id))?.isActive).toBe(true);
    });
  });

  describe('recordLogin', () => {
    it('persists the role and display name the directory asserted', async () => {
      const user = await seed({ role: 'VIEWER', displayName: 'Alice (stale)' });

      await directory.recordLogin(user.id, { role: 'ADMIN', displayName: 'Alice Ng' });

      const principal = await directory.findById(user.id);
      expect(principal?.role).toBe('ADMIN');
      expect(principal?.displayName).toBe('Alice Ng');
    });

    /**
     * The point of the method: without it, login would say ADMIN from a group
     * membership while a later token refresh read a stale row and said VIEWER.
     */
    it('makes a later lookup agree with what login decided', async () => {
      const user = await seed({ role: 'VIEWER' });
      await directory.recordLogin(user.id, { role: 'OPERATOR', displayName: 'Alice Ng' });

      expect((await directory.findById(user.id))?.role).toBe('OPERATOR');
      expect((await directory.findByEmail('alice@example.com'))?.role).toBe('OPERATOR');
    });

    /**
     * The drift that made the Roles card lie.
     *
     * A user carries their role TWICE: `role` (the name, what the console
     * shows) and `roleId` (the foreign key, what every count and guard reads).
     * This method wrote the name and left the key wherever the account was
     * provisioned.
     *
     * Nothing above catches it, because every assertion up to here goes
     * through `findById`, which reads the name. Reported from a live
     * deployment instead: the Roles card said OPERATOR was held by nobody
     * while an operator was signed in, and VIEWER was credited with four
     * people when two were viewers.
     *
     * The quiet half is worse than the visible one. `assertAdministrationSurvives`
     * counts administrators by the key, so an admin whose key still said
     * VIEWER did not count as an administrator — the guard against deleting
     * the last one was measuring the wrong set.
     */
    it('moves the role key with the role name', async () => {
      const user = await seed({ role: 'VIEWER' });

      await directory.recordLogin(user.id, { role: 'OPERATOR', displayName: 'Alice Ng' });

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { roleRef: { select: { name: true } } },
      });
      expect(row.role).toBe('OPERATOR');
      expect(row.roleRef.name).toBe('OPERATOR');
    });

    /** A directory group can map to a custom role since ADR-0018, not only the built-in three. */
    it('moves the key to a custom role too', async () => {
      const user = await seed({ role: 'VIEWER' });
      const custom = await prisma.role.create({
        data: {
          name: 'auditor',
          description: 'Reads everything, changes nothing.',
          permissions: ['inventory:read'],
        },
      });

      await directory.recordLogin(user.id, { role: 'auditor', displayName: 'Alice Ng' });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.role).toBe('auditor');
      expect(row.roleId).toBe(custom.id);
    });

    /**
     * The key is NOT NULL, so there is no "unset" to fall back to. Leaving it
     * stale is the least-wrong option: the account resolves permissions by
     * NAME, so it already resolves none, and pointing the key at a guess would
     * hand it whatever that guess allows.
     */
    it('leaves the key alone when the name is not a role this deployment defines', async () => {
      const user = await seed({ role: 'VIEWER' });
      const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

      await directory.recordLogin(user.id, { role: 'no-such-role', displayName: 'Alice Ng' });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.role).toBe('no-such-role');
      expect(row.roleId).toBe(before.roleId);
    });

    it('records when the directory last confirmed the account', async () => {
      const user = await seed();
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { lastLoginAt: true },
      });
      expect(before.lastLoginAt).toBeNull();

      await directory.recordLogin(user.id, { role: 'VIEWER', displayName: 'Alice Ng' });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { lastLoginAt: true },
      });
      expect(after.lastLoginAt).toBeInstanceOf(Date);
    });

    it('does not touch other accounts', async () => {
      const alice = await seed();
      const bob = await seed({ email: 'bob@example.com', displayName: 'Bob', role: 'ADMIN' });

      await directory.recordLogin(alice.id, { role: 'OPERATOR', displayName: 'Alice Ng' });

      expect((await directory.findById(bob.id))?.role).toBe('ADMIN');
      expect((await directory.findById(bob.id))?.displayName).toBe('Bob');
    });

    /**
     * The caller treats this as non-fatal — the person supplied valid
     * credentials — but it must REJECT rather than silently succeed, or a
     * provider could never distinguish "cached" from "quietly lost".
     */
    it('rejects for an unknown user instead of silently doing nothing', async () => {
      await expect(
        directory.recordLogin('11111111-1111-4111-8111-111111111111', {
          role: 'VIEWER',
          displayName: 'Nobody',
        }),
      ).rejects.toBeDefined();
    });
  });

  it('reports itself as writable, which an LDAP-backed directory would not', async () => {
    expect(directory.readOnly).toBe(false);
  });

  it('exposes account status through list() as well', async () => {
    await seed({ isActive: false });
    const { users } = await directory.list({ limit: 10, offset: 0 });
    expect(users[0]?.isActive).toBe(false);
  });

  it('exposes account status through findByEmail as well', async () => {
    await seed({ isActive: false });
    expect((await directory.findByEmail('alice@example.com'))?.isActive).toBe(false);
  });
});
