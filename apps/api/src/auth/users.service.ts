import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AUDIT_SINK, AUTH_PROVIDER } from '@nexuspuppet/contracts';
import type {
  AuthenticatedPrincipal,
  CreateUser,
  IAuditSink,
  IAuthProvider,
  ManagedUser,
  ManagedUserDetail,
  UpdateUser,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';
import { hashPassword, verifyPassword } from './password';
import { normalizeEmail } from './local-auth.provider';

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
    @Inject(AUTH_PROVIDER) private readonly authProvider: IAuthProvider,
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

    // An account whose authSource no configured provider answers to can never
    // be authenticated. Creating one silently is how an operator ends up with a
    // user list full of accounts that cannot log in, with no error to explain
    // it. 'local' stays allowed regardless: dropping back to the core edition
    // must not orphan the accounts created before it.
    if (authSource !== 'local' && authSource !== this.authProvider.source) {
      throw new BadRequestException(
        `No configured provider authenticates "${authSource}". This deployment uses ` +
          `"${this.authProvider.source}". Use that, or "local" for a password account.`,
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

      const losesAdmin =
        (input.role !== undefined && input.role !== 'ADMIN' && before.role === 'ADMIN') ||
        (input.isActive === false && before.role === 'ADMIN');

      if (losesAdmin) {
        // Counted inside the transaction so a concurrent demotion cannot slip
        // past the check and leave the deployment with none.
        const remaining = await tx.user.count({
          where: { role: 'ADMIN', isActive: true, id: { not: id } },
        });

        if (remaining === 0) {
          throw new ConflictException(
            'This is the last active administrator. Promote another user first, ' +
              'or nobody will be able to administer this deployment.',
          );
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

      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.role === undefined ? {} : { role: input.role }),
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

      if (user.role === 'ADMIN') {
        const remaining = await tx.user.count({
          where: { role: 'ADMIN', isActive: true, id: { not: id } },
        });

        if (remaining === 0) {
          throw new ConflictException(
            'This is the last active administrator. Promote another user first, ' +
              'or nobody will be able to administer this deployment.',
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

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await this.record(tx, actor, context, 'user.password.reset', id, null, {
        email: user.email,
      });
    });

    await this.tokens.revokeAllForUser(id);
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
