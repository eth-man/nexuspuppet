import { hashPassword, verifyPassword, needsRehash, SCRYPT_PARAMS } from './password';

// scrypt at these parameters is intentionally slow (~100ms per call).
jest.setTimeout(30_000);

describe('hashPassword', () => {
  it('produces a self-describing hash carrying its parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const [algorithm, N, r, p, salt, digest] = hash.split('$');

    expect(algorithm).toBe('scrypt');
    expect(Number(N)).toBe(SCRYPT_PARAMS.N);
    expect(Number(r)).toBe(SCRYPT_PARAMS.r);
    expect(Number(p)).toBe(SCRYPT_PARAMS.p);
    expect(Buffer.from(salt as string, 'base64')).toHaveLength(SCRYPT_PARAMS.saltLength);
    expect(Buffer.from(digest as string, 'base64')).toHaveLength(SCRYPT_PARAMS.keyLength);
  });

  // A shared or absent salt makes the whole table crackable at once.
  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same', a)).resolves.toBe(true);
    await expect(verifyPassword('same', b)).resolves.toBe(true);
  });

  it('refuses an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    await expect(verifyPassword('s3cret-passphrase', hash)).resolves.toBe(true);
  });

  it.each([
    ['wrong-passphrase', 'a different password'],
    ['s3cret-passphras', 'a prefix'],
    ['S3cret-passphrase', 'different case'],
    ['s3cret-passphrase ', 'trailing whitespace'],
    ['', 'empty'],
  ])('rejects %s (%s)', async (attempt) => {
    const hash = await hashPassword('s3cret-passphrase');
    await expect(verifyPassword(attempt, hash)).resolves.toBe(false);
  });

  it('handles unicode and long passwords', async () => {
    const unicode = 'pässwörd-日本語-🔐';
    await expect(verifyPassword(unicode, await hashPassword(unicode))).resolves.toBe(true);

    const long = 'x'.repeat(1000);
    await expect(verifyPassword(long, await hashPassword(long))).resolves.toBe(true);
  });

  // Without NFC normalisation, the same password typed on a different OS or
  // keyboard layout can fail to verify — an invisible lockout.
  it('normalises unicode so composed and decomposed forms match', async () => {
    const composed = 'café'.normalize('NFC');
    const decomposed = 'café'.normalize('NFD');
    expect(composed).not.toBe(decomposed);

    await expect(verifyPassword(decomposed, await hashPassword(composed))).resolves.toBe(true);
  });

  // A corrupt row must fail the login, not 500 the endpoint and reveal that the
  // record is unusual.
  describe('malformed stored hashes return false rather than throwing', () => {
    it.each([
      ['', 'empty'],
      ['not-a-hash', 'no structure'],
      ['scrypt$32768$8', 'too few fields'],
      ['bcrypt$32768$8$1$c2FsdA==$aGFzaA==', 'wrong algorithm'],
      ['scrypt$abc$8$1$c2FsdA==$aGFzaA==', 'non-numeric N'],
      ['scrypt$0$8$1$c2FsdA==$aGFzaA==', 'zero N'],
      ['scrypt$-1$8$1$c2FsdA==$aGFzaA==', 'negative N'],
      ['scrypt$32768$8$1$$aGFzaA==', 'empty salt'],
      ['scrypt$32768$8$1$c2FsdA==$', 'empty digest'],
    ])('returns false for %s (%s)', async (stored) => {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    });

    // One hostile row could otherwise exhaust memory on every login attempt.
    it('refuses implausibly large parameters instead of allocating', async () => {
      const bomb = 'scrypt$99999999999$1024$1024$c2FsdA==$aGFzaA==';
      await expect(verifyPassword('anything', bomb)).resolves.toBe(false);
    });
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with current parameters', async () => {
    expect(needsRehash(await hashPassword('password'))).toBe(false);
  });

  // The point of the self-describing format: raise the cost factor later and
  // upgrade records transparently on next login.
  it('is true for weaker parameters', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });

  it('is true for an unparseable hash, which cannot be verified anyway', () => {
    expect(needsRehash('garbage')).toBe(true);
  });
});
