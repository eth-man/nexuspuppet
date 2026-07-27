import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with scrypt from node:crypto (ADR-0006).
 *
 * scrypt rather than argon2 or bcrypt because both of those are NATIVE modules.
 * An on-prem operator on a locked-down or air-gapped host may have no build
 * toolchain, and "install a C compiler" is a poor first step for a
 * configuration-management console. scrypt is a memory-hard KDF in the Node
 * standard library with zero build dependencies.
 *
 * STORAGE FORMAT is self-describing:
 *
 *   scrypt$N$r$p$<base64 salt>$<base64 hash>
 *
 * Parameters travel with each hash, so they can be raised later and older
 * records still verify against the parameters they were created with. A
 * bare hash would freeze today's cost factor forever.
 */

/**
 * promisify() resolves to the 3-argument overload, which drops the options
 * object we need in order to set N/r/p and maxmem. Typed explicitly so the
 * cost parameters are actually applied rather than silently defaulted.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=2^15 (32768), r=8, p=1 — roughly 32 MiB and ~100ms on current hardware.
 * OWASP's floor for scrypt is N=2^15, r=8, p=1 minimum.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 64, saltLength: 32 } as const;

/**
 * scrypt needs maxmem above roughly 128 * N * r bytes; Node's default of 32 MiB
 * is exactly at the boundary for these parameters and throws.
 */
const MAX_MEM = 256 * 1024 * 1024;

const PREFIX = 'scrypt';

export class PasswordFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordFormatError';
  }
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) {
    throw new PasswordFormatError('Refusing to hash an empty password.');
  }

  const { N, r, p, keyLength, saltLength } = SCRYPT_PARAMS;
  const salt = randomBytes(saltLength);
  const derived = await scrypt(normalize(plaintext), salt, keyLength, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });

  return [PREFIX, N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verify a plaintext against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt
 * row must fail the login, not 500 the endpoint and leak that the record is
 * unusual.
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(stored);
  } catch {
    return false;
  }

  let derived: Buffer;
  try {
    derived = await scrypt(normalize(plaintext), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }

  // Constant-time: a fast-path length check plus timingSafeEqual, so verifying
  // never leaks how much of the hash matched.
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * True when a stored hash was made with weaker parameters than we now use, so
 * it can be transparently upgraded on the next successful login.
 */
export function needsRehash(stored: string): boolean {
  try {
    const parsed = parseHash(stored);
    return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.p < SCRYPT_PARAMS.p;
  } catch {
    // Unparseable means it cannot be verified either; treat as needing replacement.
    return true;
  }
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    throw new PasswordFormatError('Unrecognised password hash format.');
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (!isPositiveInteger(N) || !isPositiveInteger(r) || !isPositiveInteger(p)) {
    throw new PasswordFormatError('Password hash has invalid scrypt parameters.');
  }

  // A hostile or corrupt row could otherwise name parameters large enough to
  // exhaust memory on every login attempt — a denial of service triggered by
  // one bad database record.
  if (N > 1_048_576 || r > 32 || p > 16) {
    throw new PasswordFormatError('Password hash names implausible scrypt parameters.');
  }

  const salt = Buffer.from(parts[4] as string, 'base64');
  const hash = Buffer.from(parts[5] as string, 'base64');

  if (salt.length === 0 || hash.length === 0) {
    throw new PasswordFormatError('Password hash has an empty salt or digest.');
  }

  return { N, r, p, salt, hash };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Normalise to NFC so a password typed with a decomposed accent verifies
 * against one stored composed. Without this a user on a different keyboard
 * layout or OS can be locked out by an invisible difference.
 */
function normalize(plaintext: string): string {
  return plaintext.normalize('NFC');
}
