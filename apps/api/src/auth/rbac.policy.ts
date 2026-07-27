import { Injectable } from '@nestjs/common';
import type {
  AuthenticatedPrincipal,
  AuthorizationTarget,
  IAuthorizationPolicy,
  Permission,
  UserRole,
} from '@nexuspuppet/contracts';

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

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
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
  can(
    principal: AuthenticatedPrincipal,
    permission: Permission,
    target?: AuthorizationTarget,
  ): boolean {
    const granted = ROLE_PERMISSIONS[principal.role];

    // An unrecognised role grants nothing. If an enterprise provider returns a
    // role core does not know, the safe reading is "no permissions", not
    // "unrestricted".
    if (granted === undefined) return false;
    if (!granted.has(permission)) return false;

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

/** Exposed for the UI, so it can hide what a user cannot use. */
export function permissionsFor(role: UserRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? new Set<Permission>())].sort();
}
