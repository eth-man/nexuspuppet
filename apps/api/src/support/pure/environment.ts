import type { SecretValue } from './redaction';

/**
 * Which environment variables a support bundle may show, and how (ADR-0028 §4).
 *
 * AN ALLOW-LIST, NEVER A DENY-LIST. A deny-list fails open: the next secret
 * somebody adds to the environment is exported the day it is added, and
 * nothing notices. Here a key nobody classified is withheld — its NAME is
 * listed so support knows it is set, its value is not.
 *
 * `env.spec.ts`-style enforcement lives in `environment.spec.ts`: every key in
 * `envSchema` must appear below, so adding a variable to the API forces a
 * decision about whether a bundle may show it.
 */

/**
 *  - `value`:    shown as-is. Configuration, not a credential.
 *  - `origin`:   a URL whose path or query may carry a credential (webhook
 *                URLs routinely do). Only scheme://host:port is shown.
 *  - `presence`: a secret. Reported as "set" or "unset", and its value becomes
 *                a literal the redaction pass searches for — always.
 *  - `identity`: a person, not a credential. Reported as "set" or "unset"; its
 *                value is redacted UNLESS the operator asked for personal data
 *                (ADR-0028 §6), in which case masking it would defeat the ask.
 */
export type EnvTreatment = 'value' | 'origin' | 'presence' | 'identity';

