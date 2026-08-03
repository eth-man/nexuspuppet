/**
 * Dependency-injection tokens for every extensible seam in NexusPuppet.
 *
 * Core provides a default implementation of EVERY token declared here — the
 * product is complete and usable without the enterprise layer (ADR-0002).
 * The enterprise package may override any of them at boot via the
 * CapabilityRegistry. It may not add tokens that core does not declare.
 *
 * Tokens are unique symbols so that two copies of this package cannot silently
 * resolve to different providers.
 */

/**
 * The single declaration of every seam.
 *
 * One object rather than seven independent exports, so the runtime list and the
 * type below are DERIVED from it and cannot drift apart. Adding a seam here
 * adds it to both, which is what lets the container tests cover a new token
 * without anyone remembering to update them.
 *
 * The individual exports beneath are unchanged — same names, same Symbol.for
 * identities — so nothing that already imports them notices.
 */
const TOKENS = {
  AUTH_PROVIDER: Symbol.for('nexuspuppet.AuthProvider'),
  AUTHORIZATION_POLICY: Symbol.for('nexuspuppet.AuthorizationPolicy'),
  USER_DIRECTORY: Symbol.for('nexuspuppet.UserDirectory'),
  AUDIT_SINK: Symbol.for('nexuspuppet.AuditSink'),
  LICENSE_SERVICE: Symbol.for('nexuspuppet.LicenseService'),
  PUPPETDB_CLIENT: Symbol.for('nexuspuppet.PuppetDbClient'),
  ENC_FILE_WRITER: Symbol.for('nexuspuppet.EncFileWriter'),
  AUDIT_TRANSPORT: Symbol.for('nexuspuppet.AuditTransport'),
  AUTH_PROVIDERS: Symbol.for('nexuspuppet.AuthProviders'),
} as const;

export const AUTH_PROVIDER = TOKENS.AUTH_PROVIDER;
export const AUTHORIZATION_POLICY = TOKENS.AUTHORIZATION_POLICY;
export const USER_DIRECTORY = TOKENS.USER_DIRECTORY;
export const AUDIT_SINK = TOKENS.AUDIT_SINK;
export const LICENSE_SERVICE = TOKENS.LICENSE_SERVICE;
export const PUPPETDB_CLIENT = TOKENS.PUPPETDB_CLIENT;
export const ENC_FILE_WRITER = TOKENS.ENC_FILE_WRITER;
export const AUDIT_TRANSPORT = TOKENS.AUDIT_TRANSPORT;

/**
 * Every authentication provider this deployment can dispatch to (ADR-0015).
 *
 * PLURAL, and additive. `AUTH_PROVIDER` is a single binding that an enterprise
 * layer used to replace, which meant enabling a directory did not shadow local
 * authentication — it removed it, and locked every local account out with no
 * way back short of writing to the database by hand.
 *
 * Core always contributes its local provider to this list and the registry
 * refuses any attempt to displace it, so an administrator can always get in.
 * A login is dispatched by the account's `authSource` matching a provider's
 * `source`; nothing chains or falls back.
 */
export const AUTH_PROVIDERS = TOKENS.AUTH_PROVIDERS;

/**
 * Core's own audit sink, exposed so a replacement can COMPOSE over it.
 *
 * Deliberately NOT a capability token: the enterprise layer does not replace
 * this, it depends on it. An enterprise sink registered under AUDIT_SINK
 * delegates the transactional Postgres write here and then does its own thing —
 * forwarding to a SIEM — without needing database access it must not have
 * (ADR-0002 forbids enterprise reaching core internals, including Prisma).
 *
 * The alternative was an enterprise sink that OWNS the write, which would mean
 * replacing the local audit trail rather than adding to it. An estate should not
 * lose its Postgres audit log because it gained a SIEM.
 */
export const CORE_AUDIT_SINK = Symbol.for('nexuspuppet.CoreAuditSink');

/**
 * The queue that carries an audit record to an external system.
 *
 * Also NOT a capability: core owns the storage and the worker, and a
 * capability that forwards records uses this to enqueue them. It exists as a
 * token because the enterprise layer cannot import core's class — ADR-0002 —
 * and needs some way to reach it.
 */
export const AUDIT_DELIVERY_OUTBOX = Symbol.for('nexuspuppet.AuditDeliveryOutbox');

/**
 * Every seam, enumerable at runtime.
 *
 * Exists so a test can assert properties of ALL of them — that each has a core
 * default, and that nothing bypasses one by injecting its implementation
 * directly. Both defects have shipped here before; enumerating the tokens is
 * what turns finding them from an audit into a permanent guarantee.
 */
export const CAPABILITY_TOKENS: readonly symbol[] = Object.values(TOKENS);

/** Name for a token, for messages that have to say WHICH seam is wrong. */
export function capabilityTokenName(token: symbol): string {
  return Object.entries(TOKENS).find(([, value]) => value === token)?.[0] ?? String(token);
}

export type CapabilityToken = (typeof TOKENS)[keyof typeof TOKENS];

/**
 * Named capabilities a deployment may or may not have. Core routes for
 * enterprise capabilities exist and return 501 with the relevant name, rather
 * than 404 — the feature exists, this deployment lacks it (ADR-0006).
 */
export const CAPABILITIES = {
  SSO_SAML: 'sso.saml',
  SSO_OIDC: 'sso.oidc',
  DIRECTORY_LDAP: 'directory.ldap',
  RBAC_SCOPED: 'rbac.scoped',
  /**
   * Creating, editing and deleting roles (ADR-0018 §6).
   *
   * The MECHANISM is core — the roles table, per-request resolution, the
   * lockout rules and directory mapping all ship to every deployment and are
   * exercised by every deployment. Only the editing is licensed, so the risky
   * part is the part everybody runs.
   */
  RBAC_CUSTOM: 'rbac.custom',
  AUDIT_EXPORT: 'audit.export',
} as const;

export type CapabilityName = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];
