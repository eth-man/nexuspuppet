import { createHash } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { LocalAuthProvider, normalizeEmail } from '../src/auth/local-auth.provider';
import { TokenService } from '../src/auth/token.service';
import { RbacPolicy } from '../src/auth/rbac.policy';
import { BootstrapService } from '../src/auth/core-capabilities';
import type { IAuthProvider } from '@nexuspuppet/contracts';
import { hashPassword } from '../src/auth/password';
import { AuthController } from '../src/auth/auth.controller';
import { LoginRateLimiter } from '../src/auth/core-capabilities';

/**
 * Auth integration tests against a REAL PostgreSQL.
 *
 * Refresh rotation and reuse detection are stateful across requests and
 * transactional; a mocked Prisma would confirm whatever the code already
 * believes. These are the paths where being wrong means a stolen session
 * stays valid.
 */

/**
 * These tests TRUNCATE tables. They must never point at a database anyone is
 * using: a leftover fixture row once blocked admin bootstrap on the dev stack
 * and made login impossible. `npm run test:int` supplies TEST_DATABASE_URL;
 * the fallback is the dedicated test database, never the dev one.
 */
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const SECRET = 'x'.repeat(48);

jest.setTimeout(60_000);

/**
 * A resolver holding a single provider, for tests that construct the controller
 * directly. The controller now dispatches through the resolver (ADR-0015) so
 * local and directory accounts can both authenticate.
 */
const resolverFor = (provider: IAuthProvider): never =>
  ({
    describableProvider: () => provider,
    redirectProvider: () => ((provider.mode ?? 'credentials') === 'redirect' ? provider : null),
    credentialProviders: () =>
      (provider.mode ?? 'credentials') === 'credentials' ? [provider] : [],
    authenticate: (credentials: never) => provider.authenticate(credentials),
    forSource: (source: string) => (source === provider.source ? provider : null),
    sources: () => [provider.source],
  }) as never;

