import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AUDIT_SINK } from '@nexuspuppet/contracts';
import type {
  MoveAuthSource,
  AuthenticatedPrincipal,
  CreateUser,
  IAuditSink,
  ManagedUser,
  ManagedUserDetail,
  UpdateUser,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';
import { hashPassword, verifyPassword } from './password';
import { normalizeEmail } from './local-auth.provider';
import { AuthProviderResolver } from './auth-provider.resolver';

/**
 * Local user administration (ADR-0006).
 *
 * LOCKOUT IS THE FAILURE MODE THAT MATTERS. Every route in this product
 * requires authentication, and only an ADMIN can create or promote users. An
 * estate that loses its last active administrator has no way back in short of
 * editing the database by hand — so the guards below are not defensive
 * politeness, they are the difference between a mistake and an outage.
 *
 * Every change is written with its audit row in one transaction (ADR-0005).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    private readonly tokens: TokenService,
    private readonly providers: AuthProviderResolver,
  ) {}

  async list(): Promise<ManagedUser[]> {
    const rows = await this.prisma.user.findMany({ orderBy: { email: 'asc' } });
    return rows.map(toManagedUser);
  }

  async create(
    input: CreateUser,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ManagedUser> {
    const email = normalizeEmail(input.email);
    const authSource = input.authSource;

    /*
     * An account whose authSource no configured provider answers to can never be
     * authenticated. Creating one silently is how an operator ends up with a
     * user list full of accounts that cannot log in, with no error to explain
     * it. 'local' stays allowed regardless: dropping back to the core edition
     * must not orphan the accounts created before it.
     *
     * Asks the RESOLVER, not a single injected provider. This compared against
     * `AUTH_PROVIDER.source` — one provider, chosen at boot — which was correct
     * before ADR-0015 made registration additive and wrong immediately after.
     * On a hybrid deployment it rejected `ldap` while the same process logged
     * "Authentication sources: ldap, local" at start-up, so no directory account
     * could be provisioned at all, and every directory login then failed with a
     * silent 401 because there was no row to dispatch on.
     */
    const known = this.providers.sources();
    if (authSource !== 'local' && !known.includes(authSource)) {
      throw new BadRequestException(
        `No configured provider authenticates "${authSource}". This deployment has: ` +
          `${known.join(', ')}. Use one of those, or "local" for a password account.`,
      );
    }

    // Hashed outside the transaction: scrypt takes ~100ms by design, and
    // holding a transaction open for it would pin a connection needlessly.
    //
    // An external account gets NO hash. The schema already rejects a password
    // here; this is the second half of the same rule — the directory must be
    // the only way in.
    const passwordHash = input.password === undefined ? null : await hashPassword(input.password);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (existing !== null) {
        throw new ConflictException(`A user with the email ${email} already exists.`);
      }

      const created = await tx.user.create({
        data: {
          email,
          displayName: input.displayName,
          role: input.role,
          // Kept in lockstep with the enum while the enum is still what
          // resolves permissions (ADR-0018 §1). Nothing reads this yet; the
          // point is that when resolution moves over, every row already has
          // one and the NOT NULL migration has nothing to backfill.
          roleId: await assignableRoleId(tx, input.role),
          passwordHash,
          authSource,
        },
      });

      await this.record(tx, actor, context, 'user.create', created.id, null, {
        email: created.email,
        role: created.role,
        // Which authority may now authenticate as this person. Provisioning an
        // externally-backed account delegates that decision to a system outside
        // this one — exactly the sort of thing an auditor has to be able to
        // reconstruct after the fact.
        authSource: created.authSource,
      });

      return toManagedUser(created);
    });
  }

  async update(
    id: string,
    input: UpdateUser,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ManagedUser> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (before === null) throw new NotFoundException('No such user.');

      /*
       * Keyed on the PERMISSION, not on the name "ADMIN" (ADR-0018 §4).
       *
       * With roles editable, the name stops being the thing that matters twice
       * over: an ADMIN role could have users:manage removed from it, and a
       * custom role could have been granted it. A guard that counts users
       * called ADMIN would then both miss the real administrators and refuse a
       * demotion that was safe.
       *
       * ADMINISTERING NEEDS BOTH. users:manage alone leaves nobody able to
       * configure the deployment; settings:manage alone leaves nobody able to
       * grant it back. Losing either is a lockout.
       */
      const couldLoseAdministration =
        (input.role !== undefined && input.role !== before.role) || input.isActive === false;

      if (couldLoseAdministration) {
        for (const permission of ['users:manage', 'settings:manage'] as const) {
          // Counted inside the transaction so a concurrent demotion cannot slip
          // past the check and leave the deployment with none.
          const remaining = await tx.user.count({
            where: {
              isActive: true,
              id: { not: id },
              roleRef: { permissions: { has: permission } },
            },
          });

          if (remaining === 0) {
            throw new ConflictException(
              `This is the last active user whose role grants "${permission}". Give another ` +
                'account a role that grants it first, or nobody will be able to administer ' +
                'this deployment.',
            );
          }
        }
      }

      // Self-deactivation is refused separately: it is almost always a
      // misclick, and the "last admin" rule would not catch it when another
      // admin exists.
      if (id === actor.userId && input.isActive === false) {
        throw new ForbiddenException('You cannot deactivate your own account.');
      }

      if (id === actor.userId && input.role !== undefined && input.role !== before.role) {
        throw new ForbiddenException('You cannot change your own role.');
      }

      // An externally-sourced role is derived, not stored: the provider
      // recomputes it from group membership at every sign-in (ADR-0015). A
      // change made here is not rejected by anything downstream — it is
      // written, shown as applied, and then silently overwritten the next time
      // that person logs in. Accepting the edit is the worst of the available
      // options, because the administrator has no way to tell it did not stick.
      //
      // The same reasoning already refuses a password reset on these accounts.
      if (input.role !== undefined && input.role !== before.role && before.authSource !== 'local') {
        throw new ConflictException(
          `${before.email} is authenticated by "${before.authSource}", which recomputes their ` +
            'role from directory group membership at every sign-in. Change their groups in the ' +
            'directory, or the role mapping in settings — a role set here would be overwritten ' +
            'at their next sign-in.',
        );
      }

      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          // The two move together or they drift, and a drift here is invisible
          // until the release that starts reading roleId (ADR-0018 §1).
          ...(input.role === undefined
            ? {}
            : { role: input.role, roleId: await assignableRoleId(tx, input.role) }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
      });

      await this.record(
        tx,
        actor,
        context,
        'user.update',
        id,
        { role: before.role, isActive: before.isActive, displayName: before.displayName },
        { role: updated.role, isActive: updated.isActive, displayName: updated.displayName },
      );

      return toManagedUser(updated);
    });
  }

  /**
   * Deactivating a user must also end their sessions.
   *
   * `LocalAuthProvider.resolve` already refuses an inactive account, so refresh
   * fails — but an access token issued moments earlier stays valid until it
   * expires. Revoking here closes that window for anything longer-lived.
   */
  async deactivate(
    id: string,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ManagedUser> {
    const updated = await this.update(id, { isActive: false }, actor, context);
    await this.tokens.revokeAllForUser(id);
    return updated;
  }

  /**
   * One user, with the state that explains their situation.
   *
   * `activeSessions` counts refresh tokens that would still work — unrevoked and
   * unexpired. It is the honest answer to "is this person logged in somewhere",
   * which is what an administrator is really asking before they reset a password
   * or delete an account.
   */
  async findOne(id: string): Promise<ManagedUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user === null) throw new NotFoundException('No such user.');

    const activeSessions = await this.prisma.refreshToken.count({
      where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
    });

    return {
      ...toManagedUser(user),
      updatedAt: user.updatedAt.toISOString(),
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil === null ? null : user.lockedUntil.toISOString(),
      activeSessions,
      // Never the hash itself, not even its length. This object crosses the
      // wire to a browser.
      hasLocalPassword: user.passwordHash !== null,
    };
  }

  /**
   * Permanent deletion. Distinct from `deactivate`, which is reversible.
   *
   * The audit trail SURVIVES: `AuditLog.actor` is `onDelete: SetNull`, so what
   * this user did remains recorded, with the actor column emptied. That would
   * leave rows nobody can attribute, so the email is copied into this
   * deletion's own audit metadata — the trail then reads "X deleted
   * user@example.com" and the orphaned rows have a referent.
   *
   * The same three guards as `update`, because the consequences are strictly
   * worse here and every one of them is reachable by a misclick on a row.
   */
  async remove(id: string, actor: AuthenticatedPrincipal, context: AuditContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (user === null) throw new NotFoundException('No such user.');

      if (id === actor.userId) {
        throw new ForbiddenException('You cannot delete your own account.');
      }

      // Same rule as update(), for the same reason (ADR-0018 §4). Deleting the
      // last holder of either permission is a lockout, and keying this one on
      // the name while update() keys on the permission is precisely the drift
      // that lets one path enforce a rule the other does not.
      for (const permission of ['users:manage', 'settings:manage'] as const) {
        const remaining = await tx.user.count({
          where: { isActive: true, id: { not: id }, roleRef: { permissions: { has: permission } } },
        });

        if (remaining === 0) {
          throw new ConflictException(
            `This is the last active user whose role grants "${permission}". Give another ` +
              'account a role that grants it first, or nobody will be able to administer ' +
              'this deployment.',
          );
        }
      }

      // Audit BEFORE the delete, in the same transaction: afterwards the row is
      // gone and its email with it, and an audit write that fails must take the
      // deletion down with it rather than leave an unexplained absence.
      await this.record(
        tx,
        actor,
        context,
        'user.delete',
        id,
        {
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          isActive: user.isActive,
        },
        null,
      );

      // Refresh tokens cascade. Audit rows do not — they SetNull and remain.
      await tx.user.delete({ where: { id } });
    });
  }

  /** A user changing their own password. Requires the current one. */
  async changeOwnPassword(
    actor: AuthenticatedPrincipal,
    currentPassword: string,
    newPassword: string,
    context: AuditContext,
    /** The caller's own refresh token, so their session is the one spared. */
    currentRefreshToken?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (user === null || user.passwordHash === null) {
      // An externally-authenticated account has no local password to change.
      throw new BadRequestException('This account does not use a local password.');
    }

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ForbiddenException('Current password is incorrect.');
    }

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: actor.userId }, data: { passwordHash } });
      await this.record(tx, actor, context, 'user.password.change', actor.userId, null, null);
    });

    // Every OTHER session dies. A password change is usually a response to a
    // suspected compromise, and leaving existing sessions alive would defeat
    // the point.
    //
    // The caller's own session is spared, which is what the form has always
    // promised — "this signs you out of every other session". It did not: this
    // call revoked every token including the caller's, so the person changing
    // their password was silently logged out at their next refresh, up to one
    // access-token lifetime later. Reported by an operator who read the message
    // and asked why their own session should end.
    //
    // Sparing it is also the correct behaviour on its own terms: they have just
    // proved possession of the current password.
    await this.tokens.revokeAllForUser(actor.userId, currentRefreshToken);
  }

  /** An administrator setting someone else's password. */
  async resetPassword(
    id: string,
    newPassword: string,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user === null) throw new NotFoundException('No such user.');

    // A directory account has no local password to set, and setting one is
    // worse than a no-op.
    //
    // Since ADR-0015 a login dispatches strictly on authSource, so a hash
    // written here could never authenticate anybody — the local provider is
    // never asked about an `ldap` account. What it WOULD do is leave a
    // credential on disk for an identity the directory owns, which is the exact
    // hazard the create-user dialog already refuses to create: "a stored hash
    // would keep it usable through local auth after the directory revoked
    // access". Offering the action and silently doing nothing useful is the
    // worst of the three options.
    if (user.authSource !== 'local') {
      throw new BadRequestException(
        `${user.email} is authenticated by "${user.authSource}", not by a local password. ` +
          'Reset it in that directory instead.',
      );
    }

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await this.record(tx, actor, context, 'user.password.reset', id, null, {
        email: user.email,
      });
    });

    await this.tokens.revokeAllForUser(id);
  }

  /**
   * Move an account to a different authentication source (ADR-0023 §2).
   *
   * An EDIT, never a delete and recreate. `email` is globally unique, so the
   * two rows could not coexist anyway — and a delete would take the account's
   * role, its history and every audit row naming it as a subject, leaving a
   * window in which the person cannot sign in at all.
   */
  async moveAuthSource(
    id: string,
    input: MoveAuthSource,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ManagedUser> {
    const target = input.authSource.trim().toLowerCase();

    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (before === null) throw new NotFoundException('No such user.');

      if (before.authSource === target) {
        throw new ConflictException(`${before.email} is already authenticated by "${target}".`);
      }

      /*
       * Not your own account, ever.
       *
       * A privilege boundary rather than a courtesy: moving yourself to a
       * directory clears your password and hands the decision of whether you
       * may sign in to a system you may not control. The "last administrator"
       * guard would not catch it, because another administrator existing does
       * not make locking yourself out deliberate.
       */
      if (id === actor.userId) {
        throw new ForbiddenException(
          'You cannot change your own authentication source. Ask another administrator.',
        );
      }

      /*
       * Refuse a source nothing provides.
       *
       * The resolver dispatches strictly on `authSource` and refuses an account
       * naming a source it has no provider for — so this would produce a row
       * that looks configured and can never log in, discovered by the person it
       * locks out. Local is always available; core binds it unconditionally.
       */
      if (!this.providers.sources().includes(target)) {
        throw new BadRequestException(
          `This deployment cannot authenticate against "${target}". ` +
            `Configured sources: ${this.providers.sources().join(', ')}.`,
        );
      }

      const toLocal = target === 'local';

      if (toLocal && input.password === undefined) {
        throw new BadRequestException(
          `Moving ${before.email} to local authentication needs a password. ` +
            'An account with neither a password nor a directory cannot sign in at all.',
        );
      }

      if (!toLocal && input.password !== undefined) {
        throw new BadRequestException(
          `A password cannot be set for an account authenticated by "${target}". ` +
            'The directory holds the credential.',
        );
      }

      /*
       * The hash is cleared in the SAME write, not a second one that can fail
       * on its own. A leftover hash on an account moved to a directory is a
       * credential that outlives whatever that directory revokes. Strict
       * dispatch (ADR-0015 §1) makes it inert rather than exploitable, and
       * inert is not a reason to keep a credential.
       */
      const passwordHash = toLocal ? await hashPassword(input.password ?? '') : null;

      const after = await tx.user.update({
        where: { id },
        data: { authSource: target, passwordHash },
      });

      await this.record(
        tx,
        actor,
        context,
        'user.auth-source.move',
        id,
        { email: before.email, authSource: before.authSource },
        { email: after.email, authSource: after.authSource },
      );

      return after;
    });

    /*
     * Revoked AFTER the commit, as password reset does.
     *
     * "Sessions do not survive the move" means refresh tokens: an access token
     * already issued lives out its remaining minutes, which is ADR-0015's
     * recorded decision for a deregistered provider and the same trade here.
     * Refreshing re-resolves through the NEW source, which is what must not be
     * bypassed.
     */
    await this.tokens.revokeAllForUser(id);

    return toManagedUser(updated);
  }

  private async record(
    tx: AuditTx,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.audit.record(
      {
        actorUserId: actor.userId,
        actorEmail: actor.email,
        action,
        entityType: 'User',
        entityId,
        before,
        after,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );
  }
}

