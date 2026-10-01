import { auditExportConfigFromEnv, type AuditExportConfig } from '../audit-forwarding/config';
import { ldapConfigFromEnv, type LdapConfig } from '../directory/ldap/config';
import { oidcConfigFromEnv, type OidcConfig } from '../directory/oidc/config';

/**
 * The directory and audit-forwarding integrations this deployment is
 * configured for, read from the environment ONCE, at boot (ADR-0027 §5).
 *
 * `null` means "not configured", which is a normal state: every one of these
 * is optional, and a deployment with none of them is local accounts and a
 * Postgres audit trail — a complete product.
 *
 * A value that is PRESENT BUT MALFORMED throws, and the API refuses to start.
 * That is deliberate and it is the same rule the old runtime loader enforced:
 * a deployment that believes it has a directory must never quietly run
 * without one, and one that believes it is forwarding to a SIEM must never
 * quietly not be. A typo is found at `docker compose up`, not at somebody's
 * first login or during an audit.
 */
export interface IntegrationConfig {
  /** Set when `LDAP_URL` is. Registers the LDAP provider. */
  ldap: LdapConfig | null;
  /** Set when `OIDC_ISSUER` is. Registers the OIDC provider. */
  oidc: OidcConfig | null;
  /**
   * Set when `AUDIT_EXPORT_URL` is. Only the BASELINE for the webhook
   * transport: forwarding is registered regardless and configured from the
   * console, where stored settings win (ADR-0016 §4).
   */
  auditExport: AuditExportConfig | null;
}

/** A configured integration whose settings cannot be used. Fatal at boot. */
export class IntegrationConfigError extends Error {
  constructor(integration: string, cause: unknown) {
    super(
      `${integration} is configured but its settings are invalid, so the API will not ` +
        `start rather than run without it. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'IntegrationConfigError';
  }
}

export function integrationsFromEnv(env: NodeJS.ProcessEnv = process.env): IntegrationConfig {
  return {
    // Keyed on LDAP_URL alone, whatever else is set. An earlier guard also
    // required OIDC to be unset, which silently skipped validation — and so
    // let a malformed LDAP_URL reach a login — when both were configured.
    ldap:
      (env['LDAP_URL'] ?? '').trim() === ''
        ? null
        : validated('LDAP', () => ldapConfigFromEnv(env)),
    oidc: validated('OIDC', () => oidcConfigFromEnv(env)),
    auditExport: validated('Audit export', () => auditExportConfigFromEnv(env)),
  };
}

function validated<T>(integration: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new IntegrationConfigError(integration, error);
  }
}
