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
 * How a provider obtains a principal.
 *
 *   credentials — the caller posts an identifier and secret. Local accounts and
 *                 an LDAP bind both work this way.
 *   redirect    — the caller is sent to an external identity provider and
 *                 returns with an authorization response. SAML and OIDC.
 *
 * This exists so ROUTING stays fixed while the provider varies. `POST /auth/login`
 * is the login route under every provider; a redirect-mode provider answers it
 * with a 303 and a location instead of a session. Without this the enterprise
 * layer would have to add its own routes, and core would need to know they
 * exist — which is precisely the coupling ADR-0002 forbids.
 */
export const authModeSchema = z.enum(['credentials', 'redirect']);
export type AuthMode = z.infer<typeof authModeSchema>;

/** Where to send the browser, and the state to correlate the return leg. */
export interface RedirectChallenge {
  location: string;
  state: string;
}

/**
 * Authenticates a principal. Core registers LocalAuthProvider; the enterprise
 * layer may override the AUTH_PROVIDER token with an LDAP, SAML, or OIDC
 * provider.
 *
 * CONTRACT FOR IMPLEMENTORS
 * -------------------------
 * Everything downstream — guards, RBAC, controllers, audit — consumes only the
 * AuthenticatedPrincipal this returns. A provider must never assume how the
 * session is carried, what the token format is, or how authorization is
 * decided; those belong to core and are deliberately not part of this
 * interface. Session issuance, refresh rotation, and cookie handling stay in
 * core so that swapping the provider cannot change them.
 *
 * `mode` is the only thing that varies routing, and it varies it inside the
 * existing routes.
 */
export interface IAuthProvider {
  /** Stable identifier recorded on the principal and in audit records. */
  readonly source: string;

  /** Defaults to 'credentials' when absent, so existing providers keep working. */
  readonly mode?: AuthMode;

  /** Required for mode 'credentials'. Rejects for redirect-mode providers. */
  authenticate(credentials: Credentials): Promise<AuthResult>;

  /** Re-resolve a principal from a persisted user id, e.g. on token refresh. */
  resolve(userId: string): Promise<AuthenticatedPrincipal | null>;

  /** Required for mode 'redirect': begin the external login. */
  beginRedirect?(returnTo: string): Promise<RedirectChallenge>;

  /** Required for mode 'redirect': complete it from the callback parameters. */
  completeRedirect?(params: Record<string, string>): Promise<AuthResult>;
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

/**
 * User administration (ADR-0006).
 *
 * Core's directory is writable; an enterprise LDAP/SAML directory is read-only,
 * which is why `IUserDirectory.readOnly` exists. The UI must respect it rather
 * than offering edits that the provider will reject.
 */

export const createUserSchema = z.object({
  email: z.string().email().max(255),
  displayName: z.string().min(1).max(128),
  role: userRoleSchema,
  /**
   * Long minimum rather than a composition rule. Length dominates entropy, and
   * character-class rules mostly produce `Password1!` — memorised, reused, and
   * no stronger than a longer passphrase.
   */
  password: z.string().min(12).max(1024),
});
export type CreateUser = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  role: userRoleSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(12).max(1024),
});
export type ResetPassword = z.infer<typeof resetPasswordSchema>;

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  authSource: string;
  lastLoginAt: string | null;
  createdAt: string;
}