type AuditTx = { auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> } };

export interface AuditContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  authSource: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

function toManagedUser(user: UserRow): ManagedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role as ManagedUser['role'],
    isActive: user.isActive,
    authSource: user.authSource,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * The id of the seeded role with this name (ADR-0018 §1).
 *
 * Every write that sets `role` also sets `roleId`, so the column is never
 * partially populated and the migration that makes it NOT NULL has nothing left
 * to do. Nothing reads it yet — this is the expand half of expand/migrate.
 *
 * Throws rather than returning null if the row is missing. A seeded built-in
 * absent from the table means the migration did not run, and continuing would
 * write a user the next release cannot resolve permissions for. Failing at the
 * point of the write names the cause; failing later would not.
 */
export async function builtInRoleId(
  tx: { role: { findUnique(args: { where: { name: string } }): Promise<{ id: string } | null> } },
  name: string,
): Promise<string> {
  const row = await tx.role.findUnique({ where: { name } });

  if (row === null) {
    throw new Error(
      `No role named "${name}" exists. The built-in roles are seeded by the ` +
        'roles_table migration; this deployment has not run it.',
    );
  }

  return row.id;
}

/**
 * Resolves a role name supplied by a CLIENT.
 *
 * Separate from `builtInRoleId`, which resolves names this codebase chose and
 * treats absence as a broken deployment — a 500 is right there. A name that
 * arrived in a request body is different: absence means the caller asked for
 * something that does not exist, which is a 400, and the answer has to say
 * which names would have worked. Since ADR-0018 the valid set is a table, so
 * "one of VIEWER, OPERATOR, ADMIN" is no longer a safe thing to assume.
 */
export async function assignableRoleId(
  tx: {
    role: {
      findUnique(args: { where: { name: string } }): Promise<{ id: string } | null>;
      findMany(args: { select: { name: true } }): Promise<Array<{ name: string }>>;
    };
  },
  name: string,
): Promise<string> {
  const row = await tx.role.findUnique({ where: { name } });
  if (row !== null) return row.id;

  const known = (await tx.role.findMany({ select: { name: true } })).map((r) => r.name);
  throw new BadRequestException(
    `No role named "${name}" exists. This deployment has: ${known.sort().join(', ')}.`,
  );
}
