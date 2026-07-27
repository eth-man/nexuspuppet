import { createHmac } from 'node:crypto';
import { signJwt, verifyJwt, JwtError, parseDuration } from './jwt';

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-07-27T12:00:00.000Z');

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof JwtError ? error.reason : 'NOT_A_JWT_ERROR';
  }
  return 'DID_NOT_THROW';
};

describe('signJwt / verifyJwt', () => {
  it('round-trips a token', () => {
    const token = signJwt({ secret: SECRET, subject: 'user-1', expiresInSeconds: 900, now: NOW });
    const claims = verifyJwt(token, { secret: SECRET, now: NOW });

    expect(claims.sub).toBe('user-1');
    expect(claims.exp).toBe(claims.iat + 900);
  });

  it('carries custom claims', () => {
    const token = signJwt({
      secret: SECRET,
      subject: 'user-1',
      expiresInSeconds: 900,
      now: NOW,
      claims: { role: 'ADMIN' },
    });
    expect(verifyJwt(token, { secret: SECRET, now: NOW })['role']).toBe('ADMIN');
  });
});

/**
 * These are the reason this module exists rather than a dependency. Each is a
 * documented way real JWT implementations have been broken.
 */
describe('adversarial verification', () => {
  const validToken = signJwt({
    secret: SECRET,
    subject: 'user-1',
    expiresInSeconds: 900,
    now: NOW,
  });

  describe('algorithm confusion', () => {
    // The classic: strip the signature and claim the token needs none.
    it('rejects alg=none with an empty signature', () => {
      const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
        sub: 'attacker',
        exp: 9999999999,
      })}.`;
      expect(reasonOf(() => verifyJwt(forged, { secret: SECRET, now: NOW }))).toBe('BAD_ALGORITHM');
    });

    it.each(['NONE', 'None', 'nOnE'])('rejects case-variant %s', (alg) => {
      const forged = `${b64url({ alg, typ: 'JWT' })}.${b64url({ sub: 'a', exp: 9999999999 })}.x`;
      expect(reasonOf(() => verifyJwt(forged, { secret: SECRET, now: NOW }))).toBe('BAD_ALGORITHM');
    });

    // Header must never select the verifier: an asymmetric alg with an
    // HMAC signature made from the public key is the classic RS256->HS256 attack.
    it('rejects a token claiming RS256 even with a valid HMAC signature', () => {
      const header = b64url({ alg: 'RS256', typ: 'JWT' });
      const payload = b64url({ sub: 'attacker', exp: 9999999999 });
      const sig = createHmac('sha256', SECRET)
        .update(`${header}.${payload}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(
        reasonOf(() => verifyJwt(`${header}.${payload}.${sig}`, { secret: SECRET, now: NOW })),
      ).toBe('BAD_ALGORITHM');
    });
  });

  describe('signature', () => {
    it('rejects a token signed with a different secret', () => {
      const other = signJwt({
        secret: 'b'.repeat(48),
        subject: 'user-1',
        expiresInSeconds: 900,
        now: NOW,
      });
      expect(reasonOf(() => verifyJwt(other, { secret: SECRET, now: NOW }))).toBe('BAD_SIGNATURE');
    });

    // Payload tampering is the whole reason the signature exists.
    it('rejects a token whose payload was edited', () => {
      const [header, , sig] = validToken.split('.') as [string, string, string];
      const tampered = `${header}.${b64url({ sub: 'admin', exp: 9999999999 })}.${sig}`;
      expect(reasonOf(() => verifyJwt(tampered, { secret: SECRET, now: NOW }))).toBe(
        'BAD_SIGNATURE',
      );
    });

    it('rejects a truncated signature', () => {
      const [h, p, s] = validToken.split('.') as [string, string, string];
      expect(
        reasonOf(() => verifyJwt(`${h}.${p}.${s.slice(0, -4)}`, { secret: SECRET, now: NOW })),
      ).toBe('BAD_SIGNATURE');
    });

    it('rejects an empty signature on an otherwise valid token', () => {
      const [h, p] = validToken.split('.') as [string, string];
      expect(reasonOf(() => verifyJwt(`${h}.${p}.`, { secret: SECRET, now: NOW }))).toBe(
        'BAD_SIGNATURE',
      );
    });
  });

  describe('expiry', () => {
    it('rejects an expired token', () => {
      const later = new Date(NOW.getTime() + 901_000);
      expect(reasonOf(() => verifyJwt(validToken, { secret: SECRET, now: later }))).toBe('EXPIRED');
    });

    it('accepts a token inside the clock tolerance', () => {
      const slightlyLater = new Date(NOW.getTime() + 905_000);
      expect(
        verifyJwt(validToken, { secret: SECRET, now: slightlyLater, clockToleranceSeconds: 30 })
          .sub,
      ).toBe('user-1');
    });

    // A token with no exp is eternal. Absence must fail, not permit.
    it('rejects a validly-signed token with no expiry', () => {
      const header = b64url({ alg: 'HS256', typ: 'JWT' });
      const payload = b64url({ sub: 'user-1' });
      const sig = createHmac('sha256', SECRET)
        .update(`${header}.${payload}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(
        reasonOf(() => verifyJwt(`${header}.${payload}.${sig}`, { secret: SECRET, now: NOW })),
      ).toBe('MISSING_EXPIRY');
    });
  });

  describe('issuer and audience', () => {
    const scoped = signJwt({
      secret: SECRET,
      subject: 'user-1',
      expiresInSeconds: 900,
      now: NOW,
      issuer: 'nexuspuppet',
      audience: 'nexuspuppet-api',
    });

    it('accepts matching issuer and audience', () => {
      expect(
        verifyJwt(scoped, {
          secret: SECRET,
          now: NOW,
          issuer: 'nexuspuppet',
          audience: 'nexuspuppet-api',
        }).sub,
      ).toBe('user-1');
    });

    // A token minted for another service must not be replayable here.
    it('rejects a mismatched issuer', () => {
      expect(
        reasonOf(() => verifyJwt(scoped, { secret: SECRET, now: NOW, issuer: 'somewhere-else' })),
      ).toBe('BAD_ISSUER');
    });

    it('rejects a mismatched audience', () => {
      expect(
        reasonOf(() => verifyJwt(scoped, { secret: SECRET, now: NOW, audience: 'another-api' })),
      ).toBe('BAD_AUDIENCE');
    });
  });

  describe('malformed input', () => {
    it.each([
      ['', 'empty'],
      ['not-a-token', 'no dots'],
      ['a.b', 'two segments'],
      ['a.b.c.d', 'four segments'],
      ['!!!.!!!.!!!', 'non-base64'],
    ])('rejects %s (%s) without throwing a non-JwtError', (token) => {
      const reason = reasonOf(() => verifyJwt(token, { secret: SECRET, now: NOW }));
      expect(['MALFORMED', 'BAD_ALGORITHM', 'BAD_SIGNATURE']).toContain(reason);
    });

    it('rejects a token with no subject', () => {
      const header = b64url({ alg: 'HS256', typ: 'JWT' });
      const payload = b64url({ exp: 9999999999 });
      const sig = createHmac('sha256', SECRET)
        .update(`${header}.${payload}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(
        reasonOf(() => verifyJwt(`${header}.${payload}.${sig}`, { secret: SECRET, now: NOW })),
      ).toBe('MALFORMED');
    });
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['24h', 86400],
    ['30d', 2592000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '15', 'm', '15x', '-5m', '1.5h'])('rejects %s', (input) => {
    expect(() => parseDuration(input)).toThrow();
  });
});
