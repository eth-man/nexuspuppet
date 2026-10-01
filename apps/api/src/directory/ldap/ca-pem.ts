import type { CertificateSummary } from '@nexuspuppet/contracts';
import { CertificateParseError, summariseCertificate } from '../../system/pure/certificate-summary';

/**
 * A CA bundle pasted into the console, checked before it is stored (ADR-0029 §5).
 *
 * The LDAP settings accept the directory's CA as PEM text so an operator can
 * trust an internal CA without shell access to mount a file. That text is
 * PUBLIC — a CA certificate is what every client is handed — so it is ordinary
 * configuration. Two things are still worth refusing at the door:
 *
 * - **A private key.** Pasted into the wrong box, it is a key that has already
 *   been copied somewhere it should not be. Storing it "safely" would hide
 *   that; refusing says it.
 * - **Anything that does not parse.** A CA that fails here would fail every
 *   ldaps:// handshake later, with an error naming TLS rather than the paste.
 */

export class CaPemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaPemError';
  }
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const ANY_BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/g;

/**
 * Parse every certificate in a PEM bundle, or say exactly what is wrong.
 *
 * Text outside the blocks is tolerated — `openssl` writes `subject=` and
 * `Bag Attributes` lines above certificates, and a bundle copied from its
 * output should not be refused for them. A PEM block of any OTHER type is
 * refused by name, because a public key or a CSR in a CA box is a mistake
 * the operator wants to hear about.
 *
 * @throws CaPemError with a message fit to show the operator.
 */
export function parseCaPem(pem: string, now: Date = new Date()): CertificateSummary[] {
  if (PRIVATE_KEY.test(pem)) {
    throw new CaPemError(
      'This contains a PRIVATE KEY. Paste only the CA certificate (-----BEGIN CERTIFICATE-----); ' +
        'a private key must never leave the CA, and this console will not store one.',
    );
  }

  for (const match of pem.matchAll(ANY_BEGIN)) {
    const kind = match[1];
    if (kind !== undefined && kind !== 'CERTIFICATE') {
      throw new CaPemError(
        `This contains a "${kind}" block. Only CERTIFICATE blocks belong in a CA bundle.`,
      );
    }
  }

  const blocks = pem.match(CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new CaPemError(
      'No certificate found. Expected one or more PEM blocks starting with ' +
        '-----BEGIN CERTIFICATE----- and ending with -----END CERTIFICATE-----.',
    );
  }

  return blocks.map((block, index) => {
    try {
      // The console-certificate card's parser (ADR-0017): one way to read a
      // certificate, so one certificate reads the same on every screen.
      return summariseCertificate(block, now);
    } catch (error) {
      const which = blocks.length === 1 ? 'The certificate' : `Certificate ${index + 1}`;
      const detail =
        error instanceof CertificateParseError || error instanceof Error
          ? error.message
          : String(error);
      throw new CaPemError(
        `${which} does not parse: ${detail}. It may be truncated, or have lost its line ` +
          'breaks in the copy.',
      );
    }
  });
}

/**
 * The summary for a stored bundle, or empty when there is none.
 *
 * Never throws: a stored value was validated when it was saved, and a settings
 * READ that failed because of it would take the Save button down with it. A
 * value that somehow no longer parses shows no certificates, and the login
 * path — which parses it again — refuses loudly.
 */
export function summariseCaPem(
  pem: string | undefined,
  now: Date = new Date(),
): CertificateSummary[] {
  if (pem === undefined || pem.trim() === '') return [];
  try {
    return parseCaPem(pem, now);
  } catch {
    return [];
  }
}
