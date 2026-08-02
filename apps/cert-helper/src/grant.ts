import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A short-lived, single-use authorisation to install a certificate.
 *
 * STATELESS BY DESIGN. The API mints it; the helper verifies it with a shared
 * symmetric key and nothing else — no call back to the API, no database, no
 * cache. That decoupling is not tidiness: the helper is doing its work during
 * the seconds when the console's TLS is being replaced, which is exactly when
 * the API may be unreachable, slow, or restarting. A verifier that needed the
 * API would be at its least reliable at the only moment it matters.
 *
 * The grant authorises; it does not carry key material. What it asserts is
 * "someone holding settings:manage asked for this, at this time".
 */
export const GRANT_VERSION = 'v1';
export const GRANT_PURPOSE = 'console-tls-install';

/** Long enough for an upload, short enough that a leaked grant is stale fast. */
export const DEFAULT_GRANT_TTL_SECONDS = 300;

export interface GrantPayload {
  /** Unique per grant. What makes single use enforceable. */
  nonce: string;
  /** Seconds since the epoch. */
  exp: number;
  purpose: string;
  /** Who asked. Recorded for the audit row, never trusted for authorisation. */
  actor?: string;
}

export type GrantVerdict =
  | { valid: true; payload: GrantPayload }
  | {
      valid: false;
      reason: 'malformed' | 'bad-signature' | 'expired' | 'wrong-purpose' | 'replayed';
    };

/** Mints a grant. Lives here so the API and the helper cannot disagree on the format. */
export function mintGrant(
  secret: string,
  now: Date,
  actor?: string,
  ttlSeconds: number = DEFAULT_GRANT_TTL_SECONDS,
): string {
  const payload: GrantPayload = {
    nonce: randomBytes(16).toString('base64url'),
    exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
    purpose: GRANT_PURPOSE,
    ...(actor === undefined ? {} : { actor }),
  };

  const body = `${GRANT_VERSION}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${sign(secret, body)}`;
}

/**
 * Remembers which grants have been spent.
 *
 * In memory, and deliberately so. A grant lives five minutes; a helper restart
 * rolls back anything pending anyway, so a replay surviving a restart cannot
 * commit an install on its own. Persisting this would add a second piece of
 * state to keep consistent for a window measured in minutes.
 */
export class SpentGrants {
  private readonly seen = new Map<string, number>();

  consume(nonce: string, now: Date): boolean {
    this.sweep(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now.getTime());
    return true;
  }

  private sweep(now: Date): void {
    const cutoff = now.getTime() - DEFAULT_GRANT_TTL_SECONDS * 2000;
    for (const [nonce, at] of this.seen) if (at < cutoff) this.seen.delete(nonce);
  }
}

export function verifyGrant(
  secret: string,
  token: string,
  now: Date,
  spent?: SpentGrants,
): GrantVerdict {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION)
    return { valid: false, reason: 'malformed' };

  const [version, encoded, signature] = parts as [string, string, string];
  const body = `${version}.${encoded}`;

  // Signature FIRST. Nothing in the payload is trustworthy until the signature
  // says so, including the expiry — a forged grant would otherwise get to
  // choose its own.
  if (!signatureMatches(secret, body, signature)) return { valid: false, reason: 'bad-signature' };

  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as GrantPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (typeof payload.nonce !== 'string' || typeof payload.exp !== 'number') {
    return { valid: false, reason: 'malformed' };
  }

  // Checked even though this helper mints nothing else: a grant is a signed
  // statement, and a signed statement for one purpose must not be usable for
  // another if the same key is ever reused.
  if (payload.purpose !== GRANT_PURPOSE) return { valid: false, reason: 'wrong-purpose' };

  if (Math.floor(now.getTime() / 1000) >= payload.exp) return { valid: false, reason: 'expired' };

  // Consumed LAST, so a grant is not burned by a request that was going to be
  // rejected anyway.
  if (spent !== undefined && !spent.consume(payload.nonce, now)) {
    return { valid: false, reason: 'replayed' };
  }

  return { valid: true, payload };
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function signatureMatches(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, body), 'base64url');
  const given = Buffer.from(signature, 'base64url');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
