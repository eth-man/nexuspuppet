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

export const AUTH_PROVIDER = Symbol.for('nexuspuppet.AuthProvider');
export const AUTHORIZATION_POLICY = Symbol.for('nexuspuppet.AuthorizationPolicy');
export const USER_DIRECTORY = Symbol.for('nexuspuppet.UserDirectory');
export const AUDIT_SINK = Symbol.for('nexuspuppet.AuditSink');
export const LICENSE_SERVICE = Symbol.for('nexuspuppet.LicenseService');
export const PUPPETDB_CLIENT = Symbol.for('nexuspuppet.PuppetDbClient');
export const ENC_FILE_WRITER = Symbol.for('nexuspuppet.EncFileWriter');

export type CapabilityToken =
  | typeof AUTH_PROVIDER
  | typeof AUTHORIZATION_POLICY
  | typeof USER_DIRECTORY
  | typeof AUDIT_SINK
  | typeof LICENSE_SERVICE
  | typeof PUPPETDB_CLIENT
  | typeof ENC_FILE_WRITER;

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
