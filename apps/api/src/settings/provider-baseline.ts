import { Logger } from '@nestjs/common';
import {
  type AuditTransportKind,
  type IAuditTransport,
  type LdapSettings,
  type SyslogSettings,
  type WebhookSettings,
  ldapSettingsSchema,
  syslogSettingsSchema,
  webhookSettingsSchema,
} from '@nexuspuppet/contracts';
import type { AuthProviderResolver } from '../auth/auth-provider.resolver';

const logger = new Logger('ProviderBaseline');

/**
 * Fields core will not pass on from a provider's self-report, whatever the
 * provider says. The contract forbids returning them; this is what happens when
 * a provider ignores the contract.
 */
const NEVER_REPORTED = ['bindPassword'] as const;

/**
 * The LDAP configuration the running provider was built from, or null.
 *
 * This is the environment baseline for `auth.ldap` (ADR-0016 §3): what the
 * settings screen shows when nothing has been stored through the console. Core
 * cannot read it from the environment itself, because the variables belong to
 * the enterprise layer's parser (ADR-0002) — so it asks the provider that was
 * built from them.
 *
 * Fails to null rather than throwing. A settings page that renders a blank form
 * is a poor experience; one that returns 500 because a provider misbehaved is a
 * worse one, and it takes the Save button down with it.
 */
export function ldapEnvBaseline(resolver: AuthProviderResolver): LdapSettings | null {
  const provider = resolver.forSource('ldap');
  if (provider?.currentConfiguration === undefined) return null;

  let reported: unknown;
  try {
    reported = provider.currentConfiguration();
  } catch (error) {
    logger.warn(
      `The 'ldap' provider failed to report its configuration: ${describeError(error)}. ` +
        'The settings form will open empty.',
    );
    return null;
  }
  if (reported === null || reported === undefined) return null;

  const parsed = ldapSettingsSchema.safeParse(reported);
  if (!parsed.success) {
    logger.warn(
      "The 'ldap' provider reported a configuration that does not match the settings schema " +
        `(${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}). ` +
        'The settings form will open empty.',
    );
    return null;
  }

  const safe = { ...parsed.data } as Record<string, unknown>;
  for (const field of NEVER_REPORTED) {
    if (safe[field] !== undefined) {
      delete safe[field];
      logger.warn(
        `The 'ldap' provider included '${field}' in its reported configuration. It was ` +
          'discarded — a provider must not return secrets from currentConfiguration().',
      );
    }
  }

  return safe as LdapSettings;
}

/**
 * Which fields of each audit transport configuration are secret. Named once,
 * here, and imported by the service — two lists that could drift would mean a
 * field encrypted on write and leaked by the baseline.
 */
export const AUDIT_SECRET_FIELDS: Record<AuditTransportKind, readonly string[]> = {
  syslog: ['clientKey'],
  webhook: ['token'],
};

/**
 * The forwarding configuration the running transport was built from, or null.
 *
 * The environment baseline for `audit.syslog` / `audit.webhook` (ADR-0016 §2),
 * by the same rule as {@link ldapEnvBaseline}: the variables belong to the
 * enterprise layer's parser, so core asks the transport built from them.
 * Same failure posture too — a blank form beats a 500.
 */
export function auditEnvBaseline(
  transport: IAuditTransport,
  kind: AuditTransportKind,
): SyslogSettings | WebhookSettings | null {
  if (transport.currentConfiguration === undefined) return null;

  let reported: { kind: AuditTransportKind; config: unknown } | null;
  try {
    reported = transport.currentConfiguration();
  } catch (error) {
    logger.warn(
      `The audit transport failed to report its configuration: ${describeError(error)}. ` +
        'The settings form will open empty.',
    );
    return null;
  }
  if (reported === null || reported.kind !== kind) return null;

  const schema = kind === 'syslog' ? syslogSettingsSchema : webhookSettingsSchema;
  const parsed = schema.safeParse(reported.config);
  if (!parsed.success) {
    logger.warn(
      `The audit transport reported a "${kind}" configuration that does not match the settings ` +
        `schema (${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}). ` +
        'The settings form will open empty.',
    );
    return null;
  }

  const safe = { ...parsed.data } as Record<string, unknown>;
  for (const field of AUDIT_SECRET_FIELDS[kind]) {
    if (safe[field] !== undefined) {
      delete safe[field];
      logger.warn(
        `The audit transport included '${field}' in its reported configuration. It was ` +
          'discarded — a transport must not return secrets from currentConfiguration().',
      );
    }
  }

  return safe as SyslogSettings | WebhookSettings;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
