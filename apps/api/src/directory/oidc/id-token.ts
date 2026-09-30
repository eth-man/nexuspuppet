import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * ID token validation.
 *
 * Implemented on node:crypto rather than a JOSE library — Node imports a JWK
 * natively and verifies RS256/ES256/PS256 directly, so a dependency would buy
 * an abstraction over three lines of crypto and add a supply-chain surface to
 * the component that decides who is an administrator.
 *
 * EVERY CHECK HERE IS LEAD-BEARING. An ID token is a bearer assertion of
 * identity, and skipping any one of them turns SSO into an impersonation
 * endpoint:
 *
 *   signature   without it, anyone can mint a token naming themselves an admin
 *   alg         without pinning, `alg: none` and HS256-with-the-public-key are
 *               the classic forgeries
 *   iss         without it, a token from any issuer is accepted
 *   aud         without it, a token minted for a DIFFERENT application at the
 *               same issuer is accepted here — the confused-deputy case people
 *               most often miss
 *   nonce       without it, an old token can be replayed into a fresh login
 *   exp / iat   without them, a token stays valid forever
 */

export interface JsonWebKey {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce: string;
  clockSkewSeconds: number;
  /** Injected so tests are deterministic rather than racing the clock. */
  now?: () => number;
}

/**
 * Algorithms accepted, as an ALLOW-LIST.
 *
 * `none` is absent, obviously. So is every HMAC variant, and that one is
 * subtler: with HS256 the "key" is a shared secret, and a verifier that accepts
 * both families can be tricked into using the issuer's PUBLIC key as an HMAC
 * secret — which the attacker also has. Asymmetric only.
 */
const ALGORITHMS: Record<string, { hash: string; padding?: number }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  ES256: { hash: 'sha256' },
  ES384: { hash: 'sha384' },
  ES512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: 1 },
  PS384: { hash: 'sha384', padding: 1 },
  PS512: { hash: 'sha512', padding: 1 },
};

export class IdTokenError extends Error {}

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;

/** Header and claims WITHOUT verifying anything. Only for selecting a key. */
export function peekHeader(token: string): { alg?: string; kid?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdTokenError('malformed ID token');
  try {
    const header = decodeSegment(parts[0] as string);
    if (typeof header !== 'object' || header === null) throw new IdTokenError('malformed header');
    return header as { alg?: string; kid?: string };
  } catch (error) {
    if (error instanceof IdTokenError) throw error;
    throw new IdTokenError('malformed ID token header');
  }
}

/**
 * Verify signature and claims, returning the payload only if everything holds.
 *
 * Throws rather than returning a result object: there is no partially valid ID
 * token, and a caller that forgot to check a boolean would authenticate a
 * forgery.
 */
export function verifyIdToken(
  token: string,
  key: JsonWebKey,
  options: VerifyOptions,
): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdTokenError('malformed ID token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = peekHeader(token);
  const alg = header.alg;
  if (alg === undefined || !Object.prototype.hasOwnProperty.call(ALGORITHMS, alg)) {
    // Names the algorithm because an operator debugging an issuer configured for
    // something exotic needs to know which one was refused.
    throw new IdTokenError(`unsupported or unsafe ID token algorithm: ${String(alg)}`);
  }
  const spec = ALGORITHMS[alg] as { hash: string; padding?: number };

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: key as never, format: 'jwk' });
  } catch {
    throw new IdTokenError('identity provider signing key could not be imported');
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, 'base64url');

  const verified = cryptoVerify(
    spec.hash,
    signingInput,
    alg.startsWith('ES')
      ? { key: publicKey, dsaEncoding: 'ieee-p1363' }
      : alg.startsWith('PS')
        ? { key: publicKey, padding: 1, saltLength: 0 - 1 }
        : publicKey,
    signature,
  );
  if (!verified) throw new IdTokenError('ID token signature is not valid');

  const payload = decodeSegment(payloadB64);
  if (typeof payload !== 'object' || payload === null) {
    throw new IdTokenError('malformed ID token payload');
  }
  const claims = payload as IdTokenClaims;

  if (claims.iss !== options.issuer) {
    throw new IdTokenError(`ID token issuer mismatch: ${String(claims.iss)}`);
  }

  // `aud` may be a single value or an array; the token is for us only if our
  // client id is among them. A token minted for another application at the same
  // issuer is a valid token — just not one that says anything about access here.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new IdTokenError('ID token was not issued for this client');
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new IdTokenError('ID token has no subject');
  }

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds;

  if (typeof claims.exp !== 'number' || now > claims.exp + skew) {
    throw new IdTokenError('ID token has expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) {
    throw new IdTokenError('ID token was issued in the future');
  }

  // The nonce ties this token to the login THIS browser began. Without it a
  // token captured from an earlier session can be replayed into a new one.
  if (claims.nonce !== options.nonce) {
    throw new IdTokenError('ID token nonce does not match this login attempt');
  }

  return claims;
}

/**
 * Where the identity provider said the groups went, when it declined to send
 * them (nexuspuppet#105).
 *
 * Entra ID omits the `groups` claim entirely once a user is in roughly 150
 * groups — 200 for implicit flows — and instead sends `_claim_names` and
 * `_claim_sources` pointing at Microsoft Graph. That is a documented product
 * behaviour, not an error, and it arrives looking exactly like a user in no
 * groups at all.
 *
 * The consequence is upside down: the person in 150+ groups is a senior
 * administrator, so the failure lands on the account being onboarded while
 * ordinary users sign in fine. Without this, the refusal reads "in no mapped
 * group" and sends the operator to audit role mappings that are correct.
 *
 * @returns the Graph endpoint the provider referred us to, or null when no
 *          overage was signalled.
 */
export function groupOverageEndpoint(claims: IdTokenClaims, groupsClaim: string): string | null {
  const names = claims['_claim_names'];
  if (typeof names !== 'object' || names === null) return null;

  const source = (names as Record<string, unknown>)[groupsClaim];
  if (typeof source !== 'string') return null;

  // The endpoint is a courtesy for the message. An overage is signalled by the
  // reference existing at all, so a provider that omits `_claim_sources`, or
  // shapes it differently, is still reported rather than silently ignored.
  const sources = claims['_claim_sources'];
  if (typeof sources === 'object' && sources !== null) {
    const entry = (sources as Record<string, unknown>)[source];
    if (typeof entry === 'object' && entry !== null) {
      const endpoint = (entry as Record<string, unknown>)['endpoint'];
      if (typeof endpoint === 'string') return endpoint;
    }
  }

  return 'an endpoint the provider did not name';
}

/**
 * Read a claim as a list of group names.
 *
 * Providers disagree: Entra sends an array, some send a single string, others a
 * space- or comma-separated one. Accepting all three is not laxity — refusing a
 * valid provider's shape would present as "nobody can log in".
 */
export function groupsFromClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}
