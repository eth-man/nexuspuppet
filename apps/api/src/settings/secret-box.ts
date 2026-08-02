import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encryption for settings an operator stores through the console (ADR-0016 §3).
 *
 * AES-256-GCM. Authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding plausible rubbish — which matters when the plaintext is an LDAP
 * bind DN and password: silently binding as something an attacker chose is
 * worse than not binding at all.
 *
 * WHY NOT `JWT_SECRET`. One key, one purpose. Rotating a signing secret would
 * otherwise decide whether every stored credential remains readable, and a key
 * compromised in one role would surrender the other. `CONFIG_ENCRYPTION_KEY` is
 * separate for that reason and no other.
 */

/** 12 bytes is the GCM standard and what the spec is analysed for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Envelope: version ‖ iv ‖ tag ‖ ciphertext.
 *
 * The leading version byte exists so a future key rotation or cipher change can
 * read what is already on disk. Adding it later would mean guessing the format
 * of every stored row.
 */
const VERSION = 1;

export class SecretBoxError extends Error {}

/**
 * Parse the configured key.
 *
 * Base64 or hex, 32 bytes decoded. A short key is refused rather than padded or
 * hashed into shape — quietly accepting a weak key is how a deployment ends up
 * with encryption it believes is stronger than it is.
 */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new SecretBoxError('CONFIG_ENCRYPTION_KEY is empty.');
  }

  const decoded = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (decoded.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `CONFIG_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${decoded.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }

  return decoded;
}

/**
 * Seal a JSON-serialisable value.
 *
 * Takes an object rather than a string so a caller cannot forget to serialise,
 * and so the shape of what is stored stays consistent across kinds.
 */
export function seal(key: Buffer, value: unknown): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Open a sealed value.
 *
 * Throws on a wrong key, a tampered payload, or an envelope this build does not
 * understand. The caller is expected to treat that as fatal at boot rather than
 * to fall back to the environment — a deployment that believes it is talking to
 * a configured directory must not quietly talk to a different one.
 */
export function open<T = unknown>(key: Buffer, sealed: Buffer): T {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new SecretBoxError('Stored secret is too short to be a sealed value.');
  }

  const version = sealed[0];
  if (version !== VERSION) {
    throw new SecretBoxError(
      `Stored secret has envelope version ${String(version)}, which this build does not understand.`,
    );
  }

  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(1 + IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Deliberately not echoing the underlying error. It varies with the failure
    // mode and would tell a reader of the logs which of "wrong key" and
    // "tampered payload" they are looking at.
    throw new SecretBoxError(
      'Stored secret could not be decrypted. CONFIG_ENCRYPTION_KEY may have changed, ' +
        'or the stored value may have been altered.',
    );
  }

  return JSON.parse(plaintext.toString('utf8')) as T;
}

/**
 * Whether two keys are the same, in constant time.
 *
 * Used when checking a rotation actually changes the key, so the comparison
 * cannot become a side channel on a value that never appears in a response.
 */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
