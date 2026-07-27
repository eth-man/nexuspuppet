import type { AuthenticatedPrincipal } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { TokenService } from '../src/auth/token.service';
import { UsersService } from '../src/auth/users.service';
import { LocalAuthProvider } from '../src/auth/local-auth.provider';
import { hashPassword, verifyPassword } from '../src/auth/password';

/**
 * User administration against a REAL PostgreSQL.
 *
 * The guards under test are lockout guards. Every route in this product
 * requires authentication and only an ADMIN can promote users, so a deployment
 * that loses its last active administrator has no way back in short of editing
 * the database by hand. These are the tests that stop a mistake becoming an
 * outage.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

describe('user administration (integration)', () => {
  let prisma: PrismaService;
  let users: UsersService;
  let tokens: TokenService;
  let provider: LocalAuthProvider;

  const CTX = { ipAddress: '10.0.0.1', userAgent: 'jest' };

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

    provider = new LocalAuthProvider(prisma);
    tokens = new TokenService(prisma, provider, {
      secret: 'x'.repeat(48),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
    users = new UsersService(prisma, new PrismaAuditSink(prisma), tokens);
  });

  const makeUser = async (email: string, role: 'VIEWER' | 'OPERATOR' | 'ADMIN', isActive = true) =>
    prisma.user.create({
      data: {
        email,
        displayName: email,
        role,
        isActive,
        passwordHash: await hashPassword('correct horse battery staple'),
      },
    });

  const principalFor = (row: {
    id: string;
    email: string;
    role: string;
  }): AuthenticatedPrincipal => ({
    userId: row.id,
    email: row.email,
    displayName: row.email,
    role: row.role as AuthenticatedPrincipal['role'],
    authSource: 'local',
  });

  // -------------------------------------------------------------------------

  describe('create', () => {
    it('creates a user who can immediately authenticate', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');

      const created = await users.create(
        {
          email: 'New.Operator@Example.com',
          displayName: 'New Operator',
          role: 'OPERATOR',
          password: 'a-sufficiently-long-password',
        },
        principalFor(admin),
        CTX,
      );

      // Normalised on write, so login is case-insensitive.
      expect(created.email).toBe('new.operator@example.com');

      const result = await provider.authenticate({
        email: 'NEW.OPERATOR@example.com',
        password: 'a-sufficiently-long-password',
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a duplicate email regardless of case', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      await makeUser('taken@example.com', 'VIEWER');

      await expect(
        users.create(
          {
            email: 'TAKEN@example.com',
            displayName: 'Clash',
            role: 'VIEWER',
            password: 'a-sufficiently-long-password',
          },
          principalFor(admin),
          CTX,
        ),
      ).rejects.toThrow(/already exists/);
    });

    it('audits the creation', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      await users.create(
        {
          email: 'audited@example.com',
          displayName: 'Audited',
          role: 'VIEWER',
          password: 'a-sufficiently-long-password',
        },
        principalFor(admin),
        CTX,
      );

      const entry = await prisma.auditLog.findFirst({ where: { action: 'user.create' } });
      expect(entry?.actorEmail).toBe('admin@example.com');
      expect(entry?.ipAddress).toBe('10.0.0.1');
    });
  });

  /**
   * The guards that prevent an unrecoverable deployment.
   */
  describe('lockout prevention', () => {
    it('refuses to demote the last active administrator', async () => {
      const admin = await makeUser('only-admin@example.com', 'ADMIN');
      const other = await makeUser('viewer@example.com', 'VIEWER');

      await expect(
        users.update(admin.id, { role: 'VIEWER' }, principalFor(other), CTX),
      ).rejects.toThrow(/last active administrator/);

      expect((await prisma.user.findUnique({ where: { id: admin.id } }))?.role).toBe('ADMIN');
    });

    it('refuses to deactivate the last active administrator', async () => {
      const admin = await makeUser('only-admin@example.com', 'ADMIN');
      const other = await makeUser('viewer@example.com', 'VIEWER');

      await expect(
        users.update(admin.id, { isActive: false }, principalFor(other), CTX),
      ).rejects.toThrow(/last active administrator/);
    });

    it('allows demotion once a second administrator exists', async () => {
      const first = await makeUser('admin1@example.com', 'ADMIN');
      const second = await makeUser('admin2@example.com', 'ADMIN');

      await expect(
        users.update(first.id, { role: 'OPERATOR' }, principalFor(second), CTX),
      ).resolves.toMatchObject({ role: 'OPERATOR' });
    });

    // An INACTIVE admin cannot log in, so it does not count as cover.
    it('does not count a deactivated administrator as the remaining one', async () => {
      const active = await makeUser('active-admin@example.com', 'ADMIN');
      await makeUser('disabled-admin@example.com', 'ADMIN', false);
      const other = await makeUser('viewer@example.com', 'VIEWER');

      await expect(
        users.update(active.id, { role: 'VIEWER' }, principalFor(other), CTX),
      ).rejects.toThrow(/last active administrator/);
    });

    // Almost always a misclick, and the last-admin rule misses it when other
    // admins exist.
    it('refuses self-deactivation', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      await makeUser('admin2@example.com', 'ADMIN');

      await expect(
        users.update(admin.id, { isActive: false }, principalFor(admin), CTX),
      ).rejects.toThrow(/your own account/);
    });

    it('refuses self-promotion or self-demotion', async () => {
      const operator = await makeUser('op@example.com', 'OPERATOR');
      await makeUser('admin@example.com', 'ADMIN');

      await expect(
        users.update(operator.id, { role: 'ADMIN' }, principalFor(operator), CTX),
      ).rejects.toThrow(/your own role/);
    });

    it('permits renaming yourself', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      await expect(
        users.update(admin.id, { displayName: 'Renamed' }, principalFor(admin), CTX),
      ).resolves.toMatchObject({ displayName: 'Renamed' });
    });
  });

  describe('deactivation ends access', () => {
    it('revokes every session, not just future logins', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const victim = await makeUser('victim@example.com', 'OPERATOR');

      const session = await tokens.issue(principalFor(victim));
      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(1);

      await users.deactivate(victim.id, principalFor(admin), CTX);

      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
      await expect(tokens.rotate(session.refreshToken)).rejects.toMatchObject({
        reason: 'REVOKED',
      });
    });

    it('stops the account authenticating at all', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const victim = await makeUser('victim@example.com', 'OPERATOR');

      await users.deactivate(victim.id, principalFor(admin), CTX);

      expect(
        await provider.authenticate({
          email: 'victim@example.com',
          password: 'correct horse battery staple',
        }),
      ).toEqual({ ok: false, reason: 'ACCOUNT_DISABLED' });
    });
  });

  describe('password change', () => {
    it('requires the current password', async () => {
      const user = await makeUser('user@example.com', 'OPERATOR');

      await expect(
        users.changeOwnPassword(principalFor(user), 'wrong', 'a-new-long-password', CTX),
      ).rejects.toThrow(/incorrect/);

      // And the old password still works, so a failed attempt changes nothing.
      const fresh = await prisma.user.findUnique({ where: { id: user.id } });
      expect(await verifyPassword('correct horse battery staple', fresh!.passwordHash!)).toBe(true);
    });

    it('changes the password and lets the new one authenticate', async () => {
      const user = await makeUser('user@example.com', 'OPERATOR');

      await users.changeOwnPassword(
        principalFor(user),
        'correct horse battery staple',
        'a-brand-new-long-password',
        CTX,
      );

      expect(
        (
          await provider.authenticate({
            email: 'user@example.com',
            password: 'a-brand-new-long-password',
          })
        ).ok,
      ).toBe(true);
    });

    // A password change is usually a response to suspected compromise; leaving
    // existing sessions alive would defeat the point.
    it('revokes existing sessions', async () => {
      const user = await makeUser('user@example.com', 'OPERATOR');
      await tokens.issue(principalFor(user));

      await users.changeOwnPassword(
        principalFor(user),
        'correct horse battery staple',
        'a-brand-new-long-password',
        CTX,
      );

      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    });

    it('refuses for an account with no local password', async () => {
      const external = await prisma.user.create({
        data: {
          email: 'ldap@example.com',
          displayName: 'LDAP User',
          role: 'OPERATOR',
          authSource: 'ldap',
          passwordHash: null,
        },
      });

      await expect(
        users.changeOwnPassword(principalFor(external), 'anything', 'a-new-long-password', CTX),
      ).rejects.toThrow(/local password/);
    });
  });

  describe('admin password reset', () => {
    it('sets a new password and revokes the user sessions', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const user = await makeUser('user@example.com', 'OPERATOR');
      await tokens.issue(principalFor(user));

      await users.resetPassword(user.id, 'reset-by-the-admin-123', principalFor(admin), CTX);

      expect(
        (
          await provider.authenticate({
            email: 'user@example.com',
            password: 'reset-by-the-admin-123',
          })
        ).ok,
      ).toBe(true);
      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    });

    it('audits the reset without recording the password', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const user = await makeUser('user@example.com', 'OPERATOR');

      await users.resetPassword(user.id, 'reset-by-the-admin-123', principalFor(admin), CTX);

      const entry = await prisma.auditLog.findFirst({ where: { action: 'user.password.reset' } });
      expect(entry).not.toBeNull();
      expect(JSON.stringify(entry)).not.toContain('reset-by-the-admin-123');
    });
  });
});
