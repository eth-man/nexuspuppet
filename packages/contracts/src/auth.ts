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

/**
 * The three roles the product seeds and documents.
 *
 * NOT the set a user may hold — that is `roleNameSchema` below. This one names
 * the built-ins specifically, for the places that genuinely mean those three:
 * the seeded permission table, and a provider recomputing a built-in from
 * directory groups.
 */
export const userRoleSchema = z.enum(['VIEWER', 'OPERATOR', 'ADMIN']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * The name of any role in the `roles` table, built-in or custom (ADR-0018).
 *
 * Since roles became rows, a deployment can define its own — and a user has to
 * be able to hold one. Validating assignment against the three-value enum meant
 * a custom role could be created, and mapped from a directory group, but never
 * given to a local user: the console offered no way to pick it and the API
 * would have refused if it had.
 *
 * Shape only. Whether a role by this name EXISTS is a question for the database,
 * and the API answers it at the point of the write rather than trusting the
 * string.
 */
export const roleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, underscore and hyphen only');

/**
 * Everything downstream of authentication depends on this shape and never on
 * how it was obtained — local password, LDAP bind, or SAML assertion.
 */
export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  displayName: string;
  /**
   * The role this principal holds, by NAME (ADR-0018).
   *
   * Widened from the three-value enum because roles are rows now and a
   * deployment may define its own. Core resolves the name against the roles
   * table; a name with no row grants nothing, which is the safe reading of "a
   * provider returned something core does not know".
   */
  role: string;
  /**
   * Every role that applies, when more than one does.
   *
   * A directory can map somebody into several groups at once, and ADR-0018 §5
   * unions the permissions of the CUSTOM roles that result — which a single
   * name cannot express. `role` stays the primary one, for display and for the
   * stored assignment; this is what authorization actually reads.
   *
   * Undefined means "just `role`", which is every local account and every
   * directory user whose mappings resolved to a single built-in.
   */
  roles?: string[];
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

  /**
   * Try a CANDIDATE configuration without adopting it (ADR-0016 §4).
   *
   * The settings screen offers a Test button, and core cannot implement it:
   * reaching a directory needs the client, and that lives in the enterprise
   * layer which core may not import (ADR-0002). So the provider does the work
   * and core owns the endpoint.
   *
   * MUST NOT mutate anything. Not the live configuration, not a connection
   * pool, not a cached bind. An operator testing a typo must not disturb the
   * directory the deployment is currently using.
   *
   * Optional, because a provider with nothing to reach — core's local one — has
   * nothing to test.
   */
  verifyConfiguration?(config: unknown): Promise<ProviderVerification>;

  /**
   * Report the configuration this provider is CURRENTLY running with.
   *
   * The settings screen has to open on something. When a deployment configures
   * its directory through the environment — every enterprise install before this
   * feature existed — core has no way to show it: the variables are parsed by
   * the enterprise layer, and core may not import it (ADR-0002). Without this,
   * the form opens blank in front of an operator whose directory is plainly
   * working, and the obvious next move is to retype settings that are already
   * correct.
   *
   * MUST NOT include secrets. The result is rendered in a browser. Core strips
   * the fields it knows to be sensitive before returning them, but that is a
   * backstop and not permission to return a bind password here.
   *
   * Shaped to the settings schema for the provider's own source, so core can
   * validate it without knowing what the provider is. Anything that fails to
   * validate is discarded — a provider that reports nonsense degrades to the
   * blank form it would have shown anyway.
   *
   * Optional: a provider with no external configuration — core's local one — has
   * nothing to report.
   */
  currentConfiguration?(): unknown;
}

/** A directory group and the role it grants. */
export interface RoleMapping {
  /** The group as the directory names it — a DN for LDAP, a claim value for OIDC. */
  group: string;
  /** A role NAME. May be one a deployment defined itself (ADR-0018 §5). */
  role: string;
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
/**
 * The outcome of testing a candidate configuration (ADR-0016 §4).
 *
 * Deliberately not an exception. "I could not reach that directory" is an
 * ordinary answer to "does this configuration work", and the operator needs the
 * detail rather than a 500.
 */
export interface ProviderVerification {
  ok: boolean;
  /** One line an operator can act on. Never a raw stack trace. */
  message: string;
  /**
   * What the provider established, when it got far enough to establish
   * anything: bound successfully, found N users under the search base, resolved
   * these groups. Rendered as a list; each entry must be safe to show a browser.
   */
  details?: Array<{ label: string; value: string }>;
}

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
  recordLogin(userId: string, update: { role: string; displayName: string }): Promise<void>;

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

