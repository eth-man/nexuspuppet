import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  IdTokenError,
  groupOverageEndpoint,
  groupsFromClaim,
  peekHeader,
  verifyIdToken,
  type IdTokenClaims,
  type JsonWebKey,
} from '../src/oidc/id-token';

/**
 * ID token validation, against REAL signatures.
 *
 * Every test here signs a token with a real key and verifies it with the
 * matching JWK, because the failure mode being guarded against is precisely a
 * verifier that accepts something it should not. A mocked verifier would agree
 * with whatever the code already believes.
 *
 * An ID token is a bearer assertion of identity: skip one check and SSO becomes
 * an impersonation endpoint. Each test names the attack its check prevents.
 */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'nexuspuppet';
const NONCE = 'nonce-from-this-login';
const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const now = () => NOW;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'key-1', alg: 'RS256' };

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(
  claims: Record<string, unknown>,
  over: { alg?: string; kid?: string; key?: KeyObject; signature?: string } = {},
): string {
  const header = { alg: over.alg ?? 'RS256', typ: 'JWT', kid: over.kid ?? 'key-1' };
  const body = `${b64(header)}.${b64(claims)}`;
  if (over.signature !== undefined) return `${body}.${over.signature}`;
  const signer = createSign('sha256');
  signer.update(body);
  return `${body}.${signer.sign(over.key ?? privateKey, 'base64url')}`;
}

const validClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: 'user-123',
  aud: CLIENT_ID,
  exp: Math.floor(NOW / 1000) + 300,
  iat: Math.floor(NOW / 1000) - 5,
  nonce: NONCE,
  email: 'alice@example.com',
  ...over,
});

const options = { issuer: ISSUER, audience: CLIENT_ID, nonce: NONCE, clockSkewSeconds: 60, now };

