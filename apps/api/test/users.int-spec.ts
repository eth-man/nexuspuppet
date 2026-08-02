import { createHash } from 'node:crypto';
import type { AuthenticatedPrincipal } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { TokenService } from '../src/auth/token.service';
import { UsersService } from '../src/auth/users.service';
import { AuthProviderResolver } from '../src/auth/auth-provider.resolver';
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
    // A REAL resolver, not a stub. TokenService dispatches through it now
    // (ADR-0015), and these suites exercise refresh — the path where a resolver
    // that cannot find a provider must fail closed rather than throw. A stub
    // would test the stub.
    tokens = new TokenService(prisma, new AuthProviderResolver([provider], prisma, 0), {
      secret: 'x'.repeat(48),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
    users = new UsersService(prisma, new PrismaAuditSink(prisma), tokens, provider);
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
          authSource: 'local',
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
            authSource: 'local',
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
          authSource: 'local',
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

  describe('a directory-sourced role is not editable here', () => {
    // The role is recomputed from group membership at every sign-in
    // (ADR-0015). Writing one locally does not fail — it is overwritten at the
    // next login, with nothing to tell the administrator it did not stick.
    const makeLdapUser = async (email: string, role: 'VIEWER' | 'OPERATOR' | 'ADMIN') =>
      prisma.user.create({
        data: { email, displayName: email, role, isActive: true, authSource: 'ldap' },
      });

    it('refuses a role change on an externally-authenticated account', async () => {
      await makeUser('admin@example.com', 'ADMIN');
      const admin = await makeUser('admin2@example.com', 'ADMIN');
      const alice = await makeLdapUser('alice@example.com', 'VIEWER');

      await expect(
        users.update(alice.id, { role: 'ADMIN' }, principalFor(admin), CTX),
      ).rejects.toThrow(/recomputes their role/);
    });

    it('leaves the stored role untouched when it refuses', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const alice = await makeLdapUser('alice@example.com', 'VIEWER');

      await users.update(alice.id, { role: 'ADMIN' }, principalFor(admin), CTX).catch(() => {});

      const after = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
      expect(after.role).toBe('VIEWER');
    });

    it('still permits the edits that are genuinely local', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const alice = await makeLdapUser('alice@example.com', 'VIEWER');

      // Deactivation is a local decision — it denies access regardless of what
      // the directory says — and renaming does not touch the mapping.
      await expect(
        users.update(alice.id, { isActive: false }, principalFor(admin), CTX),
      ).resolves.toMatchObject({ isActive: false });
      await expect(
        users.update(alice.id, { displayName: 'Alice N' }, principalFor(admin), CTX),
      ).resolves.toMatchObject({ displayName: 'Alice N' });
    });

    it('permits a no-op role patch, so an unrelated edit is not blocked', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const alice = await makeLdapUser('alice@example.com', 'VIEWER');

      await expect(
        users.update(
          alice.id,
          { role: 'VIEWER', displayName: 'Alice N' },
          principalFor(admin),
          CTX,
        ),
      ).resolves.toMatchObject({ displayName: 'Alice N' });
    });

    it('does not interfere with a local account', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const bob = await makeUser('bob@example.com', 'VIEWER');

      await expect(
        users.update(bob.id, { role: 'OPERATOR' }, principalFor(admin), CTX),
      ).resolves.toMatchObject({ role: 'OPERATOR' });
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

    /**
     * ...but not the session doing the changing.
     *
     * The form has always said "this signs you out of every other session". It
     * did not: the sweep took the caller's token too, so the person who changed
     * their own password was bounced at their next refresh — up to one
     * access-token lifetime later, which is why it read as a random logout
     * rather than a consequence. Reported by an operator who changed their
     * password from the settings menu, read the message, and asked why their
     * own session should end.
     *
     * Sparing it is right on its own terms: they have just proved possession of
     * the current password.
     */
    describe('sparing the caller', () => {
      it('leaves the calling session alive and kills the others', async () => {
        const user = await makeUser('user@example.com', 'OPERATOR');
        const mine = await tokens.issue(principalFor(user));
        const laptop = await tokens.issue(principalFor(user));
        const phone = await tokens.issue(principalFor(user));

        await users.changeOwnPassword(
          principalFor(user),
          'correct horse battery staple',
          'a-brand-new-long-password',
          CTX,
          mine.refreshToken,
        );

        const alive = await prisma.refreshToken.findMany({
          where: { revokedAt: null },
          select: { tokenHash: true },
        });

        expect(alive).toHaveLength(1);
        expect(alive[0]!.tokenHash).toBe(
          createHash('sha256').update(mine.refreshToken).digest('hex'),
        );

        // Named explicitly, because "exactly one survivor" would also pass if
        // the survivor were the wrong session.
        for (const other of [laptop, phone]) {
          await expect(tokens.rotate(other.refreshToken)).rejects.toBeDefined();
        }
      });

      it('the spared session can still refresh, which is the whole point', async () => {
        // The count assertion above passes even if the row survives in a state
        // the rotation path rejects. This is what the operator experiences.
        const user = await makeUser('user@example.com', 'OPERATOR');
        const mine = await tokens.issue(principalFor(user));

        await users.changeOwnPassword(
          principalFor(user),
          'correct horse battery staple',
          'a-brand-new-long-password',
          CTX,
          mine.refreshToken,
        );

        await expect(tokens.rotate(mine.refreshToken)).resolves.toMatchObject({
          refreshToken: expect.any(String),
        });
      });

      it('survives a refresh racing the password change', async () => {
        // Why the FAMILY is spared and not the presented row.
        //
        // In the quiet case the two are identical — the cookie holds the newest
        // token, and sparing either keeps the caller signed in. They diverge
        // only here: the client refreshed in the window between the controller
        // reading the cookie and the sweep running, so the token presented to
        // revokeAllForUser is already superseded. Sparing that row alone would
        // spare a token rotation had already revoked and take the live
        // successor with it — logging out the one session that was supposed to
        // survive, intermittently, under load.
        //
        // Written after the obvious version of this test passed against a
        // deliberately row-scoped implementation, which made it worth nothing.
        const user = await makeUser('user@example.com', 'OPERATOR');
        const staleCookie = await tokens.issue(principalFor(user));
        const successor = await tokens.rotate(staleCookie.refreshToken);

        await users.changeOwnPassword(
          principalFor(user),
          'correct horse battery staple',
          'a-brand-new-long-password',
          CTX,
          // The stale value, as the racing controller would have read it.
          staleCookie.refreshToken,
        );

        await expect(tokens.rotate(successor.refreshToken)).resolves.toBeDefined();
      });

      it("cannot be pointed at another user's session", async () => {
        // Enforced by the `userId` scope on the sweep, which is what makes this
        // impossible; the explicit ownership check in revokeAllForUser is a
        // second lock on the same door and has no effect this test can observe.
        // Removing it does not fail here — noted so nobody reads a pass as
        // evidence that it works.
        const user = await makeUser('user@example.com', 'OPERATOR');
        const other = await makeUser('other@example.com', 'OPERATOR');
        await tokens.issue(principalFor(user));
        const theirs = await tokens.issue(principalFor(other));

        await users.changeOwnPassword(
          principalFor(user),
          'correct horse battery staple',
          'a-brand-new-long-password',
          CTX,
          theirs.refreshToken,
        );

        // Every one of the changer's own sessions is gone...
        expect(
          await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
        ).toBe(0);
        // ...and the unrelated user is untouched either way.
        expect(
          await prisma.refreshToken.count({ where: { userId: other.id, revokedAt: null } }),
        ).toBe(1);
      });

      it.each([
        ['no token is presented', undefined],
        ['the token is unknown', 'not-a-token-this-system-ever-issued'],
      ])('revokes everything when %s', async (_label, presented) => {
        // A caller arriving without a usable cookie gets the old, safe
        // behaviour rather than an accidental amnesty.
        const user = await makeUser('user@example.com', 'OPERATOR');
        await tokens.issue(principalFor(user));

        await users.changeOwnPassword(
          principalFor(user),
          'correct horse battery staple',
          'a-brand-new-long-password',
          CTX,
          presented,
        );

        expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
      });
    });
  });

  /**
   * Permanent deletion.
   *
   * Separate from deactivation, which is the reversible default and keeps the
   * `DELETE /users/:id` verb. These tests are about the guards, because the
   * trigger is a small icon one pixel away from the reversible one.
   */
  describe('permanent deletion', () => {
    it('removes the user and their sessions', async () => {
      const user = await makeUser('user@example.com', 'OPERATOR');
      await tokens.issue(principalFor(user));
      const admin = await makeUser('admin@example.com', 'ADMIN');

      await users.remove(user.id, principalFor(admin), CTX);

      expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
      // Cascade, not an explicit revoke: a row that no longer exists cannot be
      // presented, so leaving tokens behind would be a dangling reference.
      expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    });

    it('keeps the audit trail and names who was deleted', async () => {
      // AuditLog.actor is onDelete:SetNull, so the deleted user's own past
      // entries survive with an empty actor. Without the email recorded here
      // those rows would be unattributable forever.
      const user = await makeUser('gone@example.com', 'OPERATOR');
      const admin = await makeUser('admin@example.com', 'ADMIN');

      await users.remove(user.id, principalFor(admin), CTX);

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'user.delete' },
        orderBy: { createdAt: 'desc' },
      });

      expect(entry).not.toBeNull();
      expect(entry!.actorUserId).toBe(admin.id);
      expect(JSON.stringify(entry!.before)).toContain('gone@example.com');
    });

    it('refuses to delete your own account', async () => {
      // Not covered by the last-admin rule when a second admin exists, and it
      // is the likeliest misclick of the three.
      const admin = await makeUser('admin@example.com', 'ADMIN');
      await makeUser('other-admin@example.com', 'ADMIN');

      await expect(users.remove(admin.id, principalFor(admin), CTX)).rejects.toThrow(
        /your own account/i,
      );
      expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull();
    });

    it('refuses to delete the last active administrator', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const other = await makeUser('other@example.com', 'ADMIN');
      // `other` is the only remaining admin once it acts on itself... so use a
      // third party as the actor to isolate the last-admin rule from the
      // self-deletion rule above.
      await prisma.user.update({ where: { id: other.id }, data: { isActive: false } });
      const operator = await makeUser('op@example.com', 'OPERATOR');

      await expect(users.remove(admin.id, principalFor(operator), CTX)).rejects.toThrow(
        /last active administrator/i,
      );
      expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull();
    });

    it('404s for a user that is not there', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      await expect(
        users.remove('6e7969f8-d24e-4b80-8ab8-fc0b53ddec23', principalFor(admin), CTX),
      ).rejects.toThrow(/no such user/i);
    });
  });

  describe('resetting a password', () => {
    it('sets a new password on a local account', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const user = await makeUser('user@example.com', 'OPERATOR');

      await users.resetPassword(user.id, 'a-brand-new-long-password', principalFor(admin), CTX);

      const result = await provider.authenticate({
        email: 'user@example.com',
        password: 'a-brand-new-long-password',
      });
      expect(result.ok).toBe(true);
    });

    it('refuses a directory account, and writes no hash', async () => {
      // Since ADR-0015 a login dispatches strictly on authSource, so a hash
      // written here could never authenticate anybody. What it WOULD do is
      // leave a credential on disk for an identity the directory owns — the
      // hazard the create-user path already refuses to create.
      const admin = await makeUser('admin@example.com', 'ADMIN');
      const external = await prisma.user.create({
        data: {
          email: 'ldap-user@example.com',
          displayName: 'Directory User',
          role: 'VIEWER',
          authSource: 'ldap',
          passwordHash: null,
        },
      });

      await expect(
        users.resetPassword(external.id, 'a-brand-new-long-password', principalFor(admin), CTX),
      ).rejects.toThrow(/not by a local password/i);

      const after = await prisma.user.findUnique({ where: { id: external.id } });
      expect(after?.passwordHash).toBeNull();
    });
  });

  describe('detail view', () => {
    it('counts only sessions that would still work', async () => {
      // Three tokens, three fates. An earlier version of this test created only
      // a live one and a revoked one, and so passed happily against a count
      // that ignored expiry entirely — the expired row is the whole reason the
      // query has two conditions.
      const user = await makeUser('user@example.com', 'OPERATOR');
      await tokens.issue(principalFor(user));

      const revoked = await tokens.issue(principalFor(user));
      await tokens.revoke(revoked.refreshToken);

      const expired = await tokens.issue(principalFor(user));
      await prisma.refreshToken.update({
        where: { tokenHash: createHash('sha256').update(expired.refreshToken).digest('hex') },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      expect((await users.findOne(user.id)).activeSessions).toBe(1);
    });

    it('reports whether a local password exists, never the hash', async () => {
      const local = await makeUser('local@example.com', 'OPERATOR');
      const external = await prisma.user.create({
        data: {
          email: 'ldap@example.com',
          displayName: 'Directory User',
          role: 'VIEWER',
          authSource: 'ldap',
          passwordHash: null,
        },
      });

      expect((await users.findOne(local.id)).hasLocalPassword).toBe(true);
      expect((await users.findOne(external.id)).hasLocalPassword).toBe(false);

      // This object is serialised to a browser.
      expect(JSON.stringify(await users.findOne(local.id))).not.toContain('scrypt');
    });
  });

  describe('password change', () => {
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

  /**
   * Provisioning for an external directory (ADR-0006).
   *
   * An LDAP/SAML provider authenticates a person against a directory but still
   * needs a row here, because AuthenticatedPrincipal.userId is a foreign key
   * from refresh_tokens and audit_logs. Without a way to create one, an LDAP
   * deployment has no accounts at all and nobody can sign in.
   */
  describe('externally-authenticated accounts', () => {
    const externalProvider = {
      source: 'ldap',
      mode: 'credentials' as const,
      authenticate: async () => ({ ok: false as const, reason: 'INVALID_CREDENTIALS' as const }),
      resolve: async () => null,
    };

    let ldapUsers: UsersService;
    beforeEach(() => {
      ldapUsers = new UsersService(prisma, new PrismaAuditSink(prisma), tokens, externalProvider);
    });

    it('creates an account with no password hash', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');

      const created = await ldapUsers.create(
        {
          email: 'dir@example.com',
          displayName: 'Directory User',
          role: 'VIEWER',
          authSource: 'ldap',
        },
        principalFor(admin),
        CTX,
      );

      expect(created.authSource).toBe('ldap');

      // A stored hash would keep the account usable through local auth after
      // the directory revoked access, and would silently become a password
      // login again if the deployment dropped back to the core edition.
      const row = await prisma.user.findUniqueOrThrow({ where: { email: 'dir@example.com' } });
      expect(row.passwordHash).toBeNull();
    });

    /**
     * An account whose authSource no provider answers to can never be
     * authenticated. Creating one silently is how an operator ends up with a
     * user list full of accounts that cannot log in and no error explaining it.
     */
    it('refuses an authSource no configured provider answers to', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');

      await expect(
        ldapUsers.create(
          { email: 'saml@example.com', displayName: 'SAML', role: 'VIEWER', authSource: 'saml' },
          principalFor(admin),
          CTX,
        ),
      ).rejects.toThrow(/No configured provider authenticates/);
    });

    it('still allows local accounts, so dropping back to core orphans nobody', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');

      const created = await ldapUsers.create(
        {
          email: 'fallback@example.com',
          displayName: 'Fallback',
          role: 'VIEWER',
          authSource: 'local',
          password: 'a-sufficiently-long-password',
        },
        principalFor(admin),
        CTX,
      );

      expect(created.authSource).toBe('local');
    });

    it('records which authority owns the account in the audit trail', async () => {
      const admin = await makeUser('admin@example.com', 'ADMIN');

      await ldapUsers.create(
        {
          email: 'audited@example.com',
          displayName: 'Audited',
          role: 'VIEWER',
          authSource: 'ldap',
        },
        principalFor(admin),
        CTX,
      );

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'user.create' },
        orderBy: { createdAt: 'desc' },
      });
      expect(JSON.stringify(entry?.after)).toContain('ldap');
    });
  });
});
