import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CertificateParseError, coversHostname, summariseCertificate } from './certificate-summary';

/**
 * Against REAL certificates, generated here rather than pasted as fixtures.
 *
 * A hand-written PEM blob would prove that our parser agrees with whatever
 * produced the blob. Generating with openssl means the inputs are the shape an
 * operator's CA actually emits, including the subjectAltName formatting that
 * this module has to unpick.
 */

const openssl = (dir: string, name: string, args: string[]): string => {
  const cert = join(dir, `${name}.pem`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, `${name}.key`),
      '-out',
      cert,
      ...args,
      // openssl writes its key-generation progress dots to stderr, which would
      // otherwise bury the actual test output.
    ],
    { stdio: 'ignore' },
  );
  return readFileSync(cert, 'utf8');
};

/**
 * Real time, not a frozen constant.
 *
 * The certificates below are generated during the run, so their validFrom is
 * "a moment ago". A fixed NOW earlier than that makes every one of them
 * not-yet-valid — which is the parser being right and the test being wrong.
 * Determinism comes from generating the inputs, not from pinning the clock.
 */
const NOW = new Date();

describe('summariseCertificate', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexuspuppet-cert-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the names a browser will match against', () => {
    const pem = openssl(dir, 'multi', [
      '-days',
      '30',
      '-subj',
      '/CN=console.example.com',
      '-addext',
      // openssl takes `IP:`; Node renders it back as `IP Address:`, which is
      // precisely the asymmetry parseSubjectAltNames has to cope with.
      'subjectAltName=DNS:console.example.com,DNS:nexuspuppet.example.com,IP:10.0.0.5',
    ]);

    const summary = summariseCertificate(pem, NOW);

    expect(summary.subjectAltNames).toEqual([
      'console.example.com',
      'nexuspuppet.example.com',
      '10.0.0.5',
    ]);
    expect(summary.subject).toContain('console.example.com');
  });

  it('counts down to expiry, and goes negative past it', () => {
    const soon = openssl(dir, 'soon', ['-days', '30', '-subj', '/CN=a.test']);

    const summary = summariseCertificate(soon, NOW);

    // Generated now, valid 30 days — the arithmetic is what matters, not the
    // exact boundary, so allow the one-day rounding either side.
    expect(summary.daysRemaining).toBeGreaterThan(28);
    expect(summary.daysRemaining).toBeLessThanOrEqual(30);
    expect(summary.expired).toBe(false);
    expect(summary.notYetValid).toBe(false);
  });

  it('reports an expired certificate as expired, not as an error', () => {
    // The operationally important case. An expired console certificate is an
    // outage; reporting it as a parse failure would send someone to look at the
    // wrong thing entirely.
    const pem = openssl(dir, 'expiring', ['-days', '30', '-subj', '/CN=a.test']);

    const wayLater = new Date(NOW.getTime() + 365 * 86_400_000);
    const summary = summariseCertificate(pem, wayLater);

    expect(summary.expired).toBe(true);
    expect(summary.daysRemaining).toBeLessThan(0);
  });

  it('notices a self-signed certificate, which explains the browser warning', () => {
    const pem = openssl(dir, 'selfsigned', ['-days', '30', '-subj', '/CN=a.test']);

    expect(summariseCertificate(pem, NOW).selfSigned).toBe(true);
  });

  it('rejects a private key with a message that says what it got', () => {
    const pem = openssl(dir, 'forkey', ['-days', '30', '-subj', '/CN=a.test']);
    const key = readFileSync(join(dir, 'forkey.key'), 'utf8');
    expect(pem).toContain('BEGIN CERTIFICATE');

    // Pointing the certificate path at the key is an easy mistake, and the
    // resulting error must not read as "your certificate is corrupt".
    expect(() => summariseCertificate(key, NOW)).toThrow(CertificateParseError);
  });

  it('rejects an empty file', () => {
    expect(() => summariseCertificate('', NOW)).toThrow(CertificateParseError);
  });

  it('survives a certificate with no subjectAltName at all', () => {
    // Old certificates, and some internal CAs, carry only a CN. The summary must
    // still render; coversHostname will simply report false.
    const pem = openssl(dir, 'nosan', ['-days', '30', '-subj', '/CN=legacy.test']);

    const summary = summariseCertificate(pem, NOW);

    expect(Array.isArray(summary.subjectAltNames)).toBe(true);
    expect(summary.subject).toContain('legacy.test');
  });
});

describe('coversHostname', () => {
  const summary = (names: string[]) =>
    ({
      subject: '',
      issuer: '',
      subjectAltNames: names,
      validFrom: '',
      validTo: '',
      daysRemaining: 1,
      expired: false,
      notYetValid: false,
      selfSigned: false,
    }) as const;

  it('matches an exact name, case-insensitively', () => {
    expect(coversHostname(summary(['console.example.com']), 'console.example.com')).toBe(true);
    expect(coversHostname(summary(['Console.Example.COM']), 'console.example.com')).toBe(true);
  });

  it('does not match a different host in the same domain', () => {
    expect(coversHostname(summary(['console.example.com']), 'other.example.com')).toBe(false);
  });

  it('matches one label under a wildcard, and only one', () => {
    const wild = summary(['*.example.com']);

    expect(coversHostname(wild, 'console.example.com')).toBe(true);
    // A wildcard covers exactly one label — this is the rule browsers apply, and
    // getting it wrong in the permissive direction would tell an operator their
    // certificate is fine when the browser will reject it.
    expect(coversHostname(wild, 'a.b.example.com')).toBe(false);
    expect(coversHostname(wild, 'example.com')).toBe(false);
  });

  it('reports false for an empty hostname rather than matching everything', () => {
    expect(coversHostname(summary(['*.example.com']), '')).toBe(false);
  });

  it('reports false when the certificate carries no names', () => {
    expect(coversHostname(summary([]), 'console.example.com')).toBe(false);
  });
});
