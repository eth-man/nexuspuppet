import { Injectable } from '@nestjs/common';
import type {
  AuthenticatedPrincipal,
  AuthorizationTarget,
  IAuthorizationPolicy,
  Permission,
  UserRole,
} from '@nexuspuppet/contracts';
import { RoleRegistry } from './role-registry';

/**
 * Core's flat role-based authorization (ADR-0006).
 *
 * Registered under AUTHORIZATION_POLICY, which is a SEPARATE token from
 * AUTH_PROVIDER. That separation is the point: a scoped policy (not yet built)
 * could replace this without touching authentication, and directory providers
 * were added without touching authorization. Coupling them would force a
 * change to one to reimplement both.
 *
 * `can()` is a pure function of the principal and the request. It performs no
 * I/O, so it can be called on every request and reasoned about in isolation.
 */

export const SEEDED_BUILT_IN_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  VIEWER: new Set<Permission>(['inventory:read', 'reports:read', 'classification:read']),

  OPERATOR: new Set<Permission>([
    'inventory:read',
    'reports:read',
    'classification:read',
    'classification:write',
    'materialization:trigger',
  ]),

  ADMIN: new Set<Permission>([
    'inventory:read',
    'reports:read',
    'classification:read',
    'classification:write',
    'materialization:trigger',
    'users:manage',
    'settings:manage',
    // Raw PQL bypasses PqlBuilder and reaches PuppetDB with an estate-wide
    // certificate, so it is admin-only and audited (ADR-0004).
    'pql:raw',
    /*
     * Catalog resources and their parameters (ADR-0025 §3).
     *
     * ADMIN AND NOT BELOW. The disclosure this guards is real — managed file
     * contents, and credentials passed as class parameters — so VIEWER and
     * OPERATOR deliberately do not hold it. Those are the roles most people
     * actually hold, and that is where the risk lives.
     *
     * ADMIN holds it because, when it was introduced (1.8.0), otherwise NOBODY
     * could: creating a custom role then answered 501 without the enterprise
     * layer (ADR-0018), so leaving this unheld would have made the feature
     * unreachable rather than merely restricted. `pql:raw` is not an
     * alternative route — it is declared and has no endpoint.
     *
     * "An admin who manages users but must not read file contents" is a custom
     * role: every deployment can define one since ADR-0027, granting the
     * user-administration permissions without this one, and use it in place of
     * ADMIN.
     */
    'resources:read',
  ]),
};

@Injectable()
export class RbacPolicy implements IAuthorizationPolicy {
  constructor(private readonly roles: RoleRegistry) {}

  can(
    principal: AuthenticatedPrincipal,
    permission: Permission,
    target?: AuthorizationTarget,
  ): boolean {
    /*
     * From the roles table, not from a constant and not from the session
     * (ADR-0018 §3). Revoking a permission has to stop the NEXT request, not
     * the one after the operator's session happens to expire.
     *
     * `roles` when a directory mapped somebody into several at once, otherwise
     * the single `role`. The UNION is taken here rather than at login because
     * the same argument applies: a role edited after the session was issued has
     * to take effect on the next request.
     */
    const held = principal.roles ?? [principal.role];

    // An unrecognised role grants nothing. If a provider returns a role core
    // does not know — a mapping naming a role somebody deleted — the safe
    // reading is "no permissions", not "unrestricted".
    const granted = held.some((name) => this.roles.permissionsFor(name)?.has(permission) === true);

    if (!granted) return false;

    return withinScope(principal, target);
  }
}

/**
 * Enforce the optional scoping a provider may attach to a principal — scoped
 * RBAC, which is not yet built.
 *
 * Nothing populates `scopedGroupIds`/`scopedEnvironments` today, so this is a
 * no-op. It lives in the base policy anyway because the ENFORCEMENT must not be
 * optional: if scope were only checked inside a future scoped policy, a
 * deployment whose provider attached scope but kept this policy would silently
 * ignore every scope restriction and hand narrow users estate-wide access.
 */
function withinScope(
  principal: AuthenticatedPrincipal,
  target: AuthorizationTarget | undefined,
): boolean {
  if (target === undefined) return true;

  const { scopedGroupIds, scopedEnvironments } = principal;

  if (scopedGroupIds !== undefined && scopedGroupIds.length > 0) {
    // A scoped principal acting on a specific group must be scoped to it. A
    // request naming no group is unscoped and therefore allowed — the caller is
    // responsible for naming the target when one exists.
    if (target.groupId !== undefined && !scopedGroupIds.includes(target.groupId)) {
      return false;
    }
  }

  if (scopedEnvironments !== undefined && scopedEnvironments.length > 0) {
    if (target.environment !== undefined && !scopedEnvironments.includes(target.environment)) {
      return false;
    }
  }

  return true;
}

/**
 * Exposed for the UI, so it can hide what a user cannot use.
 *
 * Reads the same registry the policy does. Two sources for "what does this role
 * grant" would eventually disagree, and the way that surfaces is a console
 * offering a control the API then refuses.
 */
export function permissionsFor(
  roles: RoleRegistry,
  principal: Pick<AuthenticatedPrincipal, 'role' | 'roles'>,
): Permission[] {
  // The same union the policy takes. A console showing a subset of what the API
  // allows hides controls that would have worked; showing a superset offers
  // controls that will be refused. Both come from computing this differently.
  const held = principal.roles ?? [principal.role];
  const union = new Set<Permission>();
  for (const name of held) {
    for (const permission of roles.permissionsFor(name) ?? []) union.add(permission);
  }
  return [...union].sort();
}
