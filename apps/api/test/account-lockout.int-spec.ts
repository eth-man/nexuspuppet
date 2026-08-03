import { PrismaService } from '../src/prisma/prisma.service';
import { LocalAuthProvider } from '../src/auth/local-auth.provider';
import { hashPassword } from '../src/auth/password';
import { roleIdFor } from './support/roles';

/**
 * Account lockout for local accounts (ADR-0006).
 *
 * Integration rather than unit tests, deliberately: the point of this feature
 * is that the counter SURVIVES — in Postgres, across replicas and restarts. A
 * mocked store would verify the arithmetic while proving nothing about the
 * property that matters.
 *
 * These run against the real scrypt implementation too, so they are slow by
 * construction. That cost is the reason lockout exists.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const PASSWORD = 'a-sufficiently-long-password';
const WRONG = 'not-the-right-password';

jest.setTimeout(120_000);

describe('account lockout (integration)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
  });

  async function seed(email = 'alice@example.com'): Promise<{ id: string }> {
    return prisma.user.create({
      data: {
        email,
        displayName: 'Alice',
        role: 'VIEWER',
        roleId: await roleIdFor(prisma, 'VIEWER'),
        passwordHash: await hashPassword(PASSWORD),
        authSource: 'local',
      },
      select: { id: true },
    });
  }

  const provider = (maxFailedAttempts = 3, lockoutMinutes = 15): LocalAuthProvider =>
    new LocalAuthProvider(prisma, { maxFailedAttempts, lockoutMinutes });

  const state = (id: string): Promise<{ failedLoginAttempts: number; lockedUntil: Date | null }> =>
    prisma.user.findUniqueOrThrow({
      where: { id },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });

  describe('counting failures', () => {
    it('counts a wrong password', async () => {
      const user = await seed();
      await provider().authenticate({ email: 'alice@example.com', password: WRONG });

      expect((await state(user.id)).failedLoginAttempts).toBe(1);
      expect((await state(user.id)).lockedUntil).toBeNull();
    });

    it('does not lock before the threshold', async () => {
      const user = await seed();
      const auth = provider(3);

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      expect((await state(user.id)).lockedUntil).toBeNull();
      // Still usable with the right password.
      expect((await auth.authenticate({ email: 'alice@example.com', password: PASSWORD })).ok).toBe(
        true,
      );
    });

    it('locks on the threshold attempt', async () => {
      const user = await seed();
      const auth = provider(3);

      for (let i = 0; i < 3; i += 1) {
        await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      }

      const after = await state(user.id);
      expect(after.lockedUntil).not.toBeNull();
      expect(after.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    /**
     * Consecutive, not cumulative. A counter that only climbed would lock out
     * someone who mistyped their password a handful of times over a year.
     */
    it('clears the streak on a successful login', async () => {
      const user = await seed();
      const auth = provider(3);

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: PASSWORD });

      expect((await state(user.id)).failedLoginAttempts).toBe(0);
    });
  });

  describe('while locked', () => {
    it('refuses the CORRECT password', async () => {
      // The whole point. If the right password lifted the lock, an attacker who
      // eventually guessed it would be let straight in.
      const auth = provider(2);
      await seed();

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      const result = await auth.authenticate({ email: 'alice@example.com', password: PASSWORD });
      expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    });

    /**
     * A locked account must be indistinguishable from a wrong password. Any
     * difference — in the reason OR in the timing — turns lockout into the very
     * enumeration oracle the dummy-hash path exists to prevent.
     */
    it('reports the same reason as a wrong password', async () => {
      const auth = provider(2);
      await seed();
      await seed('bob@example.com');

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      const locked = await auth.authenticate({ email: 'alice@example.com', password: PASSWORD });
      const wrong = await auth.authenticate({ email: 'bob@example.com', password: WRONG });
      const absent = await auth.authenticate({ email: 'nobody@example.com', password: WRONG });

      expect(locked).toEqual(wrong);
      expect(locked).toEqual(absent);
    });

    it('still pays the hashing cost, so timing does not reveal the lock', async () => {
      const auth = provider(2);
      await seed();
      await seed('bob@example.com');

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      const t0 = Date.now();
      await auth.authenticate({ email: 'alice@example.com', password: PASSWORD });
      const lockedMs = Date.now() - t0;

      const t1 = Date.now();
      await auth.authenticate({ email: 'bob@example.com', password: WRONG });
      const wrongMs = Date.now() - t1;

      // Generous bound: this asserts the hash was NOT skipped, not that the two
      // are identical. A skipped scrypt would be an order of magnitude faster,
      // and a tight bound here would be flaky on a loaded machine.
      expect(lockedMs).toBeGreaterThan(wrongMs / 4);
    });
  });

  describe('when the lock expires', () => {
    it('accepts the correct password again', async () => {
      const user = await seed();
      const auth = provider(2);

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      // Reach into the past rather than waiting 15 minutes.
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() - 1_000) },
      });

      expect((await auth.authenticate({ email: 'alice@example.com', password: PASSWORD })).ok).toBe(
        true,
      );
      expect((await state(user.id)).lockedUntil).toBeNull();
    });

    /**
     * The streak that produced the expired lock is spent. Carrying it forward
     * would re-lock the account on the very next typo, which reads to the user
     * as a lockout that never ends.
     */
    it('starts a fresh streak rather than re-locking immediately', async () => {
      const user = await seed();
      const auth = provider(2);

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() - 1_000) },
      });

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      const after = await state(user.id);
      expect(after.failedLoginAttempts).toBe(1);
      expect(after.lockedUntil?.getTime() ?? 0).toBeLessThan(Date.now());
    });
  });

  describe('scope and configuration', () => {
    it('locks only the account that failed', async () => {
      await seed();
      const bob = await seed('bob@example.com');
      const auth = provider(2);

      await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      await auth.authenticate({ email: 'alice@example.com', password: WRONG });

      expect((await state(bob.id)).lockedUntil).toBeNull();
      expect((await auth.authenticate({ email: 'bob@example.com', password: PASSWORD })).ok).toBe(
        true,
      );
    });

    it('can be disabled with a threshold of 0', async () => {
      const user = await seed();
      const auth = provider(0);

      for (let i = 0; i < 5; i += 1) {
        await auth.authenticate({ email: 'alice@example.com', password: WRONG });
      }

      const after = await state(user.id);
      expect(after.lockedUntil).toBeNull();
      expect(after.failedLoginAttempts).toBe(0);
      expect((await auth.authenticate({ email: 'alice@example.com', password: PASSWORD })).ok).toBe(
        true,
      );
    });

    it('honours the configured duration', async () => {
      const user = await seed();
      await provider(1, 30).authenticate({ email: 'alice@example.com', password: WRONG });

      const lockedUntil = (await state(user.id)).lockedUntil!;
      const minutes = (lockedUntil.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThanOrEqual(30);
    });

    /**
     * An externally-authenticated account has no local password, so there is
     * nothing to guess and nothing to lock. Counting failures against it would
     * let anyone lock out a directory user by submitting rubbish.
     */
    it('does not lock an account with no local password', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'ldap@example.com',
          displayName: 'Directory User',
          role: 'VIEWER',
          roleId: await roleIdFor(prisma, 'VIEWER'),
          passwordHash: null,
          authSource: 'ldap',
        },
        select: { id: true },
      });

      const auth = provider(1);
      await auth.authenticate({ email: 'ldap@example.com', password: WRONG });
      await auth.authenticate({ email: 'ldap@example.com', password: WRONG });

      const after = await state(user.id);
      expect(after.lockedUntil).toBeNull();
      expect(after.failedLoginAttempts).toBe(0);
    });

    it('does not count failures for an account that does not exist', async () => {
      // Nothing to write to, and creating a row would itself be an enumeration
      // channel: an attacker could grow the users table by guessing addresses.
      const auth = provider(1);
      await auth.authenticate({ email: 'ghost@example.com', password: WRONG });

      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe('interaction with deactivation', () => {
    it('reports a deactivated account as disabled, not as locked', async () => {
      const user = await seed();
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      const result = await provider(3).authenticate({
        email: 'alice@example.com',
        password: PASSWORD,
      });

      expect(result).toEqual({ ok: false, reason: 'ACCOUNT_DISABLED' });
    });
  });
});
