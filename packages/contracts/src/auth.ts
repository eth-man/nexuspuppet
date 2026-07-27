import { z } from 'zod';
import type { CapabilityName } from './tokens';

/**
 * Authentication and authorization contracts (ADR-0006).
 *
 * Authentication and authorization are deliberately SEPARATE contracts. The
 * enterprise layer replaces authorization (scoped RBAC) without touching
 * authentication, and vice versa. Coupling them would force enterprise to
 * reimplement both in order to change one.
 */

export const userRoleSchema = z.enum(['VIEWER', 'OPERATOR', 'ADMIN']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * Everything downstream of authentication depends on this shape and never on
 * how it was obtained — local password, LDAP bind, or SAML assertion.
 */
export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
  /** Identifier of the provider that authenticated this principal, for audit. */
  authSource: string;
  /**
   * Enterprise scoped-RBAC may narrow a principal to specific groups or
   * environments. Empty/undefined means estate-wide, subject to `role`.
   */
  scopedGroupIds?: string[];
  scopedEnvironments?: string[];
}

export const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export type AuthResult =
  | { ok: true; principal: AuthenticatedPrincipal }
  | { ok: false; reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' | 'PROVIDER_ERROR' };

/**
 * Authenticates a principal. Core registers LocalAuthProvider; the enterprise
 * layer may override the AUTH_PROVIDER token with an LDAP/SAML/OIDC provider.
 */
export interface IAuthProvider {
  /** Stable identifier recorded on the principal and in audit records. */
  readonly source: string;
  authenticate(credentials: Credentials): Promise<AuthResult>;
  /** Re-resolve a principal from a persisted user id, e.g. on token refresh. */
  resolve(userId: string): Promise<AuthenticatedPrincipal | null>;
}

/** Actions the authorization policy arbitrates. Extended only alongside a new controller. */
export const permissionSchema = z.enum([
  'inventory:read',
  'reports:read',
  'classification:read',
  'classification:write',
  'materialization:trigger',
  'users:manage',
  'settings:manage',
  'pql:raw',
]);
export type Permission = z.infer<typeof permissionSchema>;

/** Optional target of a permission check, for enterprise scoped RBAC. */
export interface AuthorizationTarget {
  groupId?: string;
  environment?: string;
  certname?: string;
}

/**
 * Decides whether a principal may perform an action. Core's implementation is
 * flat role-based (ADR-0006); enterprise may replace it with a scoped policy.
 */
export interface IAuthorizationPolicy {
  can(
    principal: AuthenticatedPrincipal,
    permission: Permission,
    target?: AuthorizationTarget,
  ): boolean;
}

/** User lifecycle. Core backs this with Postgres; enterprise may back it with a directory. */
export interface IUserDirectory {
  readonly readOnly: boolean;
  findByEmail(email: string): Promise<AuthenticatedPrincipal | null>;
  list(options: { limit: number; offset: number }): Promise<{
    users: AuthenticatedPrincipal[];
    total: number;
  }>;
}

export interface AuditRecord {
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Receives audit records. Core writes to Postgres inside the same transaction
 * as the change being audited (ADR-0005); enterprise may additionally forward
 * to a SIEM.
 */
export interface IAuditSink {
  record(entry: AuditRecord): Promise<void>;
}

export interface LicenseStatus {
  licensed: boolean;
  /** Capabilities this deployment may use. Core returns an empty set. */
  capabilities: CapabilityName[];
  /** ISO-8601; absent in core. */
  expiresAt?: string;
  subject?: string;
}

/** Core's implementation reports an unlicensed deployment with no capabilities. */
export interface ILicenseService {
  status(): Promise<LicenseStatus>;
  has(capability: CapabilityName): Promise<boolean>;
}
