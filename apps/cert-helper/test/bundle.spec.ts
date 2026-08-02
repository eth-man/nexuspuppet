import { checkBundle, explainRejection, splitPemBlocks } from '../src/pure/bundle';
import { makePair } from './fixtures';

jest.setTimeout(60_000); // openssl genpkey

/**
 * Validation before installation (ADR-0017).
 *
 * The reason this exists: the operator installing a certificate is using the
 * thing they are changing. A mismatched pair does not fail at upload, it fails
 * at the next TLS handshake — on the connection they would need to undo it.
 */
describe('checkBundle', () => {
  const NOW = new Date();

  it('accepts a matching pair and reports its identity', () => {
    const { certPem, keyPem } = makePair({
      subject: '/CN=console.example.test',
      sans: ['console.example.test', 'nexus.example.test'],
    });

    const result = checkBundle(certPem, keyPem, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.subject).toContain('console.example.test');
    expect(result.identity.subjectAltNames).toEqual(
      expect.arrayContaining(['console.example.test', 'nexus.example.test']),
    );
    expect(result.identity.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(result.identity.chainLength).toBe(0);
  });

  it('refuses a key that belongs to a different certificate', () => {
    // THE test. Everything else is a nicety; this is the one that stops the
    // console being taken away by its own settings screen.
    const a = makePair({ subject: '/CN=a.example.test' });
    const b = makePair({ subject: '/CN=b.example.test' });

    const result = checkBundle(a.certPem, b.keyPem, NOW);

    expect(result).toMatchObject({ ok: false, rejection: { reason: 'mismatch' } });
  });

  it('refuses an expired certificate', () => {
    const { certPem, keyPem } = makePair({ daysFrom: -400, daysTo: -30 });

    const result = checkBundle(certPem, keyPem, NOW);

    expect(result).toMatchObject({ ok: false, rejection: { reason: 'expired' } });
  });

  it('refuses one that is not valid yet', () => {
    const { certPem, keyPem } = makePair({ daysFrom: 30, daysTo: 400 });

    const result = checkBundle(certPem, keyPem, NOW);

    expect(result).toMatchObject({ ok: false, rejection: { reason: 'not-yet-valid' } });
  });

  it('names the certificate when the certificate is the unreadable one', () => {
    const { keyPem } = makePair({});

    const result = checkBundle('not a certificate', keyPem, NOW);

    expect(result).toMatchObject({ ok: false, rejection: { reason: 'certificate-unreadable' } });
  });

  it('names the key when the key is the unreadable one', () => {
    const { certPem } = makePair({});

    const result = checkBundle(certPem, 'not a key', NOW);

    expect(result).toMatchObject({ ok: false, rejection: { reason: 'key-unreadable' } });
  });

  it('says so plainly when the key is passphrase-protected', () => {
    const { certPem } = makePair({});
    const encrypted =
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkq\n-----END ENCRYPTED PRIVATE KEY-----\n';

    const result = checkBundle(certPem, encrypted, NOW);

    // Without this branch the operator gets a DER parse error and goes looking
    // for a corrupt file.
    expect(result).toMatchObject({ ok: false, rejection: { reason: 'key-encrypted' } });
  });

  it('accepts a fullchain and validates the leaf, not an issuer', () => {
    // Real uploads are fullchain.pem. Refusing them sends the operator away to
    // split a file by hand, which is when the wrong half gets installed.
    const leaf = makePair({ subject: '/CN=leaf.example.test' });
    const issuer = makePair({ subject: '/CN=issuer.example.test' });
    const fullchain = `${leaf.certPem}${issuer.certPem}`;

    const result = checkBundle(fullchain, leaf.keyPem, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.subject).toContain('leaf.example.test');
    expect(result.identity.chainLength).toBe(1);
  });

  it('refuses a fullchain whose LEAF does not match, even if a later cert would', () => {
    // Order matters, and getting it backwards is a plausible mistake.
    const leaf = makePair({ subject: '/CN=leaf.example.test' });
    const other = makePair({ subject: '/CN=other.example.test' });

    const result = checkBundle(`${leaf.certPem}${other.certPem}`, other.keyPem, NOW);

    expect(result).toMatchObject({ ok: false, rejection: { reason: 'mismatch' } });
  });
});

describe('splitPemBlocks', () => {
  it('counts the certificates in a chain', () => {
    const a = makePair({ subject: '/CN=a.example.test' });
    const b = makePair({ subject: '/CN=b.example.test' });

    expect(splitPemBlocks(`${a.certPem}${b.certPem}`)).toHaveLength(2);
    expect(splitPemBlocks('nothing here')).toHaveLength(0);
  });
});

describe('explainRejection', () => {
  it('tells the operator which file to look at, for every rejection', () => {
    // A message that says "invalid certificate" when the key is wrong sends
    // someone to check the file that is fine.
    expect(explainRejection({ reason: 'mismatch' })).toMatch(/does not belong/i);
    expect(explainRejection({ reason: 'key-encrypted' })).toMatch(/passphrase/i);
    expect(explainRejection({ reason: 'expired', expiredAt: '2020-01-01T00:00:00.000Z' })).toMatch(
      /2020-01-01/,
    );
    expect(
      explainRejection({ reason: 'not-yet-valid', validFrom: '2030-01-01T00:00:00.000Z' }),
    ).toMatch(/2030-01-01/);
    expect(explainRejection({ reason: 'certificate-unreadable', detail: 'bad der' })).toMatch(
      /certificate file/i,
    );
    expect(explainRejection({ reason: 'key-unreadable', detail: 'bad der' })).toMatch(
      /private key file/i,
    );
  });
});
