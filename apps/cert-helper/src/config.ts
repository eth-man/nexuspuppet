/**
 * Configuration, read once at boot and validated loudly.
 *
 * Every value here is either security-relevant or the difference between
 * rolling back and not. A helper that starts with a missing secret and
 * discovers it on the first upload has already accepted the request.
 */
export interface HelperEnv {
  root: string;
  secret: string;
  windowSeconds: number;
  listenPort: number;
  caddyAdminOrigin: string;
  caddyfilePath: string;
  probeHost: string;
  probePort: number;
  probeServername: string;
}

/** Anything shorter is not a key, whatever it is called. */
const MIN_SECRET_LENGTH = 32;

export function readEnv(env: NodeJS.ProcessEnv): HelperEnv {
  const secret = env['CERT_HELPER_SECRET'] ?? '';

  if (secret.length < MIN_SECRET_LENGTH) {
    // Refusing to start is the point. A helper with no shared secret cannot
    // verify a grant, and the only alternatives are to accept every upload or
    // to reject every upload — one is a hole and the other is a mystery.
    throw new Error(
      `CERT_HELPER_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters. ` +
        'It is shared with the api service, which signs installation grants with it. ' +
        'Generate one with: openssl rand -base64 48',
    );
  }

  const servername = env['CONSOLE_HOSTNAME'] ?? '';
  if (servername === '') {
    throw new Error(
      'CONSOLE_HOSTNAME must be set. The helper opens a TLS connection to the proxy to check ' +
        'which certificate it is serving, and without the expected name that handshake reaches ' +
        'the wrong virtual host.',
    );
  }

  return {
    root: env['CONSOLE_TLS_ROOT'] ?? '/etc/nexuspuppet/tls',
    secret,
    windowSeconds: positive(env['TLS_CONFIRM_TIMEOUT_SEC'], 120, 'TLS_CONFIRM_TIMEOUT_SEC'),
    listenPort: positive(env['CERT_HELPER_PORT'], 8099, 'CERT_HELPER_PORT'),
    caddyAdminOrigin: env['CADDY_ADMIN_ORIGIN'] ?? 'http://proxy:2019',
    caddyfilePath: env['CADDYFILE_PATH'] ?? '/etc/caddy/Caddyfile',
    probeHost: env['CONSOLE_PROBE_HOST'] ?? 'proxy',
    probePort: positive(env['CONSOLE_PROBE_PORT'], 443, 'CONSOLE_PROBE_PORT'),
    probeServername: servername,
  };
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, not ${JSON.stringify(raw)}.`);
  }
  return value;
}