export const ENVIRONMENT_TREATMENT: Readonly<Record<string, EnvTreatment>> = {
  // --- API: envSchema -------------------------------------------------------
  NODE_ENV: 'value',
  API_PORT: 'value',
  LOG_LEVEL: 'value',
  LOG_DIR: 'value',
  LOG_FILE_MAX_BYTES: 'value',
  LOG_FILE_KEEP: 'value',
  DATABASE_URL: 'presence',
  JWT_SECRET: 'presence',
  CONFIG_ENCRYPTION_KEY: 'presence',
  SETTINGS_SOURCE: 'value',
  ACCESS_TOKEN_TTL: 'value',
  AUTH_LOGIN_FLOOR_MS: 'value',
  REFRESH_TOKEN_TTL: 'value',
  LOGIN_MAX_FAILED_ATTEMPTS: 'value',
  LOGIN_LOCKOUT_MINUTES: 'value',
  // An identity, not a secret — but a person's address is exactly what the
  // default bundle promises not to carry.
  BOOTSTRAP_ADMIN_EMAIL: 'identity',
  BOOTSTRAP_ADMIN_PASSWORD: 'presence',
  AUDIT_RETENTION_DAYS: 'value',
  AUDIT_RETENTION_MAX_ROWS: 'value',
  AUDIT_RETENTION_INTERVAL_MS: 'value',
  AUDIT_RETENTION_BATCH_SIZE: 'value',
  AUDIT_RETENTION_MAX_BATCHES: 'value',
  PUPPETDB_URL: 'value',
  PUPPETDB_CERT_PATH: 'value',
  PUPPETDB_KEY_PATH: 'value',
  PUPPETDB_CA_PATH: 'value',
  PUPPETDB_TIMEOUT_MS: 'value',
  PUPPETSERVER_URL: 'value',
  PUPPETSERVER_CERT_PATH: 'value',
  PUPPETSERVER_KEY_PATH: 'value',
  PUPPETSERVER_CA_PATH: 'value',
  PUPPETSERVER_TIMEOUT_MS: 'value',
  PUPPETSERVER_CLASS_CACHE_TTL_MS: 'value',
  PUPPETSERVER_DEFAULT_ENVIRONMENT: 'value',
  PUPPETDB_PROJECTED_FACTS: 'value',
  PUPPETDB_PROJECTION_INTERVAL_MS: 'value',
  PUPPETDB_POLL_INTERVAL_MS: 'value',
  PUPPETDB_POLL_OVERLAP_MS: 'value',
  NOTIFICATION_EVALUATION_INTERVAL_MS: 'value',
  ENC_OUTPUT_DIR: 'value',
  ENC_REPLICATION_ENABLED: 'value',
  ENC_REPLICATION_PORT: 'value',
  ENC_REPLICATION_BIND: 'value',
  ENC_REPLICATION_ALLOWED_CERTNAMES: 'value',
  ENC_REPLICATION_CERT_PATH: 'value',
  ENC_REPLICATION_KEY_PATH: 'value',
  ENC_REPLICATION_CA_PATH: 'value',
  CONSOLE_TLS_CERT_PATH: 'value',
  CONSOLE_HOSTNAME: 'value',
  CERT_HELPER_SECRET: 'presence',
  ENC_DEFAULT_ENVIRONMENT: 'value',
  ENC_MATERIALIZER_INTERVAL_MS: 'value',
  ENC_RECONCILE_INTERVAL_MS: 'value',
  ENC_MAX_JOB_ATTEMPTS: 'value',
  ENC_MATERIALIZER_BATCH_SIZE: 'value',
  ENC_MATERIALIZER_RECONCILE_CHUNK: 'value',
  ENC_MATERIALIZER_BATCH_DELAY_MS: 'value',
  ENC_MATERIALIZER_MAX_DRAIN_MS: 'value',

  // --- Read outside envSchema -----------------------------------------------
  NEXUSPUPPET_VERSION: 'value',
  SHADOW_DATABASE_URL: 'presence',

  // --- Directory and audit export (packages/enterprise) ---------------------
  LDAP_URL: 'value',
  LDAP_BIND_DN: 'value',
  LDAP_BIND_PASSWORD: 'presence',
  LDAP_CA_PATH: 'value',
  LDAP_DIALECT: 'value',
  LDAP_GROUP_SEARCH_BASE: 'value',
  LDAP_NESTED_GROUPS: 'value',
  LDAP_ROLE_MAPPINGS: 'value',
  LDAP_SEARCH_BASE: 'value',
  LDAP_SEARCH_FILTER: 'value',
  LDAP_TIMEOUT_MS: 'value',
  LDAP_TLS_REJECT_UNAUTHORIZED: 'value',
  OIDC_ISSUER: 'value',
  OIDC_CLIENT_ID: 'value',
  OIDC_CLIENT_SECRET: 'presence',
  OIDC_REDIRECT_URI: 'value',
  OIDC_SCOPES: 'value',
  OIDC_DEFAULT_ROLE: 'value',
  OIDC_ROLE_MAPPINGS: 'value',
  OIDC_GROUPS_CLAIM: 'value',
  OIDC_EMAIL_CLAIM: 'value',
  OIDC_DISPLAY_NAME_CLAIM: 'value',
  OIDC_CLOCK_SKEW_SECONDS: 'value',
  OIDC_TIMEOUT_MS: 'value',
  AUDIT_EXPORT_URL: 'origin',
  AUDIT_EXPORT_TOKEN: 'presence',
  AUDIT_EXPORT_CA_PATH: 'value',
  AUDIT_EXPORT_TIMEOUT_MS: 'value',
  AUDIT_EXPORT_ENTITY_TYPES: 'value',

  // --- Compose and host (the api service receives the whole of .env) --------
  POSTGRES_USER: 'value',
  POSTGRES_DB: 'value',
  POSTGRES_PASSWORD: 'presence',
  API_BIND: 'value',
  WEB_BIND: 'value',
  WEB_PORT: 'value',
  HTTP_PORT: 'value',
  HTTPS_PORT: 'value',
  API_INTERNAL_URL: 'value',
  CONSOLE_TLS_DIR: 'value',
  PUPPETDB_CERT_DIR: 'value',
  PUPPETSERVER_HOST_ALIAS: 'value',
  BUILD_REF: 'value',
  // A git URL, which is where a deploy token goes when there is one.
  NEXUSPUPPET_ENTERPRISE_REPO: 'presence',
  NEXUSPUPPET_ENTERPRISE_REF: 'value',
  TZ: 'value',
  HOSTNAME: 'value',
  NODE_VERSION: 'value',
};

