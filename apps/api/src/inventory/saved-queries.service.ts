import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_SINK,
  AUTHORIZATION_POLICY,
  createSavedQuerySchema,
  nodeFilterSchema,
  resourceFilterSchema,
  savedQueryKindSchema,
  type AuthenticatedPrincipal,
  type CreateSavedQuery,
  type IAuditSink,
  type IAuthorizationPolicy,
  type Permission,
  type SavedQuery,
  type SavedQueryKind,
  type UpdateSavedQuery,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuditContext } from '../auth/users.service';

/**
 * Saved queries (ADR-0026).
 *
 * A filter somebody kept, and may have shared. The first per-user object in the
 * product — everything else is global — so ownership and visibility are decided
 * here rather than borrowed from an existing pattern.
 */

/** Which permission a kind requires to be RUN, and therefore to be seen (§3). */
const PERMISSION_FOR: Record<SavedQueryKind, Permission> = {
  node: 'inventory:read',
  resource: 'resources:read',
};

@Injectable()
export class SavedQueriesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    @Inject(AUTHORIZATION_POLICY) private readonly policy: IAuthorizationPolicy,
  ) {}

  /**
   * What this caller may see: their own, plus shared ones they could run.
   *
   * FILTERED SERVER-SIDE, and that is the point (§3). A resource query shared
   * by an admin must not appear at all to somebody without `resources:read` —
   * not greyed out, not disabled. A NAME IS INFORMATION: "sudoers on the
   * payment boxes" discloses what somebody is watching, and `can()` in the UI
   * is a convenience, never a security control.
   */
  async list(principal: AuthenticatedPrincipal): Promise<SavedQuery[]> {
    const rows = await this.prisma.savedQuery.findMany({
      where: { OR: [{ userId: principal.userId }, { isShared: true }] },
      orderBy: [{ name: 'asc' }],
    });

    return rows
      .filter((row) => {
        const kind = this.kindOf(row.kind);
        // Own queries are always visible to their owner. Losing sight of
        // something you saved because a permission changed would look like
        // data loss, and the filter it holds is one you wrote yourself.
        if (row.userId === principal.userId) return true;
        return this.policy.can(principal, PERMISSION_FOR[kind]);
      })
      .map((row) => this.toContract(row, principal));
  }

  async create(
    input: CreateSavedQuery,
    principal: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<SavedQuery> {
    const parsed = createSavedQuerySchema.parse(input);

    // You cannot save what you cannot run. Otherwise the list becomes a place
    // to author queries for somebody else to execute.
    this.assertMayRun(principal, parsed.kind);

    const existing = await this.prisma.savedQuery.findFirst({
      where: { userId: principal.userId, name: parsed.name },
    });
    if (existing !== null) {
      throw new ConflictException('You already have a saved query with that name.');
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.savedQuery.create({
        data: {
          userId: principal.userId,
          ownerEmail: principal.email,
          name: parsed.name,
          kind: parsed.kind,
          filter: parsed.filter as object,
          isShared: parsed.isShared,
        },
      });

      /*
       * CREATING IS NOT AUDITED; SHARING IS (§5).
       *
       * A private query changes nothing for anybody else, and a row per save
       * would bury the events that matter. Creating one already shared is a
       * sharing event, so it is recorded as one.
       */
      if (created.isShared) {
        await this.recordShare(tx, principal, context, created.id, created.name, false, true);
      }
      return created;
    });

    return this.toContract(row, principal);
  }

  async update(
    id: string,
    input: UpdateSavedQuery,
    principal: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<SavedQuery> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.savedQuery.findUnique({ where: { id } });
      if (row === null) throw new NotFoundException('No such saved query.');
      this.assertMayModify(row, principal);

      const next = await tx.savedQuery.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.isShared === undefined ? {} : { isShared: input.isShared }),
        },
      });

      if (input.isShared !== undefined && input.isShared !== row.isShared) {
        await this.recordShare(
          tx,
          principal,
          context,
          row.id,
          next.name,
          row.isShared,
          next.isShared,
        );
      }

      return this.toContract(next, principal);
    });
  }

  async remove(
    id: string,
    principal: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.savedQuery.findUnique({ where: { id } });
      if (row === null) throw new NotFoundException('No such saved query.');
      this.assertMayModify(row, principal);

      // Deleting a SHARED query removes it from everybody, so it is recorded
      // for the same reason sharing is. Deleting a private one is not.
      if (row.isShared) {
        await this.audit.record(
          {
            actorUserId: principal.userId,
            actorEmail: principal.email,
            action: 'saved-query.delete',
            entityType: 'SavedQuery',
            entityId: row.id,
            entityLabel: row.name,
            before: { name: row.name, isShared: true, ownerEmail: row.ownerEmail },
            after: null,
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ?? null,
          },
          tx as never,
        );
      }

      await tx.savedQuery.delete({ where: { id } });
    });
  }

  /**
   * The filter, validated again on the way out.
   *
   * A row written by an older version — or by hand — must not reach PqlBuilder
   * unchecked just because it is in our own database. `filter` is `Json`, which
   * the database will hold whatever we put in.
   */
  parseFilter(kind: SavedQueryKind, filter: unknown): unknown {
    return kind === 'node' ? nodeFilterSchema.parse(filter) : resourceFilterSchema.parse(filter);
  }

  private kindOf(raw: string): SavedQueryKind {
    const parsed = savedQueryKindSchema.safeParse(raw);
    // An unrecognised kind is treated as the more restrictive one rather than
    // the more permissive: a row this version cannot interpret must not be
    // shown to somebody a future version would have hidden it from.
    return parsed.success ? parsed.data : 'resource';
  }

  private assertMayRun(principal: AuthenticatedPrincipal, kind: SavedQueryKind): void {
    if (!this.policy.can(principal, PERMISSION_FOR[kind])) {
      throw new ForbiddenException(`You cannot run ${kind} queries.`);
    }
  }

  /**
   * Owner, or `users:manage` (§5).
   *
   * The admin path is the escape hatch for somebody having left with a shared
   * query that is now wrong. Without it, the only fix is a database edit.
   */
  private assertMayModify(row: { userId: string | null }, principal: AuthenticatedPrincipal): void {
    if (row.userId === principal.userId) return;
    if (this.policy.can(principal, 'users:manage')) return;
    throw new ForbiddenException('Only the owner of a saved query can change it.');
  }

  private async recordShare(
    tx: unknown,
    principal: AuthenticatedPrincipal,
    context: AuditContext,
    id: string,
    name: string,
    before: boolean,
    after: boolean,
  ): Promise<void> {
    await this.audit.record(
      {
        actorUserId: principal.userId,
        actorEmail: principal.email,
        action: after ? 'saved-query.share' : 'saved-query.unshare',
        entityType: 'SavedQuery',
        entityId: id,
        entityLabel: name,
        // A normal write audit, in the change's own transaction — unlike
        // ADR-0025 §6's read events, this IS a change and takes ADR-0005's
        // shape without amendment.
        before: { isShared: before },
        after: { isShared: after },
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx as never,
    );
  }

  private toContract(
    row: {
      id: string;
      userId: string | null;
      ownerEmail: string;
      name: string;
      kind: string;
      filter: unknown;
      isShared: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
    principal: AuthenticatedPrincipal,
  ): SavedQuery {
    return {
      id: row.id,
      name: row.name,
      kind: this.kindOf(row.kind),
      filter: row.filter,
      isShared: row.isShared,
      ownerEmail: row.ownerEmail,
      // Decided here, not in the browser: the UI shows the owner beside shared
      // entries so two people's "Ubuntu boxes" are tellable apart (§6).
      isMine: row.userId !== null && row.userId === principal.userId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
