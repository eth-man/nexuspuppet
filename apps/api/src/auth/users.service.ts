import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuthenticatedPrincipal,
  CreateUser,
  ManagedUser,
  UpdateUser,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuditSink } from './core-capabilities';
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
    private readonly audit: PrismaAuditSink,
    private readonly tokens: TokenService,
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

    // Hashed outside the transaction: scrypt takes ~100ms by design, and
    // holding a transaction open for it would pin a connection needlessly.
    const passwordHash = await hashPassword(input.password);

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
          authSource: 'local',
        },
      });

      await this.record(tx, actor, context, 'user.create', created.id, null, {
        email: created.email,
        role: created.role,
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

  /** A user changing their own password. Requires the current one. */
  async changeOwnPassword(
    actor: AuthenticatedPrincipal,
    currentPassword: string,
    newPassword: string,
    context: AuditContext,
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

    // Every other session dies. A password change is usually a response to a
    // suspected compromise, and leaving existing sessions alive would defeat
    // the point.
    await this.tokens.revokeAllForUser(actor.userId);
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
      tx as unknown as Parameters<PrismaAuditSink['record']>[1],
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