  /**
   * Try a candidate forwarding configuration without saving it (ADR-0016 §4).
   *
   * Core cannot do the work — the syslog and webhook senders live in the
   * enterprise layer, which core may not import (ADR-0002) — so the settings
   * surface asks the registered transport, exactly as LDAP settings ask the
   * registered provider through `verifyConfiguration`. Optional because every
   * transport written before it existed does not have it; core answers 501
   * before this is ever consulted.
   */
  verifyConfiguration?(kind: AuditTransportKind, candidate: unknown): Promise<ProviderVerification>;

  /**
   * The forwarding configuration this transport was built from at boot, or
   * null when the environment configures none.
   *
   * The environment baseline for `audit.*` settings (ADR-0016 §2): the
   * variables are parsed by the enterprise layer, so core asks the transport
   * built from them rather than growing a second parser.
   *
   * MUST NOT include secrets. The result is rendered in a browser. Core strips
   * the fields it knows to be sensitive before returning them, but that is a
   * backstop and not permission to return a token or client key here.
   */
  currentConfiguration?(): { kind: AuditTransportKind; config: unknown } | null;
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
    role: roleNameSchema,
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
  role: roleNameSchema.optional(),
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
  /** A role NAME, which since ADR-0018 may be a custom one. */
  role: string;
  isActive: boolean;
  authSource: string;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * LDAP configuration as the console sends and receives it (ADR-0016).
 *
 * Declared in CONTRACTS, not in the enterprise layer, even though only the
 * enterprise layer can act on it. Core owns the endpoint, validates the body
 * and stores it; the provider that consumes it is licensed. A shape that lived
 * in the private package could not be validated by core at all, and the API
 * would be accepting whatever it was handed.
 *
 * `bindPassword` is WRITE-ONLY. It is accepted here and never returned — a read
 * reports whether one is held, not what it is.
 */
/**
 * Stored configuration for an authentication provider, read per authentication.
 *
 * The contract, and the two halves matter equally:
 *
 * - **Null means "use what you were built with".** Nothing stored, or the
 *   environment in force — either way the provider's own boot configuration
 *   governs. Only a configuration an operator SAVED overrides it, which is
 *   ADR-0016 §2's precedence rule expressed where it takes effect.
 * - **A throw means refuse the login.** A provider must not fall back to its
 *   boot configuration when the store cannot be read: a deployment whose saved
 *   settings point at a different directory would silently authenticate
 *   against the old one. Local accounts are unaffected (ADR-0015 keeps them on
 *   their own provider), so failing closed here stays recoverable.
 *
 * The value is opaque and INCLUDES SECRETS — a provider needs the bind
 * password to bind. It never crosses HTTP; the settings screen reads a
 * different, redacted view.
 */
export interface IAuthProviderSettings {
  /** @param source matches `IAuthProvider.source`, e.g. `ldap`. */
  resolve(source: string): Promise<unknown | null>;
}

/**
 * What an OIDC deployment is configured with (ADR-0016).
 *
 * `clientSecret` is WRITE-ONLY, by the same rule as the LDAP bind password
 * (ADR-0016 §3): it is accepted here and never returned, so a read reports
 * whether one is held rather than what it is, and an empty field on save means
 * keep the stored one.
 *
 * Editable since the settings seam reached auth providers (#113). Before that a
 * provider snapshotted its configuration at boot, so a stored row would have
 * been displayed and never applied — which is why this schema was read-only
 * when it was introduced.
 */
export const oidcSettingsSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  /** Omit to keep the stored one. Never returned by a read. */
  clientSecret: z.string().min(1).optional(),
  /**
   * Where the identity provider sends the browser back.
   *
   * Editable, and worth understanding before it is: this value must match what
   * is registered AT THE PROVIDER. Changing it here without changing it there
   * breaks every login, and the failure appears at the provider rather than in
   * this application.
   */
  redirectUri: z.string().url(),
  scopes: z.array(z.string().min(1)).default([]),
  emailClaim: z.string().min(1),
  displayNameClaim: z.string().min(1),
  groupsClaim: z.string().min(1),
  /** Claim value to role NAME, which may be one a deployment defined (ADR-0018 §5). */
  roleMappings: z.array(z.object({ group: z.string().min(1), role: roleNameSchema })).default([]),
  /** Absent means someone matching no mapping is REFUSED. */
  defaultRole: roleNameSchema.optional(),
  timeoutMs: z.number().int().positive(),
  clockSkewSeconds: z.number().int().min(0),
});

