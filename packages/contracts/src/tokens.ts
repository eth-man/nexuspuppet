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
  AUDIT_EXPORT: 'audit.export',
} as const;

export type CapabilityName = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];
