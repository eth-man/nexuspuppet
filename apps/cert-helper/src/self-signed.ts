import { execFile } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CERT_FILE, KEY_FILE, LIVE_LINK, SETS_DIR, swapLive } from './install';
import { exists } from './adopt';

const run = promisify(execFile);

/**
 * The marker that says WE made this one.
 *
 * A certificate that is self-signed because this helper generated it, and one
 * that is self-signed because an operator deliberately installed it, are
 * indistinguishable from the outside — both have issuer equal to subject. The
 * console has to be able to say "replace this, it is a placeholder" about the
 * first without nagging about the second, so the placeholder names itself.
 */
export const TEMPORARY_MARKER = 'NexusPuppet temporary self-signed';

/**
 * Five years.
 *
 * Long deliberately. A fallback certificate that expires converts a working
 * console into a broken one, on a date nobody wrote down, for a deployment that
 * by definition never got round to installing a real certificate. The risk a
 * short lifetime manages — a leaked key staying valid — is not the risk here:
 * this key is generated on the host it serves and never leaves it.
 */
const VALID_DAYS = 365 * 5;

/**
 * Hostnames this will put in a certificate.
 *
 * Not a security boundary — `execFile` takes an argument array and never a
 * shell, so nothing here can inject a second command. It is a correctness
 * check: `CONSOLE_HOSTNAME` arrives from the environment, and an empty or
 * malformed value would produce a certificate no browser matches, which is a
 * worse outcome than refusing to generate one.
 */
const HOSTNAME =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Give an empty deployment something to serve (ADR-0013, self-signed fallback).
 *
 * Runs after `adoptExisting`, so a directory with a real certificate in it is
 * never touched. Reaching this function means there is genuinely nothing to
 * serve, and the alternatives at that point are a proxy that will not start or
 * a console on plain HTTP — a browser warning is the best of the three.
 *
 * Writes through the same set-and-symlink mechanism as a real install, so the
 * placeholder is replaced by exactly the same code path that replaces any other
 * certificate, and `live` always means the same thing.
 */
export async function generateSelfSigned(
  root: string,
  hostname: string,
  now: Date,
): Promise<'generated' | 'not-needed' | 'no-hostname'> {
  if (await exists(join(root, LIVE_LINK))) return 'not-needed';
  if (!HOSTNAME.test(hostname)) return 'no-hostname';

  const setName = `selfsigned-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
  const setPath = join(root, SETS_DIR, setName);
  await mkdir(setPath, { recursive: true, mode: 0o700 });

  const certPath = join(setPath, CERT_FILE);
  const keyPath = join(setPath, KEY_FILE);

  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    String(VALID_DAYS),
    '-subj',
    `/CN=${hostname}/O=${TEMPORARY_MARKER}`,
    // The SAN is what a browser actually matches. A certificate with the name
    // only in the CN is rejected outright by every current browser, so omitting
    // this would produce a file that exists and still does not work.
    '-addext',
    `subjectAltName=DNS:${hostname}`,
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);

  // Same modes the documented manual install uses (ADR-0013 §5): the
  // certificate is public and read by whatever uid the api runs as; the key is
  // read by the proxy alone.
  await chmod(certPath, 0o444);
  await chmod(keyPath, 0o400);

  await swapLive(root, join(SETS_DIR, setName));
  return 'generated';
}