export type OidcSettings = z.infer<typeof oidcSettingsSchema>;

export const ldapSettingsSchema = z.object({
  url: z
    .string()
    .min(1)
    .refine((value) => /^ldaps?:\/\//i.test(value), {
      message: 'Must use the ldap:// or ldaps:// scheme',
    }),
  bindDn: z.string().min(1).optional(),
  /** Omit to keep the stored one. Never returned by a read. */
  bindPassword: z.string().min(1).optional(),
  dialect: z.enum(['openldap', 'ad']).default('openldap'),
  searchBase: z.string().min(1),
  groupSearchBase: z.string().min(1).optional(),
  searchFilter: z.string().min(1).optional(),
  nestedGroups: z.boolean().default(false),
  roleMappings: z
    .array(
      z.object({
        groupDn: z.string().min(1),
        /*
         * A role NAME (ADR-0018 §5), not the built-in enum.
         *
         * Left as an enum, the settings screen could not configure a mapping to
         * a custom role at all — the feature would exist in the resolver and be
         * unreachable from the console. A name with no matching role is
         * accepted here and shown as a broken mapping, because the schema has
         * no way to know which roles a deployment defines.
         */
        role: z.string().min(1).max(64),
      }),
    )
    .default([]),
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  /**
   * Turning this off accepts any certificate the directory presents, which
   * removes the point of ldaps://. Allowed because test directories exist;
   * surfaced in the UI as the warning it is.
   */
  tlsRejectUnauthorized: z.boolean().default(true),
});

export type LdapSettings = z.infer<typeof ldapSettingsSchema>;

/** What a read of stored settings returns. Never carries a secret value. */
export interface SettingsView<T> {
  /** Where this configuration came from: stored, the environment, or nowhere. */
  source: 'database' | 'environment' | 'unset';
  /** Absent when nothing is configured, or when a stored row is switched off. */
  config: T | null;
  /** A stored configuration that exists but is switched off. */
  disabled: boolean;
  /** Names of secrets held for this configuration. Never their values. */
  secretsHeld: string[];
  updatedAt: string | null;
  updatedByEmail: string | null;
  /**
   * Whether a change here takes effect without a restart.
   *
   * False when the provider is not registered — configuring LDAP for the first
   * time still needs a restart, because registration builds the DI graph
   * (ADR-0016 §4). The console must say so rather than appear to have worked.
   */
  liveReload: boolean;
}

/**
 * Audit forwarding to a collector (ADR-0016 §5).
 *
 * Two transports, ONE active at a time: `AUDIT_TRANSPORT` is a single token
 * and the outbox clears a delivery job on a single confirmation, so running
 * both would either drop a copy silently or need per-transport jobs. The
 * operator's choice is stored under the `audit.forwarding` setting kind and
 * switching it is an explicit act, separate from saving a configuration.
 */
export const AUDIT_TRANSPORT_KINDS = ['syslog', 'webhook'] as const;
export type AuditTransportKind = (typeof AUDIT_TRANSPORT_KINDS)[number];

/**
 * A syslog collector (RFC 5424). TCP by default, TLS recommended, UDP opt-in
 * and reported as unconfirmable delivery — over UDP, "sent" means the kernel
 * accepted a datagram, not that the collector received it.
 */
export const syslogSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'tls', 'udp']).default('tcp'),
  /** PEM bundle that signs the collector's certificate, for `tls`. */
  caCert: z.string().min(1).optional(),
  /** PEM client certificate, when the collector requires mutual TLS. */
  clientCert: z.string().min(1).optional(),
  /** Omit to keep the stored one. Never returned by a read. */
  clientKey: z.string().min(1).optional(),
  /** RFC 5424 facility. 13 is "log audit", which is exactly what this is. */
  facility: z.number().int().min(0).max(23).default(13),
  appName: z.string().min(1).max(48).default('nexuspuppet'),
  /**
   * Per-batch socket write budget (ADR-0016 §5). TCP backpressure from a
   * drowning collector must fail the batch back to the outbox's retry
   * schedule, not stall the delivery worker indefinitely.
   */
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  /** Accepting any certificate removes the point of TLS. Test rigs exist. */
  tlsRejectUnauthorized: z.boolean().default(true),
});

