/**
 * Installing a console certificate, from the browser (ADR-0017).
 *
 * These requests do NOT go through `/api`. `/console-tls/*` is routed by the
 * proxy straight to the cert-helper, so the certificate and its private key
 * never enter the API process — not its heap, not its logs, not a crash dump.
 * That routing is the whole reason the feature is shaped this way, so this
 * module deliberately does not reuse the `/api` client.
 */

export interface CertificateIdentity {
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  fingerprint: string;
  validFrom: string;
  validTo: string;
  chainLength: number;
}

export interface StagedInstall {
  confirmationToken: string;
  expiresAt: string;
  identity: CertificateIdentity;
}

/** Thrown for outcomes the operator has to read and act on. */
export class InstallError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'rolled-back' | 'rollback-failed' | 'refused',
    readonly detail?: string,
  ) {
    super(message);
  }
}

export async function authorizeInstall(): Promise<string> {
  const response = await fetch('/api/system/tls/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new InstallError(
      body.message ?? 'The API refused to authorise a certificate installation.',
      'refused',
    );
  }
  return ((await response.json()) as { grant: string }).grant;
}

/**
 * Hand the certificate and key to the helper. Returns once it is SERVING —
 * which is not the same as installed. It will be undone unless a client
 * confirms before `expiresAt`.
 */
export async function stageInstall(
  grant: string,
  certificate: string,
  privateKey: string,
): Promise<StagedInstall> {
  const response = await fetch('/console-tls/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant, certificate, privateKey }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.status === 202) return body as unknown as StagedInstall;

  if (response.status === 422) {
    throw new InstallError(explain(body['rejection']), 'rejected');
  }
  if (response.status === 409) {
    throw new InstallError(String(body['reason'] ?? 'The install was rolled back.'), 'rolled-back');
  }
  if (response.status === 500 && body['status'] === 'rollback-failed') {
    throw new InstallError(
      String(body['reason'] ?? 'The install failed.'),
      'rollback-failed',
      String(body['detail'] ?? ''),
    );
  }
  throw new InstallError(
    String(body['message'] ?? `The helper refused the upload (HTTP ${response.status}).`),
    'refused',
  );
}

export type PollOutcome =
  | { kind: 'confirmed'; identity: CertificateIdentity }
  /** The window closed. The previous certificate is serving again. */
  | { kind: 'expired' }
  /** Keep trying: this attempt did not reach a helper that could answer. */
  | { kind: 'unreachable' }
  | { kind: 'failed'; message: string };

/**
 * One confirmation attempt, classified.
 *
 * THE IMPORTANT CASE IS `unreachable`. Reloading the proxy recycles the
 * listener, so the browser's pooled connection is dropped and the next request
 * has to complete a fresh TLS handshake against the certificate just installed.
 * While that is happening — and for as long as the operator spends clicking
 * through a browser warning about a private CA — `fetch` rejects with a raw
 * `TypeError`, not an HTTP status.
 *
 * Treating that as failure would roll back every install behind a private CA,
 * which is the deployment this feature exists for. So it is "not yet", and the
 * caller keeps trying until the deadline the SERVER set.
 */
export async function attemptConfirm(token: string): Promise<PollOutcome> {
  let response: Response;
  try {
    response = await fetch('/console-tls/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationToken: token }),
      // A stale cached 200 would confirm an install nobody reached.
      cache: 'no-store',
    });
  } catch {
    // TypeError from a dropped socket, a refused connection, or a certificate
    // the browser will not accept yet. All of them mean "not yet".
    return { kind: 'unreachable' };
  }

  if (response.status === 200) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (body['status'] === 'confirmed') {
      return { kind: 'confirmed', identity: body['identity'] as CertificateIdentity };
    }
    // 'nothing-pending' — someone else confirmed, or it was already rolled back
    // and swept. Either way there is nothing left for this loop to do.
    return { kind: 'expired' };
  }

  if (response.status === 410) return { kind: 'expired' };

  // 5xx and 502/503/504 in particular are what an intermediate proxy returns
  // while the upstream is restarting. Transient by nature, so keep trying.
  if (response.status >= 500) return { kind: 'unreachable' };

  if (response.status === 403) {
    return { kind: 'failed', message: 'The confirmation token was refused.' };
  }
  return { kind: 'failed', message: `Confirmation failed (HTTP ${response.status}).` };
}

function explain(rejection: unknown): string {
  const r = rejection as {
    reason?: string;
    detail?: string;
    expiredAt?: string;
    validFrom?: string;
  };
  switch (r?.reason) {
    case 'mismatch':
      return 'That private key does not belong to that certificate. Installing them together would leave the console unable to complete any connection, including this one.';
    case 'key-encrypted':
      return 'That private key is encrypted with a passphrase. Decrypt it first — openssl rsa -in key.pem -out decrypted.pem — and upload the result.';
    case 'expired':
      return `That certificate expired on ${r.expiredAt}. Browsers will refuse it.`;
    case 'not-yet-valid':
      return `That certificate is not valid until ${r.validFrom}. Browsers will refuse it until then.`;
    case 'certificate-unreadable':
      return `That certificate file could not be read: ${r.detail ?? 'unknown reason'}`;
    case 'key-unreadable':
      return `That private key file could not be read: ${r.detail ?? 'unknown reason'}`;
    default:
      return 'The certificate was refused.';
  }
}
