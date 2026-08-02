import { Logger } from '@nestjs/common';
import { type LdapSettings, ldapSettingsSchema } from '@nexuspuppet/contracts';
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