/**
 * Names that look like credentials, whatever list they are or are not on.
 *
 * Used for two things: a `value` entry must never match it (a test enforces
 * that, so a mistake in the table above fails CI), and an UNCLASSIFIED key that
 * matches has its value added to the literal redaction set — the key is
 * withheld from the report either way, but its value may still have reached a
 * log line.
 *
 * `_PATH` and `_DIR` are excluded: `PUPPETDB_KEY_PATH` names a file, and the
 * file is never read into a bundle. So are durations — `ACCESS_TOKEN_TTL` is
 * how long a token lives, not a token.
 */
export function looksSecret(name: string): boolean {
  if (/_(PATH|DIR|FILE|TTL|MS|SECONDS|MINUTES)$/.test(name)) return false;
  return (
    /(PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|PRIVATE|APIKEY|API_KEY)/.test(name) ||
    /(^|_)KEY$/.test(name) ||
    /(^|_)PASS$/.test(name) ||
    /DATABASE_URL$/.test(name)
  );
}

export interface EnvironmentReport {
  /** Allow-listed configuration, with values. */
  values: Record<string, string>;
  /** Secrets and identities: whether each is set. Every presence key appears. */
  secrets: Record<string, 'set' | 'unset'>;
  /** Present in the environment, not classified above. Names only. */
  unclassified: string[];
}

/**
 * Only scheme, host and port. Anything unparseable is withheld whole rather
 * than guessed at.
 */
export function urlOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[unparseable URL withheld]';
  }
}

export function environmentReport(
  env: Readonly<Record<string, string | undefined>>,
  options: { includePersonalData?: boolean } = {},
): {
  report: EnvironmentReport;
  secrets: SecretValue[];
} {
  const values: Record<string, string> = {};
  const presence: Record<string, 'set' | 'unset'> = {};
  const unclassified: string[] = [];
  const secrets: SecretValue[] = [];

  for (const [name, treatment] of Object.entries(ENVIRONMENT_TREATMENT).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const raw = env[name];
    const set = raw !== undefined && raw !== '';

    if (treatment === 'presence' || treatment === 'identity') {
      // Never the value in this report, either way: it is configuration, and
      // the user list is where a person's address belongs when it is asked for.
      presence[name] = set ? 'set' : 'unset';
      const redactIt = treatment === 'presence' || options.includePersonalData !== true;
      if (set && redactIt) secrets.push(...secretsIn(name, raw));
      continue;
    }
    if (!set) continue;

    values[name] = treatment === 'origin' ? urlOrigin(raw) : raw;
    // A URL shown in full can still carry `user:password@`. The redaction pass
    // masks the userinfo structurally; naming the password as a literal as well
    // catches it anywhere else it appears, such as a log line quoting it.
    secrets.push(...urlPasswordIn(name, raw));
  }

  for (const name of Object.keys(env).sort()) {
    if (name in ENVIRONMENT_TREATMENT) continue;
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    unclassified.push(name);
    if (looksSecret(name)) secrets.push(...secretsIn(name, raw));
  }

  return { report: { values, secrets: presence, unclassified }, secrets };
}

/** The value itself, plus the password inside it when it is a URL. */
function secretsIn(name: string, value: string): SecretValue[] {
  return [{ name, value }, ...urlPasswordIn(name, value)];
}

function urlPasswordIn(name: string, value: string): SecretValue[] {
  if (!value.includes('://')) return [];
  try {
    const url = new URL(value);
    const found: SecretValue[] = [];
    if (url.password !== '') {
      found.push({ name: `${name}.password`, value: decodeURIComponent(url.password) });
      if (url.password !== decodeURIComponent(url.password)) {
        found.push({ name: `${name}.password`, value: url.password });
      }
    }
    return found;
  } catch {
    return [];
  }
}
