import { createHmac } from 'node:crypto';
import { GRANT_VERSION, SpentGrants, mintGrant, verifyGrant } from '@nexuspuppet/tls-grant';

const SECRET = 'a'.repeat(48);
const OTHER = 'b'.repeat(48);
const NOW = new Date('2026-08-02T10:00:00.000Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

/**
 * The grant is verified with a shared key and nothing else — no call to the
 * API, no database (ADR-0017). The helper does its work in the seconds when the
 * console's TLS is being replaced, which is precisely when the API may be
 * unreachable; a verifier that needed it would be least reliable exactly when
 * it mattered.
 */
describe('grant', () => {
  it('mints and verifies without consulting anything', () => {
    const token = mintGrant(SECRET, NOW, 'admin@example.test');

    const verdict = verifyGrant(SECRET, token, later(10));

    expect(verdict.valid).toBe(true);
    if (!verdict.valid) return;
    expect(verdict.payload.actor).toBe('admin@example.test');
  });

  it('refuses a grant signed with a different key', () => {
    const token = mintGrant(OTHER, NOW);

    expect(verifyGrant(SECRET, token, later(10))).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a tampered payload', () => {
    // The attack this exists to stop: extend your own grant's life by editing
    // the part of it you can read.
    const token = mintGrant(SECRET, NOW);
    const [version, encoded, signature] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.exp += 86_400;
    const forged = `${version}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;

    expect(verifyGrant(SECRET, forged, later(10))).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('checks the signature before believing the expiry', () => {
    // A forged grant must not get to choose its own deadline. Signed with the
    // wrong key AND already expired: the signature is what it is rejected for.
    const token = mintGrant(OTHER, NOW, undefined, 1);

    expect(verifyGrant(SECRET, token, later(3600))).toMatchObject({ reason: 'bad-signature' });
  });

  it('refuses an expired grant', () => {
    const token = mintGrant(SECRET, NOW, undefined, 300);

    expect(verifyGrant(SECRET, token, later(301))).toMatchObject({
      valid: false,
      reason: 'expired',
    });
  });

  it('accepts one a second before it expires', () => {
    const token = mintGrant(SECRET, NOW, undefined, 300);

    expect(verifyGrant(SECRET, token, later(299)).valid).toBe(true);
  });

  it('refuses a correctly signed grant issued for another purpose', () => {
    // If this key is ever reused for something else, a grant for that thing
    // must not install a certificate.
    const payload = { nonce: 'n1', exp: Math.floor(later(60).getTime() / 1000), purpose: 'other' };
    const body = `${GRANT_VERSION}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const signature = createHmac('sha256', SECRET).update(body).digest('base64url');

    expect(verifyGrant(SECRET, `${body}.${signature}`, later(10))).toMatchObject({
      reason: 'wrong-purpose',
    });
  });

  it.each([['garbage'], ['v1.only-two-parts'], ['v2.abc.def'], ['']])(
    'refuses malformed input %p',
    (token) => {
      expect(verifyGrant(SECRET, token, NOW).valid).toBe(false);
    },
  );

  describe('single use', () => {
    it('accepts a grant once and refuses the replay', () => {
      const spent = new SpentGrants();
      const token = mintGrant(SECRET, NOW);

      expect(verifyGrant(SECRET, token, later(1), spent).valid).toBe(true);
      expect(verifyGrant(SECRET, token, later(2), spent)).toMatchObject({ reason: 'replayed' });
    });

    it('does not burn a grant on a request that was going to be rejected', () => {
      // Rejected for purpose, so the nonce must remain unspent — otherwise a
      // malformed retry costs the operator their grant.
      const spent = new SpentGrants();
      const payload = {
        nonce: 'n2',
        exp: Math.floor(later(60).getTime() / 1000),
        purpose: 'other',
      };
      const body = `${GRANT_VERSION}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      const signature = createHmac('sha256', SECRET).update(body).digest('base64url');
      verifyGrant(SECRET, `${body}.${signature}`, later(10), spent);

      // A well-formed grant carrying the same nonce still works.
      const good = {
        nonce: 'n2',
        exp: Math.floor(later(60).getTime() / 1000),
        purpose: 'console-tls-install',
      };
      const goodBody = `${GRANT_VERSION}.${Buffer.from(JSON.stringify(good)).toString('base64url')}`;
      const goodSig = createHmac('sha256', SECRET).update(goodBody).digest('base64url');

      expect(verifyGrant(SECRET, `${goodBody}.${goodSig}`, later(10), spent).valid).toBe(true);
    });

    it('treats two grants as distinct', () => {
      const spent = new SpentGrants();

      expect(verifyGrant(SECRET, mintGrant(SECRET, NOW), later(1), spent).valid).toBe(true);
      expect(verifyGrant(SECRET, mintGrant(SECRET, NOW), later(1), spent).valid).toBe(true);
    });
  });
});