export type SyslogSettings = z.infer<typeof syslogSettingsSchema>;

/**
 * A webhook collector. HTTPS, or HTTP to loopback only — audit records do not
 * travel a network in clear. Any 2xx confirms a delivery (ADR-0016, resolved
 * question 1).
 */
export const webhookSettingsSchema = z.object({
  url: z
    .string()
    .min(1)
    .refine(
      (value) =>
        /^https:\/\//i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(value),
      { message: 'Must be https://, or http:// to localhost only' },
    ),
  /** Omit to keep the stored one. Never returned by a read. */
  token: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
});

export type WebhookSettings = z.infer<typeof webhookSettingsSchema>;

/** The operator's transport choice, stored under `audit.forwarding`. */
export const auditForwardingSelectionSchema = z.object({
  active: z.enum(['syslog', 'webhook', 'none']),
});

export type AuditForwardingSelection = z.infer<typeof auditForwardingSelectionSchema>;

/** What the Integrations screen renders. Secret values never appear. */
export interface AuditForwardingView {
  syslog: SettingsView<SyslogSettings>;
  webhook: SettingsView<WebhookSettings>;
  /**
   * Which transport delivery uses. Falls back to the transport the
   * environment configured when nothing is stored — the same baseline rule
   * every other setting follows.
   */
  active: AuditForwardingSelection['active'];
}

/**
 * What the registered transport should do right now, resolved from stored
 * settings. Server-side only — the config INCLUDES secrets, because the
 * transport has to authenticate with them. This never crosses HTTP.
 *
 * `unset` is not `off`: unset means nothing was ever stored, so the
 * environment the transport was built from still governs (ADR-0016 §2);
 * `off` means an operator explicitly switched forwarding away.
 */
export type AuditForwardingState =
  | { state: 'unset' }
  | { state: 'off' }
  | { state: 'syslog'; config: SyslogSettings }
  | { state: 'webhook'; config: WebhookSettings };

/**
 * Core's resolver for the stored forwarding configuration. The enterprise
 * transport injects this (via `AUDIT_FORWARDING_SETTINGS`) and consults it
 * per delivery, which is what makes reconfiguration live (ADR-0016 §4)
 * without the transport ever touching the database (ADR-0002).
 */
export interface IAuditForwardingSettings {
  resolveActive(): Promise<AuditForwardingState>;
}

/** A role as the console sees it (ADR-0018). */
export const roleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  description: z.string().nullable(),
  permissions: z.array(permissionSchema),
  /** Seeded by the product. Not deletable, not renamable. */
  builtIn: z.boolean(),
  /** How many active users hold it. For the console, never for a decision. */
  userCount: z.number().int().nonnegative(),
});
export type Role = z.infer<typeof roleSchema>;

export const createRoleSchema = z.object({
  /**
   * No spaces, so a name can be written into LDAP_ROLE_MAPPINGS — which is
   * semicolon and equals delimited — without needing quoting rules nobody
   * would remember.
   */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, underscore and hyphen only'),
  description: z.string().max(256).optional(),
  permissions: z.array(permissionSchema),
});
export type CreateRole = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  description: z.string().max(256).nullable().optional(),
  permissions: z.array(permissionSchema).optional(),
});
export type UpdateRole = z.infer<typeof updateRoleSchema>;

/**
 * A directory mapping that stands in the way of deleting a role.
 *
 * Named individually and in full, because the operator has to go and find this
 * entry in their directory configuration. "Role is in use" tells them a fact
 * they already suspected and none of what they need.
 */
export interface BlockingRoleMapping {
  /**
   * The group exactly as configured, so it can be searched for verbatim — a DN
   * for LDAP, a claim value for OIDC.
   */
  groupDn: string;
  /** Where it is configured: the settings screen, or the environment. */
  source: 'database' | 'environment';
  /**
   * Which provider's mappings this came from.
   *
   * Optional because it was added once a second provider could name a role
   * (ADR-0018 §5). "Remove or repoint these mappings" is not actionable without
   * it once two configurations can both reference a role: the operator needs to
   * know whether to look at the directory settings or at `OIDC_ROLE_MAPPINGS`.
   */
  provider?: string;
}
