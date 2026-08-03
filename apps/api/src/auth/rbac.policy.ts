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
 * AUTH_PROVIDER. That separation is the point: the enterprise layer replaces
 * scoped RBAC without touching authentication, and replaces SSO without
 * touching authorization. Coupling them would force enterprise to reimplement
 * both in order to change one.
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
 * Enforce the optional scoping an enterprise provider may attach to a
 * principal.
 *
 * Core never populates `scopedGroupIds`/`scopedEnvironments`, so this is a
 * no-op for local accounts. It lives in core anyway because the ENFORCEMENT
 * must not be optional: if scope were only checked inside the enterprise
 * policy, a deployment that loaded an enterprise provider but kept the core
 * policy would silently ignore every scope restriction and hand narrow users
 * estate-wide access.
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
