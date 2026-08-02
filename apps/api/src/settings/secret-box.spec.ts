import { randomBytes } from 'node:crypto';
import { SecretBoxError, open, parseKey, sameKey, seal } from './secret-box';

/**
 * The properties that make stored credentials safe to keep (ADR-0016 §3).
 *
 * Not "does it round-trip" — that is the easy half. What matters is what
 * happens when the key is wrong, when the payload has been edited, and whether
 * the ciphertext leaks the plaintext it was made from.
 */

const key = () => randomBytes(32);

/** Flip one byte, so a test can corrupt a sealed value precisely. */
const flip = (buffer: Buffer, index: number): Buffer => {
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0xff, index);
  return buffer;
};

describe('parseKey', () => {
  it('accepts base64', () => {
    expect(parseKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });

  it('accepts hex', () => {
    expect(parseKey(randomBytes(32).toString('hex'))).toHaveLength(32);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['not a key at all', 'hunter2'],
  ])('refuses %s rather than padding it into shape', (_label, value) => {
    // Quietly stretching a weak key is how a deployment ends up with
    // encryption it believes is stronger than it is.
    expect(() => parseKey(value)).toThrow(SecretBoxError);
  });

  it('names the fix in the error', () => {
    // An operator reading this at 3am should not have to search for how to
    // generate a valid key.
    expect(() => parseKey('short')).toThrow(/openssl rand -base64 32/);
  });
});

describe('seal and open', () => {
  it('round-trips an object', () => {
    const k = key();
    const value = { bindDn: 'cn=svc,dc=example,dc=test', bindPassword: 'a-secret' };

    expect(open(k, seal(k, value))).toEqual(value);
  });

  it('does not leak the plaintext into the ciphertext', () => {
    // The obvious catastrophe, worth asserting rather than assuming.
    const k = key();
    const sealed = seal(k, { bindPassword: 'correct-horse-battery-staple' });

    expect(sealed.toString('utf8')).not.toContain('correct-horse-battery-staple');
    expect(sealed.toString('base64')).not.toContain('correct-horse');
  });

  it('produces a different ciphertext each time for the same input', () => {
    // A fresh IV per seal. Without it, two settings rows holding the same
    // password would be visibly identical to anyone with read access to the
    // table.
    const k = key();
    const a = seal(k, { p: 'same' });
    const b = seal(k, { p: 'same' });

    expect(a.equals(b)).toBe(false);
    expect(open(k, a)).toEqual(open(k, b));
  });

  it('refuses a wrong key', () => {
    const sealed = seal(key(), { p: 'secret' });

    expect(() => open(key(), sealed)).toThrow(SecretBoxError);
  });

  it('refuses a tampered ciphertext rather than returning rubbish', () => {
    // The reason for GCM over CBC. Silently binding to a directory as something
    // an attacker chose is worse than failing to bind.
    const k = key();
    const sealed = seal(k, { bindDn: 'cn=svc,dc=example,dc=test' });
    flip(sealed, sealed.length - 1);

    expect(() => open(k, sealed)).toThrow(SecretBoxError);
  });

  it('refuses a tampered IV', () => {
    const k = key();
    const sealed = seal(k, { p: 'secret' });
    flip(sealed, 3);

    expect(() => open(k, sealed)).toThrow(SecretBoxError);
  });

  it('refuses an envelope version it does not understand', () => {
    // The version byte exists so a future rotation can read today's rows.
    // Asserting it now is what stops it being dropped as unused.
    const k = key();
    const sealed = seal(k, { p: 'secret' });
    sealed.writeUInt8(99, 0);

    expect(() => open(k, sealed)).toThrow(/envelope version 99/);
  });

  it('refuses a truncated payload', () => {
    const k = key();
    expect(() => open(k, seal(k, { p: 'x' }).subarray(0, 10))).toThrow(/too short/i);
  });

  it('does not say WHICH failure it was', () => {
    // Wrong key and tampered payload must be indistinguishable in the message.
    // Anyone reading the logs should not learn which one they achieved.
    const k = key();
    const tampered = seal(k, { p: 'secret' });
    flip(tampered, tampered.length - 1);

    const wrongKey = (() => {
      try {
        open(key(), seal(k, { p: 'secret' }));
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();

    const altered = (() => {
      try {
        open(k, tampered);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();

    expect(wrongKey).toBe(altered);
  });
});

describe('sameKey', () => {
  it('is true for identical keys and false otherwise', () => {
    const k = key();
    expect(sameKey(k, Buffer.from(k))).toBe(true);
    expect(sameKey(k, key())).toBe(false);
  });

  it('is false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on differing lengths, which would itself leak.
    expect(sameKey(randomBytes(32), randomBytes(16))).toBe(false);
  });
});
