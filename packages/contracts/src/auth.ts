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

/**
 * What the caller submits to log in.
 *
 * The field is NOT validated as an email address. Active Directory users
 * commonly sign in with a `sAMAccountName` — `jdoe`, or `CORP\\jdoe` — and a
 * strict email check rejects those at the API boundary with a 400, before the
 * provider that understands them ever sees the request. The identifier's
 * meaning belongs to the provider: core's local accounts treat it as an email
 * and normalise it, LDAP matches it against whatever `LDAP_SEARCH_FILTER`
 * names.
 *
 * It keeps the name `email` because that is what it is for every provider core
 * ships, and renaming the wire field would break every existing client for a
 * case that only arises with the enterprise layer installed.
 *
 * Length is still bounded: an unbounded identifier is a free memcpy into
 * whatever the directory does with it.
 */
export const credentialsSchema = z.object({
  email: z.string().min(1).max(255),
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

  /**
   * What to call the identifier on the login form — 'Email', 'Username'.
   *
   * A form labelled "Email" in front of a directory that expects
   * `sAMAccountName` tells every user to type the wrong thing. Defaults to
   * 'Email', which is correct for local accounts and for the usual LDAP setup.
   */
  readonly identifierLabel?: string;

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

  /**
   * Describe this provider's configuration for an administrator.
   *
   * Optional: a provider with nothing worth showing may omit it, and core falls
   * back to reporting only the source. Whatever is returned is rendered in a
   * browser — see AuthProviderDescription for what must never appear in it.
   */
  describe?(): AuthProviderDescription;
}

/** A directory group and the role it grants. */
export interface RoleMapping {
  /** The group as the directory names it — a DN for LDAP, a claim value for OIDC. */
  group: string;
  role: UserRole;
}

/**
 * What an authentication provider will tell an administrator about itself.
 *
 * Exists so the console can show WHO GETS WHICH ROLE without core knowing what
 * LDAP is. A provider decides what is safe to surface; core renders it blindly.
 *
 * IMPLEMENTORS — THIS IS DISPLAYED IN A BROWSER. It must never contain a bind
 * password, a client secret, a token, or a private key. `details` is for
 * connection facts an administrator needs in order to recognise a
 * misconfiguration — a URL, a search base — not for credentials. When in doubt,
 * leave it out: an operator can read the deployment's environment, and a
 * secret rendered in a page ends up in screenshots and support tickets.
 */
export interface AuthProviderDescription {
  /** Matches IAuthProvider.source. */
  source: string;
  /**
   * Group-to-role mappings applied at each login, in the provider's own order.
   * Empty for a provider that does not derive roles from group membership.
   */
  roleMappings: RoleMapping[];
  /**
   * Whether someone who authenticates but matches no mapping is REFUSED.
   *
   * The alternative — granting a default role — silently gives everyone the
   * directory contains access to the estate inventory, so an administrator
   * needs to be able to see which behaviour is in force.
   */
  refusesUnmappedUsers: boolean;
  /** Display-safe connection facts. Never secrets. */
  details: Array<{ label: string; value: string }>;
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

/**
 * A user as the DIRECTORY sees them, which is not the same as a principal.
 *
 * `AuthenticatedPrincipal` answers "who is this?" and only ever describes
 * someone who has already authenticated — it flows into the JWT. A directory
 * entry also has to answer "may they?", which is why account status appears
 * here and not there. An auth provider that cannot see `isActive` cannot
 * enforce a deactivation, and a suspended employee keeps their access.
 */
export interface DirectoryUser extends AuthenticatedPrincipal {
  isActive: boolean;
}

/** User lifecycle. Core backs this with Postgres; enterprise may back it with a directory. */
export interface IUserDirectory {
  readonly readOnly: boolean;
  findByEmail(email: string): Promise<DirectoryUser | null>;

  /**
   * Look up by the identifier carried in a session.
   *
   * Required because an external auth provider (LDAP, SAML) authenticates
   * against a directory but must still return a principal whose `userId` is a
   * row in this application — `refresh_tokens` and `audit_logs` both hold a
   * foreign key to it. Without this, such a provider cannot re-resolve a
   * principal on token refresh, and a deactivation would not take effect until
   * the refresh window expired.
   */
  findById(userId: string): Promise<DirectoryUser | null>;

  /**
   * Record what an external authority asserted at a successful login: the role
   * derived from directory group membership, and the current display name.
   *
   * Exists so that `IAuthProvider.resolve()` on token refresh agrees with what
   * `authenticate()` decided. Without it the two paths can disagree about what
   * a user may do — the login says ADMIN from a group, the refresh reads a
   * stale row and says VIEWER.
   *
   * IMPLEMENTORS: a directory-backed implementation whose `readOnly` is true
   * may treat this as a no-op. CALLERS: treat a rejection as non-fatal. The
   * person supplied valid credentials; a failure to cache that is not their
   * problem and must not deny them a session.
   */
  recordLogin(userId: string, update: { role: UserRole; displayName: string }): Promise<void>;

  list(options: { limit: number; offset: number }): Promise<{
    users: DirectoryUser[];
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
  /**
   * @returns the stable id of the stored record.
   *
   * Returned rather than void because a sink that COMPOSES over another has to
   * be able to refer to what the delegate wrote — to queue it for delivery, to
   * correlate it, to reference it in an external system. Without this a
   * wrapping sink can observe that a record was written and never say which.
   */
  record(entry: AuditRecord, tx?: AuditTransaction): Promise<string>;
}

/**
 * The database transaction an audited change is being made in (ADR-0005).
 *
 * Opaque on purpose: contracts must stay dependency-free, so it cannot name a
 * Prisma client. The core sink narrows it to one; a sink that forwards to a
 * SIEM ignores it and writes after the fact.
 *
 * This parameter is why the seam was inert. The interface used to take only the
 * record, while a classification change and its audit row must commit together
 * — so both callers reached past the token for the concrete class that did
 * accept a transaction, and an enterprise sink registered under AUDIT_SINK
 * would never have been called. An interface that understates its contract does
 * not get used.
 */
export type AuditTransaction = object;

/**
 * One audit record, flattened for delivery to an external system.
 *
 * Deliberately NOT the Prisma row. A transport lives in the enterprise layer,
 * which has no database access and must not depend on core's schema — so this
 * carries everything a payload needs and nothing that ties it to storage.
 * `createdAt` is ISO-8601 rather than a Date for the same reason: it is about
 * to be serialised.
 */
export interface AuditDeliveryEntry {
  /** Stable identity of the record. A transport SHOULD dedupe on it. */
  auditLogId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  /** ISO-8601. */
  createdAt: string;
}

/**
 * Queues an audit record for delivery to an external system.
 *
 * The only part of the delivery machinery a capability touches. Core owns the
 * table, the leases, the retries and the worker; a forwarding sink decides
 * WHICH records are worth sending and enqueues those.
 *
 * `enqueue` MUST be called inside the same transaction as the record it refers
 * to (ADR-0005). Outside it, a crash between the two leaves a committed change
 * that no external system will ever hear about.
 */
export interface IAuditDeliveryOutbox {
  enqueue(tx: AuditTransaction, auditLogId: string): Promise<void>;
}

/**
 * Sends audit records somewhere outside NexusPuppet — syslog, a SIEM, a webhook.
 *
 * Called by core's delivery worker OUTSIDE any database transaction, so an
 * implementation is free to take as long as the network takes (ADR-0005).
 *
 * `deliver` MUST throw if the batch was not accepted. A silent failure is the
 * one outcome that must not happen: the worker treats a return as proof of
 * delivery and removes the records from the queue.
 *
 * Delivery is at-least-once. A worker that dies mid-flight re-sends when the
 * lease expires, so implementations should be idempotent on `auditLogId`.
 */
export interface IAuditTransport {
  /** Named in logs and on the settings screen, e.g. `syslog` or `webhook`. */
  readonly name: string;
  /**
   * Whether this transport can actually send.
   *
   * A transport that is installed but unconfigured — no URL, no credentials —
   * reports false, and the worker leaves the queue alone rather than draining
   * records into nothing. Core's default reports false because core forwards
   * nowhere.
   */
  readonly configured: boolean;
  deliver(entries: readonly AuditDeliveryEntry[]): Promise<void>;
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

export const createUserSchema = z
  .object({
    email: z.string().email().max(255),
    displayName: z.string().min(1).max(128),
    role: userRoleSchema,
    /**
     * Which authority owns this account's credentials. `local` means a password
     * held here; anything else names an external provider (LDAP, SAML, OIDC).
     *
     * External providers authenticate a person against a directory but still
     * need a row here, because `AuthenticatedPrincipal.userId` is a foreign key
     * from refresh_tokens and audit_logs. Without a way to create one, an LDAP
     * deployment has no accounts and nobody can log in at all.
     */
    authSource: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, 'authSource must be lowercase alphanumeric')
      .default('local'),
    /**
     * Long minimum rather than a composition rule. Length dominates entropy, and
     * character-class rules mostly produce `Password1!` — memorised, reused, and
     * no stronger than a longer passphrase.
     */
    password: z.string().min(12).max(1024).optional(),
  })
  .refine((input) => input.authSource !== 'local' || input.password !== undefined, {
    message: 'A local account requires a password.',
    path: ['password'],
  })
  /**
   * An externally-authenticated account must NOT carry a password hash. If it
   * did, the account would remain usable through local authentication after the
   * directory revoked the person's access — and would silently become a
   * password login again if the deployment ever dropped back to the core
   * edition. The directory must be the only way in.
   */
  .refine((input) => input.authSource === 'local' || input.password === undefined, {
    message: 'An externally-authenticated account must not be given a password.',
    path: ['password'],
  });
/** The VALIDATED shape, as the API sees it after parsing: authSource resolved. */
export type CreateUser = z.infer<typeof createUserSchema>;
/**
 * What a CALLER supplies, with authSource still optional.
 *
 * Distinct from CreateUser because `.default('local')` makes the field required
 * on the way out and optional on the way in. Without this, every caller that
 * only wants a plain local account would have to spell out `authSource:
 * 'local'`.
 */
export type CreateUserInput = z.input<typeof createUserSchema>;

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

/**
 * Everything the Users table shows, plus the state that explains a user's
 * situation rather than merely listing it.
 *
 * Kept separate from `ManagedUser` because the list endpoint returns one row per
 * user and these fields cost a join each. The detail view fetches one user, so
 * it can afford them — and they are exactly what an administrator opens a user
 * to find out: why can they not log in, and are they logged in right now.
 */
export interface ManagedUserDetail extends ManagedUser {
  updatedAt: string;
  /** Consecutive failed password attempts; zero after any success. */
  failedLoginAttempts: number;
  /** Set while the account is locked out. Null means not locked. */
  lockedUntil: string | null;
  /** Unrevoked, unexpired refresh tokens — i.e. sessions that still work. */
  activeSessions: number;
  /**
   * False for directory-owned accounts, which have no local password to reset.
   * The UI needs this to disable the control rather than offer an action that
   * cannot succeed.
   */
  hasLocalPassword: boolean;
}

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
