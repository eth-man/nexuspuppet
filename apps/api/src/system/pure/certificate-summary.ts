import { X509Certificate } from 'node:crypto';

/**
 * What an operator needs to know about the certificate the console is served
 * with — read from the PUBLIC certificate, and only ever from that.
 *
 * ADR-0013 keeps private keys as files mounted into the proxy and nowhere else.
 * Nothing here reads, receives or returns key material, and the shape of this
 * module is the reason that constraint is cheap to honour: everything an
 * operator actually asks about ("is it about to expire", "does it match the
 * name people use") is in the certificate, not the key.
 *
 * PURE. Takes PEM text, returns a summary. The caller does the file I/O, so this
 * is exhaustively testable against fixtures without a filesystem or a clock.
 */

export interface CertificateSummary {
  subject: string;
  issuer: string;
  /** Names this certificate is valid for. A browser matches against these. */
  subjectAltNames: string[];
  validFrom: string;
  validTo: string;
  /** Negative once expired, so a single field answers "how bad is it". */
  daysRemaining: number;
  expired: boolean;
  /** Not yet valid — a clock skew or a certificate issued for later use. */
  notYetValid: boolean;
  selfSigned: boolean;
}

export class CertificateParseError extends Error {}

/**
 * `now` is a parameter rather than a call to the clock, so expiry arithmetic is
 * testable without waiting two days for a fixture to age.
 */
export function summariseCertificate(pem: string, now: Date): CertificateSummary {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch (error) {
    // The likely causes are a key pasted where a certificate belongs, a DER file
    // renamed to .pem, or a truncated copy — worth distinguishing from "no file
    // at all", which the caller reports separately.
    throw new CertificateParseError(
      `Not a readable X.509 certificate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const validFrom = new Date(certificate.validFromDate);
  const validTo = new Date(certificate.validToDate);

  return {
    subject: flatten(certificate.subject),
    issuer: flatten(certificate.issuer),
    subjectAltNames: parseSubjectAltNames(certificate.subjectAltName),
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining: wholeDaysBetween(now, validTo),
    expired: validTo.getTime() <= now.getTime(),
    notYetValid: validFrom.getTime() > now.getTime(),
    // Compares the issuer to the subject rather than verifying a signature. That
    // is enough for the one thing this drives — telling an operator whether the
    // browser warning they are seeing is the expected private-CA one.
    selfSigned: certificate.issuer === certificate.subject,
  };
}

/** Does this certificate cover the hostname the console is reached by? */
export function coversHostname(summary: CertificateSummary, hostname: string): boolean {
  if (hostname === '') return false;
  const candidate = hostname.toLowerCase();

  return summary.subjectAltNames.some((name) => {
    const san = name.toLowerCase();
    // A wildcard matches exactly one label, and never a bare apex:
    // *.example.com covers a.example.com but not example.com or a.b.example.com.
    if (san.startsWith('*.')) {
      const suffix = san.slice(1);
      if (!candidate.endsWith(suffix)) return false;
      return !candidate.slice(0, -suffix.length).includes('.');
    }
    return san === candidate;
  });
}

/**
 * `subjectAltName` arrives as `DNS:a.example.com, IP Address:10.0.0.1`.
 *
 * Only DNS and IP entries can match a hostname a browser was given; email and
 * URI entries appear in certificates issued for other purposes and would be
 * misleading in a "does this cover your hostname" check.
 */
function parseSubjectAltNames(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const match = /^(DNS|IP Address):(.+)$/.exec(entry);
      return match?.[2] === undefined ? [] : [match[2].trim()];
    });
}

/** Multi-line subjects render badly in a card; one line reads as one fact. */
function flatten(name: string): string {
  return name.split('\n').join(', ');
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