describe('verifyIdToken', () => {
  it('accepts a correctly signed token', () => {
    const claims = verifyIdToken(sign(validClaims()), jwk, options);

    expect(claims.sub).toBe('user-123');
    expect(claims['email']).toBe('alice@example.com');
  });

  /**
   * The forgery everything else rests on. Without a signature check anyone can
   * mint a token naming themselves an administrator.
   */
  it('rejects a token signed by the wrong key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

    expect(() =>
      verifyIdToken(sign(validClaims(), { key: other.privateKey }), jwk, options),
    ).toThrow(/signature is not valid/);
  });

  it('rejects a token whose payload was edited after signing', () => {
    const token = sign(validClaims());
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${b64(validClaims({ email: 'attacker@example.com' }))}.${signature}`;

    expect(() => verifyIdToken(tampered, jwk, options)).toThrow(/signature is not valid/);
  });

  /**
   * `alg: none` — the oldest JWT attack there is. A verifier that honours the
   * header's choice of algorithm lets the token say it needs no signature.
   */
  it('rejects alg: none', () => {
    expect(() =>
      verifyIdToken(sign(validClaims(), { alg: 'none', signature: '' }), jwk, options),
    ).toThrow(/unsupported or unsafe/);
  });

  /**
   * Algorithm confusion. With HS256 the key is a shared secret, so a verifier
   * accepting both families can be tricked into using the issuer's PUBLIC key
   * as an HMAC secret — which the attacker also has.
   */
  it('rejects a symmetric algorithm', () => {
    expect(() =>
      verifyIdToken(sign(validClaims(), { alg: 'HS256', signature: 'x' }), jwk, options),
    ).toThrow(/unsupported or unsafe/);
  });

  it('rejects a token from a different issuer', () => {
    expect(() =>
      verifyIdToken(sign(validClaims({ iss: 'https://evil.test' })), jwk, options),
    ).toThrow(/issuer mismatch/);
  });

  /**
   * The confused-deputy case people most often miss. A token minted for a
   * DIFFERENT application at the same issuer is perfectly valid — it just says
   * nothing about access here.
   */
  it('rejects a token minted for another client', () => {
    expect(() => verifyIdToken(sign(validClaims({ aud: 'some-other-app' })), jwk, options)).toThrow(
      /not issued for this client/,
    );
  });

  it('accepts an audience array containing this client', () => {
    const claims = verifyIdToken(
      sign(validClaims({ aud: ['other-app', CLIENT_ID] })),
      jwk,
      options,
    );

    expect(claims.sub).toBe('user-123');
  });

  it('rejects an audience array that does not contain this client', () => {
    expect(() =>
      verifyIdToken(sign(validClaims({ aud: ['other-app', 'third-app'] })), jwk, options),
    ).toThrow(/not issued for this client/);
  });

  it('rejects an expired token', () => {
    const expired = validClaims({ exp: Math.floor(NOW / 1000) - 3600 });

    expect(() => verifyIdToken(sign(expired), jwk, options)).toThrow(/expired/);
  });

  /** Within the skew allowance, because estates do not have perfect clocks. */
  it('accepts a token that expired within the clock skew', () => {
    const justExpired = validClaims({ exp: Math.floor(NOW / 1000) - 30 });

    expect(verifyIdToken(sign(justExpired), jwk, options).sub).toBe('user-123');
  });

  it('rejects a token issued in the future beyond the skew', () => {
    const future = validClaims({ iat: Math.floor(NOW / 1000) + 3600 });

    expect(() => verifyIdToken(sign(future), jwk, options)).toThrow(/issued in the future/);
  });

  /**
   * Replay. Without the nonce, a token captured from an earlier login can be
   * presented again to start a new session.
   */
  it('rejects a token whose nonce belongs to a different login', () => {
    expect(() =>
      verifyIdToken(sign(validClaims({ nonce: 'someone-elses-nonce' })), jwk, options),
    ).toThrow(/nonce does not match/);
  });

  it('rejects a token with no nonce at all', () => {
    const { nonce: _dropped, ...withoutNonce } = validClaims();

    expect(() => verifyIdToken(sign(withoutNonce), jwk, options)).toThrow(/nonce does not match/);
  });

  it('rejects a token with no subject', () => {
    const { sub: _dropped, ...withoutSub } = validClaims();

    expect(() => verifyIdToken(sign(withoutSub), jwk, options)).toThrow(/no subject/);
  });

  it.each(['', 'not-a-jwt', 'only.two'])('rejects the malformed token %p', (token) => {
    expect(() => verifyIdToken(token, jwk, options)).toThrow(IdTokenError);
  });
});

describe('peekHeader', () => {
  it('reads the kid without verifying anything', () => {
    expect(peekHeader(sign(validClaims(), { kid: 'key-7' })).kid).toBe('key-7');
  });

  it('throws on a malformed token rather than returning a guess', () => {
    expect(() => peekHeader('nonsense')).toThrow(IdTokenError);
  });
});

describe('groupsFromClaim', () => {
  /**
   * Providers genuinely disagree here. Refusing a valid provider's shape
   * presents to an operator as "SSO does not work", with nothing to go on.
   */
  it('reads an array, as Entra ID sends', () => {
    expect(groupsFromClaim(['ops', 'admins'])).toEqual(['ops', 'admins']);
  });

  it('reads a space-separated string', () => {
    expect(groupsFromClaim('ops admins')).toEqual(['ops', 'admins']);
  });

  it('reads a comma-separated string', () => {
    expect(groupsFromClaim('ops, admins')).toEqual(['ops', 'admins']);
  });

  it('drops non-strings rather than coercing them', () => {
    expect(groupsFromClaim(['ops', 42, null, 'admins'])).toEqual(['ops', 'admins']);
  });

  it('is empty for an absent or unusable claim', () => {
    expect(groupsFromClaim(undefined)).toEqual([]);
    expect(groupsFromClaim({ nested: true })).toEqual([]);
  });
});

/**
 * Entra ID group overage (nexuspuppet#105).
 *
 * Past roughly 150 memberships Entra omits the groups claim and refers the
 * relying party to Graph. It arrives looking exactly like a user in no groups —
 * and lands on administrators first, since they are who accumulate 150 groups.
 */
describe('groupOverageEndpoint', () => {
  const base = (extra: Record<string, unknown> = {}): IdTokenClaims => ({
    iss: 'https://login.microsoftonline.com/tid/v2.0',
    sub: 'u1',
    aud: 'client',
    exp: 0,
    iat: 0,
    ...extra,
  });

  it('reports the endpoint Entra referred us to', () => {
    const claims = base({
      _claim_names: { groups: 'src1' },
      _claim_sources: {
        src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/u1/getMemberObjects' },
      },
    });

    expect(groupOverageEndpoint(claims, 'groups')).toBe(
      'https://graph.microsoft.com/v1.0/users/u1/getMemberObjects',
    );
  });

  /*
   * The reference existing at all is the signal. A provider that omits
   * `_claim_sources`, or shapes it differently, must still be reported —
   * silence here is the whole defect.
   */
  it('still reports an overage when the source is not resolvable', () => {
    expect(groupOverageEndpoint(base({ _claim_names: { groups: 'src1' } }), 'groups')).toBe(
      'an endpoint the provider did not name',
    );
  });

  it('honours a non-default groups claim name', () => {
    const claims = base({ _claim_names: { roles: 'src1' } });

    expect(groupOverageEndpoint(claims, 'roles')).not.toBeNull();
    expect(groupOverageEndpoint(claims, 'groups')).toBeNull();
  });

  it('is null for an ordinary token, so a genuinely unmapped user still reads as one', () => {
    expect(groupOverageEndpoint(base({ groups: ['ops'] }), 'groups')).toBeNull();
    expect(groupOverageEndpoint(base(), 'groups')).toBeNull();
  });

  it('is null when the claim names something that is not a source reference', () => {
    expect(groupOverageEndpoint(base({ _claim_names: { groups: 42 } }), 'groups')).toBeNull();
    expect(groupOverageEndpoint(base({ _claim_names: 'nonsense' }), 'groups')).toBeNull();
  });
});
