import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AUDIT_SINK,
  type BlockingRoleMapping,
  type CreateRole,
  type IAuditSink,
  type Permission,
  type Role,
  type UpdateRole,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from './auth.guard';
import { RoleRegistry } from './role-registry';

/**
 * Permissions without which nobody can administer the deployment.
 *
 * Both, not either: users:manage alone leaves nobody able to configure it,
 * settings:manage alone leaves nobody able to grant it back (ADR-0018 §4).
 */
const ADMINISTRATIVE: readonly Permission[] = ['users:manage', 'settings:manage'];

/** Where the deployment's directory mappings can be read from. */
export interface MappingSource {
  /** Every configured mapping, with where it came from. */
  all(): Promise<Array<BlockingRoleMapping & { role: string }>>;
}

/**
 * Creating, editing and deleting roles (ADR-0018).
 *
 * Every guard here exists to stop a change that cannot be undone from inside
 * the product. A role deleted while a directory maps a group to it does not
 * fail loudly — those users simply stop being able to do anything at their next
 * sign-in, and the cause is a role that is no longer there to look at.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    private readonly registry: RoleRegistry,
    private readonly mappings: MappingSource,
  ) {}

  async list(): Promise<Role[]> {
    const rows = await this.prisma.role.findMany({
      orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: { where: { isActive: true } } } } },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      permissions: row.permissions as Permission[],
      builtIn: row.builtIn,
      userCount: row._count.users,
    }));
  }

  async create(input: CreateRole, request: AuthenticatedRequest): Promise<Role> {
    const existing = await this.prisma.role.findUnique({ where: { name: input.name } });
    if (existing !== null) {
      throw new ConflictException(`A role named "${input.name}" already exists.`);
    }

    const created = await this.prisma.role.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        permissions: input.permissions,
        builtIn: false,
      },
    });

    await this.record(request, 'role.create', created.id, null, {
      name: created.name,
      permissions: created.permissions,
    });
    // Before returning, so the next request already decides with it.
    await this.registry.invalidate();

    return { ...created, permissions: created.permissions as Permission[], userCount: 0 };
  }

  async update(id: string, input: UpdateRole, request: AuthenticatedRequest): Promise<Role> {
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (before === null) throw new NotFoundException('No such role.');

    if (input.permissions !== undefined) {
      await this.assertAdministrationSurvives(before.name, input.permissions);
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
      },
      include: { _count: { select: { users: { where: { isActive: true } } } } },
    });

    await this.record(
      request,
      'role.update',
      id,
      { name: before.name, permissions: before.permissions },
      { name: updated.name, permissions: updated.permissions },
    );
    await this.registry.invalidate();

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      permissions: updated.permissions as Permission[],
      builtIn: updated.builtIn,
      userCount: updated._count.users,
    };
  }

  async remove(id: string, request: AuthenticatedRequest): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (role === null) throw new NotFoundException('No such role.');

    if (role.builtIn) {
      throw new ConflictException(
        `"${role.name}" is a built-in role and cannot be deleted. Its name appears in directory ` +
          "mappings, in audit history, and in other people's runbooks.",
      );
    }

    if (role._count.users > 0) {
      throw new ConflictException(
        `${role._count.users} user(s) still hold "${role.name}". Move them to another role first ` +
          '— deleting it would leave accounts that authenticate and are then denied everything.',
      );
    }

    /*
     * The guard this whole method exists for.
     *
     * A directory mapping naming a deleted role does not fail at deletion time.
     * It fails at somebody's next sign-in, silently, by resolving to no
     * permissions — and the thing to look at is a role that is no longer there.
     *
     * So the mappings are NAMED. "Role is in use" tells an operator a fact they
     * already suspected and none of what they need: which entry, in which
     * configuration, to go and change.
     */
    const blocking = await this.blockingMappings(role.name);
    if (blocking.length > 0) {
      throw new ConflictException({
        error: 'ROLE_REFERENCED_BY_MAPPING',
        message:
          `"${role.name}" is still mapped from ${blocking.length} directory group(s). ` +
          'Remove or repoint these mappings first, otherwise anybody in them would sign in ' +
          'with no permissions and nothing left to explain why:\n' +
          blocking.map((m) => `  • ${m.groupDn}  (${describeSource(m.source)})`).join('\n'),
        role: role.name,
        blockingMappings: blocking,
      });
    }

    await this.assertAdministrationSurvivesDeletion(role.name);

    await this.prisma.role.delete({ where: { id } });
    await this.record(
      request,
      'role.delete',
      id,
      { name: role.name, permissions: role.permissions },
      null,
    );
    await this.registry.invalidate();
  }

  /** Directory mappings pointing at this role, whatever configured them. */
  private async blockingMappings(roleName: string): Promise<BlockingRoleMapping[]> {
    const all = await this.mappings.all();
    return all
      .filter((mapping) => mapping.role === roleName)
      .map(({ groupDn, source }) => ({ groupDn, source }));
  }

  /**
   * Refuse an edit that would leave nobody able to administer the deployment.
   *
   * Counted across every OTHER role, because this one is about to change.
   */
  private async assertAdministrationSurvives(
    roleName: string,
    next: readonly Permission[],
  ): Promise<void> {
    for (const permission of ADMINISTRATIVE) {
      if (next.includes(permission)) continue;

      const elsewhere = await this.prisma.user.count({
        where: {
          isActive: true,
          roleRef: { name: { not: roleName }, permissions: { has: permission } },
        },
      });

      if (elsewhere === 0) {
        throw new ConflictException(
          `Removing "${permission}" from "${roleName}" would leave nobody able to administer ` +
            'this deployment. Grant it to another role, and give somebody that role, first.',
        );
      }
    }
  }

  private async assertAdministrationSurvivesDeletion(roleName: string): Promise<void> {
    for (const permission of ADMINISTRATIVE) {
      const elsewhere = await this.prisma.user.count({
        where: {
          isActive: true,
          roleRef: { name: { not: roleName }, permissions: { has: permission } },
        },
      });

      if (elsewhere === 0) {
        throw new ConflictException(
          `Deleting "${roleName}" would leave nobody able to administer this deployment — no ` +
            `other role held by an active user grants "${permission}".`,
        );
      }
    }
  }

  private async record(
    request: AuthenticatedRequest,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    const actor = request.principal;
    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action,
      entityType: 'Role',
      entityId,
      before,
      after,
      ipAddress: request.ip ?? null,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
  }
}

function describeSource(source: BlockingRoleMapping['source']): string {
  return source === 'database'
    ? 'configured on the Directory settings screen'
    : 'configured in this deployment’s environment';
}
