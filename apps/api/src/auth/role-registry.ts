import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { permissionSchema, type Permission } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long a permission change can take to reach a request.
 *
 * A revocation made through this process takes effect immediately — the write
 * path invalidates. This bounds how long a change made by ANOTHER replica goes
 * unseen, which is the only case a timer is needed for.
 */
export const REFRESH_INTERVAL_MS = 10_000;

/**
 * The roles table, held in memory so authorization can stay synchronous.
 *
 * `IAuthorizationPolicy.can()` is synchronous, and it is a published seam the
 * enterprise layer may replace (ADR-0002). Making it async to accommodate a
 * database read would change an interface other people implement, in order to
 * add a query to the hottest path in the product — every request takes it.
 *
 * So the table is read into memory instead. What that buys, and what it costs,
 * stated plainly:
 *
 * - A permission change takes effect WITHOUT a re-login, which is the property
 *   ADR-0018 §3 requires. It does not wait for a session to expire.
 * - A change made through this process is visible to the next request, because
 *   the write path calls `invalidate()`.
 * - A change made by another replica is visible within REFRESH_INTERVAL_MS.
 *   That window is the honest cost, and it is bounded and short — as against
 *   "until every session expires", which is what baking permissions into a JWT
 *   would have meant.
 *
 * FAILS CLOSED, LOUDLY. An empty registry grants nothing, so a database that
 * cannot be read denies every request rather than allowing them. The initial
 * load therefore throws at boot: a deployment that cannot read its roles must
 * not start and serve 403s that look like a permissions problem.
 */
@Injectable()
export class RoleRegistry implements OnModuleInit {
  private readonly logger = new Logger(RoleRegistry.name);
  private byName = new Map<string, ReadonlySet<Permission>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.load();

    this.timer = setInterval(() => {
      void this.load().catch((error: unknown) => {
        // A failed REFRESH keeps the previous snapshot. Emptying it because a
        // query timed out would lock every operator out of a working console.
        this.logger.error(
          `Could not refresh roles; continuing with the previous snapshot. ${describe(error)}`,
        );
      });
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** Re-read on the next opportunity. Called by anything that writes a role. */
  async invalidate(): Promise<void> {
    await this.load();
  }

  /**
   * What this role grants. Undefined for a role that does not exist.
   *
   * Undefined and empty are deliberately different: the caller can tell "no
   * such role" from "a role that grants nothing", and the first is a
   * misconfiguration worth reporting rather than a quiet denial.
   */
  permissionsFor(role: string): ReadonlySet<Permission> | undefined {
    return this.byName.get(role);
  }

  /** Every role name currently known. For diagnostics, not for authorization. */
  knownRoles(): string[] {
    return [...this.byName.keys()].sort();
  }

  private async load(): Promise<void> {
    const rows = await this.prisma.role.findMany({ select: { name: true, permissions: true } });

    const next = new Map<string, ReadonlySet<Permission>>();
    for (const row of rows) {
      // Validated on the way in. The column is a string array, so a typo
      // written by a future migration or by hand would otherwise sit in memory
      // as a permission that silently matches nothing.
      const granted = new Set<Permission>();
      for (const value of row.permissions) {
        const parsed = permissionSchema.safeParse(value);
        if (parsed.success) {
          granted.add(parsed.data);
        } else {
          this.logger.warn(
            `Role "${row.name}" lists "${value}", which is not a permission this build ` +
              'knows. It grants nothing and has been ignored.',
          );
        }
      }
      next.set(row.name, granted);
    }

    if (next.size === 0) {
      throw new Error(
        'The roles table is empty. Every request would be denied. The built-in roles are ' +
          'seeded by the roles_table migration; this deployment has not run it.',
      );
    }

    this.byName = next;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
