import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CERT_FILE, KEY_FILE, LIVE_LINK, SETS_DIR, swapLive } from './install';

/**
 * Take ownership of a certificate that was installed before this helper existed.
 *
 * ADR-0013 deployments have `console.pem` and `console.key` sitting directly in
 * the TLS directory, mounted there by hand. This helper serves them through a
 * `live` symlink instead, so the two files can be replaced as a unit — and the
 * Caddyfile that ships with it reads `live/console.pem`.
 *
 * Without this, upgrading would point Caddy at a path that does not exist yet
 * and take the console down at the moment of the upgrade. That is precisely the
 * failure the rest of this component is built to avoid, so it must not be
 * introduced by the component's own arrival.
 *
 * COPIES rather than moves. The originals stay exactly where the operator put
 * them, so rolling back to the previous release — whose Caddyfile reads them
 * directly — still works.
 *
 * Idempotent: a deployment that already has `live` is left alone.
 */
export async function adoptExisting(root: string, now: Date): Promise<'adopted' | 'not-needed'> {
  if (await exists(join(root, LIVE_LINK))) return 'not-needed';

  const legacyCert = join(root, CERT_FILE);
  const legacyKey = join(root, KEY_FILE);
  if (!(await exists(legacyCert)) || !(await exists(legacyKey))) return 'not-needed';

  const setName = `adopted-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
  const setPath = join(root, SETS_DIR, setName);
  await mkdir(setPath, { recursive: true, mode: 0o700 });

  await copyFile(legacyCert, join(setPath, CERT_FILE));
  await copyFile(legacyKey, join(setPath, KEY_FILE));

  await swapLive(root, join(SETS_DIR, setName));
  return 'adopted';
}

/**
 * lstat, not stat.
 *
 * `live` is a symlink, and a DANGLING one must still count as present: it means
 * a previous install pointed somewhere, and silently replacing it here would
 * discard that pointer instead of leaving the broken state visible to whoever
 * has to fix it. stat() follows the link and reports a dangling one as absent.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
