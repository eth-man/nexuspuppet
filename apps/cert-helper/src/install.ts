import { X509Certificate } from 'node:crypto';
import {
  open,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { type BundleIdentity, type BundleRejection, checkBundle } from './pure/bundle';

/** File names inside a set. Caddy is pointed at these through `live`. */
export const CERT_FILE = 'console.pem';
export const KEY_FILE = 'console.key';

/** The symlink Caddy reads through. Swapping it is the atomic step. */
export const LIVE_LINK = 'live';
export const SETS_DIR = 'sets';

/**
 * Previous sets kept for manual recovery.
 *
 * Three, not one: the failure that needs a human is "the last two installs were
 * both wrong", and a single spare means the good one has already been deleted
 * by the time anybody looks.
 */
const KEEP_SETS = 3;

export interface ProxyPorts {
  /** Make the proxy re-read its certificate files. */
  reload(): Promise<void>;
  /**
   * SHA-256 fingerprint of the certificate the listener is ACTUALLY serving.
   *
   * Not what was written to disk — what a client gets. Those differ whenever a
   * reload silently fails, which is the case this whole design exists to catch.
   */
  servedFingerprint(): Promise<string>;
  now(): Date;
}

export type InstallOutcome =
  /**
   * Swapped, reloaded, and the proxy is serving it. NOT yet committed — the
   * caller marks it pending and waits for a client to confirm (ADR-0017). The
   * staging details are carried out so the confirmation layer can roll back to
   * exactly what was replaced.
   */
  | {
      status: 'installed';
      identity: BundleIdentity;
      setName: string;
      previousTarget: string | null;
      previousFingerprint: string | null;
    }
  | { status: 'rejected'; rejection: BundleRejection }
  /** The new material did not take. The previous certificate is serving again. */
  | { status: 'rolled-back'; reason: string }
  /**
   * The new material did not take AND the old one could not be restored.
   *
   * The console is likely unreachable. This is the outcome that has to be
   * distinguishable, because it is the only one where the answer is "go to the
   * host", and an operator who cannot load the page needs to have been told
   * that before they lost it.
   */
  | { status: 'rollback-failed'; reason: string; detail: string };

/**
 * Install a certificate, and prove it before keeping it (ADR-0017).
 *
 * THE ORDER IS THE DESIGN. The operator doing this is using the thing they are
 * changing, so a write that is merely "successful" is not enough — a mismatched
 * pair, a proxy that failed to reload, a chain the proxy rejects, all write
 * cleanly and fail at the next handshake. So: stage, swap, reload, then ask the
 * listener what it is actually serving and compare. Only then is it kept.
 *
 * ATOMICITY VIA SYMLINK. The certificate and key must change together. Two
 * renames are two moments, and a crash between them leaves a mismatched pair —
 * the exact state that makes the console unreachable. Both files are written
 * into a new directory and a single symlink rename swaps them as a unit.
 */
export async function installBundle(
  root: string,
  certPem: string,
  keyPem: string,
  ports: ProxyPorts,
): Promise<InstallOutcome> {
  const now = ports.now();
  const check = checkBundle(certPem, keyPem, now);
  if (!check.ok) return { status: 'rejected', rejection: check.rejection };

  const previous = await currentTarget(root);
  const previousFingerprint = previous === null ? null : await fingerprintOf(root, previous);

  const setName = `${stamp(now)}-${check.identity.fingerprint.slice(0, 5).replace(/:/g, '')}`;
  const setPath = join(root, SETS_DIR, setName);
  await mkdir(setPath, { recursive: true, mode: 0o700 });

  // The key is 0600 and written before the swap. It is never world-readable,
  // not even for the instant between write and chmod, because the mode is set
  // at open() rather than after.
  await writeFile(join(setPath, CERT_FILE), certPem, { mode: 0o644 });
  await writeFile(join(setPath, KEY_FILE), keyPem, { mode: 0o600 });
  await fsyncDir(setPath);

  try {
    await swapLive(root, join(SETS_DIR, setName));
  } catch (error) {
    // The swap is the first moment anything the proxy reads changes. Failing
    // here means nothing changed, so there is nothing to roll back — but it
    // must still be reported, not thrown, or the caller cannot tell it apart
    // from a failure that did change something.
    return {
      status: 'rolled-back',
      reason:
        `The new material could not be put in place (${describe(error)}). The previous ` +
        'certificate is unchanged and still serving.',
    };
  }

  try {
    await ports.reload();
    const served = await ports.servedFingerprint();

    if (normalise(served) !== normalise(check.identity.fingerprint)) {
      // The proxy reloaded and is serving something else. Usually a chain it
      // would not accept, or a reload that reported success and did nothing.
      return await rollback(
        root,
        previous,
        previousFingerprint,
        ports,
        'The proxy reloaded but is serving a different certificate than the one uploaded.',
      );
    }
  } catch (error) {
    return await rollback(root, previous, previousFingerprint, ports, describe(error));
  }

  // Pruned here rather than on confirmation: prune() keeps both the live set
  // and the one before it, which is precisely what a rollback needs, so there
  // is nothing to gain by deferring it and one more state to reason about.
  await prune(root, setName, previous);

  return {
    status: 'installed',
    identity: check.identity,
    setName,
    previousTarget: previous,
    previousFingerprint,
  };
}

/**
 * Put the previous material back, and prove THAT too.
 *
 * A rollback that is not verified is a guess. If the restore also fails to
 * serve, the operator has to know now — while they can still read the page —
 * rather than discovering it when the console stops answering.
 */
export async function rollback(
  root: string,
  previous: string | null,
  previousFingerprint: string | null,
  ports: ProxyPorts,
  reason: string,
): Promise<InstallOutcome> {
  if (previous === null) {
    // Nothing was serving before this attempt, so there is nothing to restore.
    // Leaving the new material in place is not worse than removing it, and
    // removing it would leave the proxy with no certificate at all.
    return {
      status: 'rollback-failed',
      reason,
      detail:
        'No previous certificate was installed through this helper, so there is nothing to ' +
        'restore. The proxy is still pointed at the uploaded material. Fix it on the host.',
    };
  }

  try {
    await swapLive(root, previous);
    await ports.reload();
    const served = await ports.servedFingerprint();

    if (previousFingerprint !== null && normalise(served) !== normalise(previousFingerprint)) {
      return {
        status: 'rollback-failed',
        reason,
        detail:
          'The previous certificate was restored but the proxy is not serving it. The console ' +
          'is probably unreachable over TLS. Fix it on the host.',
      };
    }

    return { status: 'rolled-back', reason };
  } catch (error) {
    return {
      status: 'rollback-failed',
      reason,
      detail: `Restoring the previous certificate also failed: ${describe(error)}`,
    };
  }
}

/** Atomic: create the link under a temporary name, then rename over the old one. */
export async function swapLive(root: string, target: string): Promise<void> {
  const staging = join(root, `.${LIVE_LINK}.staging`);
  await rm(staging, { force: true });
  await symlink(target, staging);
  await rename(staging, join(root, LIVE_LINK));
  await fsyncDir(root);
}

export async function currentTarget(root: string): Promise<string | null> {
  try {
    return await readlink(join(root, LIVE_LINK));
  } catch {
    return null;
  }
}

export async function fingerprintOf(root: string, target: string): Promise<string | null> {
  try {
    const pem = await readFile(join(root, target, CERT_FILE), 'utf8');
    const first = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
    return first === null ? null : new X509Certificate(first[0]).fingerprint256;
  } catch {
    return null;
  }
}

/** Keep the live set, the one before it, and KEEP_SETS others. */
export async function prune(
  root: string,
  keepName: string,
  previous: string | null,
): Promise<void> {
  const previousName = previous?.split('/').pop() ?? null;
  let names: string[];
  try {
    names = await readdir(join(root, SETS_DIR));
  } catch {
    return;
  }

  const removable = names
    .filter((name) => name !== keepName && name !== previousName)
    .sort()
    .reverse()
    .slice(KEEP_SETS);

  for (const name of removable) {
    await rm(join(root, SETS_DIR, name), { recursive: true, force: true });
  }
}

/**
 * Durability. Without this a power loss can leave the symlink pointing at a
 * directory whose contents never reached the disk, which is the mismatched-pair
 * state the atomic swap exists to prevent.
 */
async function fsyncDir(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Some filesystems refuse to fsync a directory. Durability is a nicety here
    // and an install must not fail because of it.
  } finally {
    await handle?.close();
  }
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** Fingerprints differ by case and separator between sources. Compare content. */
function normalise(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toLowerCase();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