describe('auth (integration)', () => {
  let prisma: PrismaService;
  let provider: LocalAuthProvider;
  let tokens: TokenService;

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
      secret: SECRET,
      accessTtl: '15m',
      refreshTtl: '30d',
      issuer: 'nexuspuppet',
      audience: 'nexuspuppet-api',
    });
  });

  const createUser = async (
    over: Partial<{ email: string; password: string; role: string; isActive: boolean }> = {},
  ) =>
    prisma.user.create({
      data: {
        email: normalizeEmail(over.email ?? 'ops@example.com'),
        displayName: 'Ops User',
        passwordHash: await hashPassword(over.password ?? 'correct horse battery staple'),
        role: (over.role ?? 'OPERATOR') as 'VIEWER' | 'OPERATOR' | 'ADMIN',
        isActive: over.isActive ?? true,
      },
    });

  // -------------------------------------------------------------------------

  describe('LocalAuthProvider', () => {
    it('authenticates a correct password', async () => {
      await createUser();
      const result = await provider.authenticate({
        email: 'ops@example.com',
        password: 'correct horse battery staple',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principal.role).toBe('OPERATOR');
        expect(result.principal.authSource).toBe('local');
      }
    });

    it('rejects a wrong password', async () => {
      await createUser();
      const result = await provider.authenticate({
        email: 'ops@example.com',
        password: 'wrong',
      });
      expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    });

    it('matches email case-insensitively', async () => {
      await createUser({ email: 'Ops@Example.COM' });
      const result = await provider.authenticate({
        email: 'ops@example.com',
        password: 'correct horse battery staple',
      });
      expect(result.ok).toBe(true);
    });

    // A disabled account must be indistinguishable from a wrong password
    // WITHOUT the password; with it, the distinct reason is useful.
    it('reports a disabled account only after the password verifies', async () => {
      await createUser({ isActive: false });

      expect(await provider.authenticate({ email: 'ops@example.com', password: 'wrong' })).toEqual({
        ok: false,
        reason: 'INVALID_CREDENTIALS',
      });

      expect(
        await provider.authenticate({
          email: 'ops@example.com',
          password: 'correct horse battery staple',
        }),
      ).toEqual({ ok: false, reason: 'ACCOUNT_DISABLED' });
    });

    // Returning early on "no such user" makes login a user-enumeration oracle.
    it('takes comparable time for an unknown user as for a wrong password', async () => {
      await createUser();

      const time = async (email: string): Promise<number> => {
        const start = process.hrtime.bigint();
        await provider.authenticate({ email, password: 'some-wrong-password' });
        return Number(process.hrtime.bigint() - start) / 1e6;
      };

      const known = await time('ops@example.com');
      const unknown = await time('nobody@example.com');

      // Both must pay the scrypt cost. Generous bound — this asserts the dummy
      // verification happens at all, not a precise timing guarantee.
      expect(unknown).toBeGreaterThan(known * 0.3);
    });

    it('records lastLoginAt', async () => {
      const user = await createUser();
      await provider.authenticate({
        email: 'ops@example.com',
        password: 'correct horse battery staple',
      });

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after?.lastLoginAt).not.toBeNull();
    });

    describe('resolve', () => {
      it('returns the principal for an active user', async () => {
        const user = await createUser();
        expect(await provider.resolve(user.id)).toMatchObject({ userId: user.id });
      });

      it('returns null for a deactivated user', async () => {
        const user = await createUser({ isActive: false });
        expect(await provider.resolve(user.id)).toBeNull();
      });

      it('returns null for an unknown id', async () => {
        expect(await provider.resolve('00000000-0000-0000-0000-000000000000')).toBeNull();
      });
    });
  });

  describe('session issuance', () => {
    it('issues a verifiable access token carrying identity claims', async () => {
      const user = await createUser();
      const principal = (await provider.resolve(user.id))!;
      const session = await tokens.issue(principal);

      const verified = tokens.verifyAccessToken(session.accessToken);
      expect(verified.userId).toBe(user.id);
      expect(verified.role).toBe('OPERATOR');
      expect(verified.email).toBe('ops@example.com');
    });

    // The plaintext lives in the cookie and nowhere else, so a database leak
    // does not hand over live sessions.
    it('stores only a hash of the refresh token', async () => {
      const user = await createUser();
      const session = await tokens.issue((await provider.resolve(user.id))!);

      const stored = await prisma.refreshToken.findFirst();
      expect(stored?.tokenHash).toBe(
        createHash('sha256').update(session.refreshToken).digest('hex'),
      );
      expect(JSON.stringify(stored)).not.toContain(session.refreshToken);
    });
  });

  describe('refresh rotation', () => {
    it('issues a new pair and consumes the old token', async () => {
      const user = await createUser();
      const first = await tokens.issue((await provider.resolve(user.id))!);

      const second = await tokens.rotate(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);

      const oldRecord = await prisma.refreshToken.findUnique({
        where: { tokenHash: createHash('sha256').update(first.refreshToken).digest('hex') },
      });
      expect(oldRecord?.consumedAt).not.toBeNull();
    });

    it('keeps rotations within one family', async () => {
      const user = await createUser();
      const first = await tokens.issue((await provider.resolve(user.id))!);
      const second = await tokens.rotate(first.refreshToken);
      await tokens.rotate(second.refreshToken);

      const families = new Set((await prisma.refreshToken.findMany()).map((t) => t.familyId));
      expect(families.size).toBe(1);
    });

    it('a new login starts a separate family', async () => {
      const user = await createUser();
      await tokens.issue((await provider.resolve(user.id))!);
      await tokens.issue((await provider.resolve(user.id))!);

      const families = new Set((await prisma.refreshToken.findMany()).map((t) => t.familyId));
      expect(families.size).toBe(2);
    });

    // Re-resolution at refresh is what makes deactivation take effect within
    // one access-token lifetime rather than one refresh lifetime.
    it('refuses to refresh once the account is deactivated', async () => {
      const user = await createUser();
      const session = await tokens.issue((await provider.resolve(user.id))!);

      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      await expect(tokens.rotate(session.refreshToken)).rejects.toMatchObject({
        reason: 'PRINCIPAL_GONE',
      });
    });

    it('picks up a role change at refresh', async () => {
      const user = await createUser({ role: 'VIEWER' });
      const session = await tokens.issue((await provider.resolve(user.id))!);
      expect(tokens.verifyAccessToken(session.accessToken).role).toBe('VIEWER');

      await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      const rotated = await tokens.rotate(session.refreshToken);

      expect(tokens.verifyAccessToken(rotated.accessToken).role).toBe('ADMIN');
    });

    it('rejects an unknown refresh token', async () => {
      await expect(tokens.rotate('never-issued')).rejects.toMatchObject({ reason: 'UNKNOWN' });
    });

    it('rejects an expired refresh token', async () => {
      const user = await createUser();
      const session = await tokens.issue((await provider.resolve(user.id))!);

      await prisma.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(tokens.rotate(session.refreshToken)).rejects.toMatchObject({
        reason: 'EXPIRED',
      });
    });
  });

  /**
   * The security-critical behaviour. Replaying a consumed refresh token means
   * either the attacker or the legitimate user is using a token the other has
   * already spent — and we cannot tell which.
   */
  describe('reuse detection', () => {
    it('revokes the entire family when a consumed token is replayed', async () => {
      const user = await createUser();
      const first = await tokens.issue((await provider.resolve(user.id))!);
      const second = await tokens.rotate(first.refreshToken);

      // The attacker replays the stolen, already-consumed token.
      await expect(tokens.rotate(first.refreshToken)).rejects.toMatchObject({ reason: 'REUSED' });

      // The legitimate user's current token dies too. Deliberately disruptive:
      // one forced login beats a session that might be compromised.
      await expect(tokens.rotate(second.refreshToken)).rejects.toMatchObject({
        reason: 'REVOKED',
      });

      const live = await prisma.refreshToken.findMany({ where: { revokedAt: null } });
      expect(live).toHaveLength(0);
    });

    it('does not touch other families', async () => {
      const user = await createUser();
      const familyA = await tokens.issue((await provider.resolve(user.id))!);
      const familyB = await tokens.issue((await provider.resolve(user.id))!);

      await tokens.rotate(familyA.refreshToken);
      await expect(tokens.rotate(familyA.refreshToken)).rejects.toMatchObject({
        reason: 'REUSED',
      });

      // A different session on another device must survive.
      await expect(tokens.rotate(familyB.refreshToken)).resolves.toBeDefined();
    });

    it('a revoked token stays revoked', async () => {
      const user = await createUser();
      const session = await tokens.issue((await provider.resolve(user.id))!);
      await tokens.revoke(session.refreshToken);

      await expect(tokens.rotate(session.refreshToken)).rejects.toMatchObject({
        reason: 'REVOKED',
      });
    });
  });

  describe('revocation', () => {
    it('logout is idempotent', async () => {
      const user = await createUser();
      const session = await tokens.issue((await provider.resolve(user.id))!);

      await tokens.revoke(session.refreshToken);
      await expect(tokens.revoke(session.refreshToken)).resolves.toBeUndefined();
      await expect(tokens.revoke('never-issued')).resolves.toBeUndefined();
    });

    it('revokeAllForUser ends every session', async () => {
      const user = await createUser();
      await tokens.issue((await provider.resolve(user.id))!);
      await tokens.issue((await provider.resolve(user.id))!);

      await tokens.revokeAllForUser(user.id);
      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    });

    it('pruneExpired removes only expired rows', async () => {
      const user = await createUser();
      await tokens.issue((await provider.resolve(user.id))!);
      const keep = await prisma.refreshToken.count();

      expect(await tokens.pruneExpired()).toBe(0);
      expect(await prisma.refreshToken.count()).toBe(keep);

      await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await tokens.pruneExpired()).toBe(keep);
    });
  });

  describe('bootstrap', () => {
    it('seeds an admin when no users exist', async () => {
      await new BootstrapService(
        prisma,
        'admin@example.com',
        'a-long-enough-password',
      ).seedAdminIfEmpty();

      const admin = await prisma.user.findUnique({ where: { email: 'admin@example.com' } });
      expect(admin?.role).toBe('ADMIN');
    });

    // Must never reset or duplicate an account on an existing installation.
    it('does nothing when users already exist', async () => {
      await createUser();
      await new BootstrapService(
        prisma,
        'admin@example.com',
        'a-long-enough-password',
      ).seedAdminIfEmpty();

      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.user.findUnique({ where: { email: 'admin@example.com' } })).toBeNull();
    });

    it('does nothing, and does not crash, when unconfigured', async () => {
      await new BootstrapService(prisma, undefined, undefined).seedAdminIfEmpty();
      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe('RBAC applies to whichever provider is registered', () => {
    const policy = new RbacPolicy();

    it('enforces role permissions on a principal from any source', async () => {
      const user = await createUser({ role: 'VIEWER' });
      const principal = (await provider.resolve(user.id))!;

      expect(policy.can(principal, 'inventory:read')).toBe(true);
      expect(policy.can(principal, 'classification:write')).toBe(false);
      expect(policy.can(principal, 'users:manage')).toBe(false);
    });

    // The point of ADR-0006's separation: authorization never inspects how the
    // principal was authenticated.
    it('decides identically for an enterprise-sourced principal', () => {
      const fromSso = {
        userId: 'sso-1',
        email: 'ldap@example.com',
        displayName: 'LDAP User',
        role: 'OPERATOR' as const,
        authSource: 'ldap',
      };

      expect(policy.can(fromSso, 'classification:write')).toBe(true);
      expect(policy.can(fromSso, 'users:manage')).toBe(false);
    });
  });

  /**
   * GET /auth/provider — how the console shows an administrator which directory
   * groups grant which role, without core knowing what a directory is.
   */
  describe('provider description', () => {
    it('falls back to the source alone when a provider does not describe itself', () => {
      // Core's LocalAuthProvider has no describe(): there are no group mappings
      // to explain. The endpoint must still answer, so the UI can decide to
      // render nothing rather than handling an error.
      const controller = new AuthController(
        resolverFor(provider),
        provider,
        tokens,
        new LoginRateLimiter(),
      );

      expect(controller.describeProvider()).toEqual({
        source: 'local',
        roleMappings: [],
        refusesUnmappedUsers: false,
        details: [],
      });
    });

    it('returns whatever a provider that does describe itself supplies', () => {
      const describing: IAuthProvider = {
        source: 'ldap',
        mode: 'credentials',
        authenticate: (c) => provider.authenticate(c),
        resolve: (id) => provider.resolve(id),
        describe: () => ({
          source: 'ldap',
          roleMappings: [{ group: 'cn=ops,dc=x', role: 'OPERATOR' as const }],
          refusesUnmappedUsers: true,
          details: [{ label: 'Directory', value: 'ldaps://d.example.com' }],
        }),
      };
      const controller = new AuthController(
        resolverFor(describing),
        describing,
        tokens,
        new LoginRateLimiter(),
      );

      expect(controller.describeProvider().roleMappings).toEqual([
        { group: 'cn=ops,dc=x', role: 'OPERATOR' },
      ]);
    });
  });
});
