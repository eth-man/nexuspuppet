import { X509Certificate, createPrivateKey } from 'node:crypto';

/**
 * Why an uploaded bundle was refused.
 *
 * An operator installing a certificate has four files on their desk with
 * similar names and no way to tell them apart by looking. "Invalid certificate"
 * sends them to check the wrong one. Each case here names the file and what was
 * wrong with it, because the whole value of validating before installing is the
 * message it produces.
 */
export type BundleRejection =
  | { reason: 'certificate-unreadable'; detail: string }
  | { reason: 'key-unreadable'; detail: string }
  | { reason: 'key-encrypted' }
  | { reason: 'mismatch' }
  | { reason: 'expired'; expiredAt: string }
  | { reason: 'not-yet-valid'; validFrom: string };

export interface BundleIdentity {
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  /** SHA-256, colon-separated upper-case hex. What an operator compares by eye. */
  fingerprint: string;
  validFrom: string;
  validTo: string;
  /** Certificates after the leaf, if a chain was supplied. */
  chainLength: number;
}

export type BundleCheck =
  { ok: true; identity: BundleIdentity } | { ok: false; rejection: BundleRejection };

/** PEM blocks, in file order. A fullchain has the leaf first, then issuers. */
export function splitPemBlocks(pem: string): string[] {
  const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches ?? [];
}

/**
 * Does this certificate and key belong together, and can it be served today?
 *
 * PURE. No filesystem, no clock of its own — `now` is passed in so the validity
 * window is testable without waiting a year.
 *
 * Accepts a chain. Real deployments upload `fullchain.pem`, and rejecting that
 * because it holds more than one certificate would send the operator away to
 * split a file by hand, which is exactly when the wrong half gets installed.
 * The LEAF is validated; the rest is carried through untouched.
 */
export function checkBundle(certPem: string, keyPem: string, now: Date): BundleCheck {
  const blocks = splitPemBlocks(certPem);

  if (blocks.length === 0) {
    return {
      ok: false,
      rejection: {
        reason: 'certificate-unreadable',
        detail:
          'No PEM certificate block found. Expected a file beginning "-----BEGIN CERTIFICATE-----".',
      },
    };
  }

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(blocks[0]!);
  } catch (error) {
    return { ok: false, rejection: { reason: 'certificate-unreadable', detail: message(error) } };
  }

  // Checked before parsing, because an encrypted key fails to parse with a
  // message about the DER that sends the operator hunting for a corrupt file
  // when the actual answer is "decrypt it first".
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(keyPem)) {
    return { ok: false, rejection: { reason: 'key-encrypted' } };
  }

  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch (error) {
    return { ok: false, rejection: { reason: 'key-unreadable', detail: message(error) } };
  }

  // The check that stops a dead listener. Installing a mismatched pair produces
  // a proxy that refuses every handshake, on the interface the operator is
  // using to fix it.
  if (!leaf.checkPrivateKey(key)) {
    return { ok: false, rejection: { reason: 'mismatch' } };
  }

  const validFrom = new Date(leaf.validFrom);
  const validTo = new Date(leaf.validTo);

  if (now > validTo) {
    return { ok: false, rejection: { reason: 'expired', expiredAt: validTo.toISOString() } };
  }
  if (now < validFrom) {
    return {
      ok: false,
      rejection: { reason: 'not-yet-valid', validFrom: validFrom.toISOString() },
    };
  }

  return {
    ok: true,
    identity: {
      subject: leaf.subject,
      issuer: leaf.issuer,
      subjectAltNames: parseSans(leaf.subjectAltName),
      fingerprint: leaf.fingerprint256,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      chainLength: blocks.length - 1,
    },
  };
}

/** "DNS:a.example, DNS:b.example" — the names, without their type prefixes. */
function parseSans(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/^(DNS|IP Address|IP|URI|email):/i, ''))
    .filter((entry) => entry.length > 0);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One sentence an operator can act on. */
export function explainRejection(rejection: BundleRejection): string {
  switch (rejection.reason) {
    case 'certificate-unreadable':
      return `That certificate file could not be read: ${rejection.detail}`;
    case 'key-unreadable':
      return `That private key file could not be read: ${rejection.detail}`;
    case 'key-encrypted':
      return (
        'That private key is encrypted with a passphrase. Decrypt it first — ' +
        'openssl rsa -in key.pem -out decrypted.pem — and upload the result. ' +
        'The proxy has nowhere to keep a passphrase.'
      );
    case 'mismatch':
      return (
        'That private key does not belong to that certificate. Installing them ' +
        'together would leave the console unable to complete any connection, ' +
        'including this one.'
      );
    case 'expired':
      return `That certificate expired on ${rejection.expiredAt}. Browsers will refuse it.`;
    case 'not-yet-valid':
      return `That certificate is not valid until ${rejection.validFrom}. Browsers will refuse it until then.`;
  }
}
