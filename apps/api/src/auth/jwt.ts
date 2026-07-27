import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT, on node:crypto.
 *
 * WHY NOT A LIBRARY
 * -----------------
 * `jsonwebtoken` is pure JavaScript but pulls ten transitive dependencies,
 * including six lodash micro-packages. For an on-prem product that may be
 * installed on air-gapped hosts, that supply-chain surface is a real cost, and
 * we need exactly one algorithm.
 *
 * This is not "rolling your own crypto" in the dangerous sense — the primitive
 * is Node's HMAC-SHA256. What is implemented here is the serialisation and,
 * more importantly, the VERIFICATION rules. Those are where JWT
 * implementations actually go wrong, so each hazard is handled explicitly and
 * has an adversarial test:
 *
 *   - algorithm confusion: the header `alg` is not trusted to select the
 *     verifier. Anything other than the literal "HS256" is rejected, so
 *     "none" and an RS256 header cannot downgrade verification.
 *   - signature comparison is constant-time.
 *   - `exp` is required. A token without an expiry is rejected rather than
 *     treated as eternal.
 *   - `iss`/`aud` are verified when configured, so a token minted for another
 *     service cannot be replayed here.
 *   - the signature is checked BEFORE any claim is read, so claim parsing
 *     never runs on unauthenticated input.
 */

const ALGORITHM = 'HS256';
const HEADER = base64UrlEncode(Buffer.from(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' })));

export class JwtError extends Error {
  constructor(
    message: string,
    readonly reason: JwtFailure,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

export type JwtFailure =
  | 'MALFORMED'
  | 'BAD_ALGORITHM'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'BAD_ISSUER'
  | 'BAD_AUDIENCE'
  | 'MISSING_EXPIRY';

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  nbf?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  [claim: string]: unknown;
}

export interface SignOptions {
  secret: string;
  subject: string;
  /** Seconds from `now`. */
  expiresInSeconds: number;
  issuer?: string;
  audience?: string;
  /** Injected rather than read from the clock, so signing is testable. */
  now?: Date;
  claims?: Record<string, unknown>;
}

export function signJwt(options: SignOptions): string {
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const payload: JwtClaims = {
    ...options.claims,
    sub: options.subject,
    iat: issuedAt,
    exp: issuedAt + options.expiresInSeconds,
    ...(options.issuer === undefined ? {} : { iss: options.issuer }),
    ...(options.audience === undefined ? {} : { aud: options.audience }),
  };

  const body = `${HEADER}.${base64UrlEncode(Buffer.from(JSON.stringify(payload)))}`;
  return `${body}.${sign(body, options.secret)}`;
}

export interface VerifyOptions {
  secret: string;
  issuer?: string;
  audience?: string;
  now?: Date;
  /** Tolerance for clock skew between replicas, in seconds. */
  clockToleranceSeconds?: number;
}

/** @throws JwtError on any failure. Never returns unverified claims. */
export function verifyJwt(token: string, options: VerifyOptions): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('Token is not a well-formed JWT.', 'MALFORMED');
  }

  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

  // The header is parsed only to REJECT unexpected algorithms. It never selects
  // a verifier — that is the algorithm-confusion attack, and the reason
  // "alg": "none" has broken so many implementations.
  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as typeof header;
  } catch {
    throw new JwtError('Token header is not valid JSON.', 'MALFORMED');
  }

  if (header.alg !== ALGORITHM) {
    throw new JwtError(
      `Unsupported JWT algorithm: ${String(header.alg)}. Only ${ALGORITHM} is accepted.`,
      'BAD_ALGORITHM',
    );
  }

  // Verify BEFORE reading any claim, so claim parsing never runs on
  // unauthenticated input.
  const expected = sign(`${encodedHeader}.${encodedPayload}`, options.secret);
  if (!constantTimeEquals(signature, expected)) {
    throw new JwtError('Token signature does not verify.', 'BAD_SIGNATURE');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as JwtClaims;
  } catch {
    throw new JwtError('Token payload is not valid JSON.', 'MALFORMED');
  }

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 0;

  // A token with no expiry is eternal. Treat its absence as a failure rather
  // than a permission.
  if (typeof claims.exp !== 'number') {
    throw new JwtError('Token has no expiry.', 'MISSING_EXPIRY');
  }
  if (now > claims.exp + tolerance) {
    throw new JwtError('Token has expired.', 'EXPIRED');
  }
  if (typeof claims.nbf === 'number' && now + tolerance < claims.nbf) {
    throw new JwtError('Token is not yet valid.', 'NOT_YET_VALID');
  }
  if (options.issuer !== undefined && claims.iss !== options.issuer) {
    throw new JwtError('Token issuer does not match.', 'BAD_ISSUER');
  }
  if (options.audience !== undefined && claims.aud !== options.audience) {
    throw new JwtError('Token audience does not match.', 'BAD_AUDIENCE');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new JwtError('Token has no subject.', 'MALFORMED');
  }

  return claims;
}

function sign(body: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(body).digest());
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Signatures are fixed-length for HS256, so a mismatch means malformed input.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Parse "15m", "30d", "3600s" into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid duration "${value}". Expected e.g. 15m, 24h, 30d.`);
  }

  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return amount * multiplier;
}
