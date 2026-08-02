import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleIdentity } from './pure/bundle';
import { type InstallOutcome, type ProxyPorts, installBundle, prune, rollback } from './install';

/**
 * The uncommitted install, on disk.
 *
 * A FILE, not a variable. If the helper dies inside the confirmation window,
 * an in-memory timer dies with it and a certificate nobody confirmed stays
 * installed for good — which is the failure the window exists to prevent,
 * reintroduced by the mechanism meant to prevent it. On start the helper reads
 * this and rolls back anything it finds (ADR-0017).
 */
export const PENDING_FILE = 'pending.json';

/** Default confirmation window. Overridden by TLS_CONFIRM_TIMEOUT_SEC. */
export const DEFAULT_WINDOW_SECONDS = 120;

export interface PendingState {
  setName: string;
  previousTarget: string | null;
  previousFingerprint: string | null;
  /**
   * SHA-256 of the confirmation token, never the token.
   *
   * The token is returned once, to the browser that will present it. Holding
   * only its hash means reading this file does not yield the ability to confirm
   * an install someone else started.
   */
  tokenHash: string;
  expiresAt: string;
  identity: BundleIdentity;
}

export type ConfirmOutcome =
  | { status: 'confirmed'; identity: BundleIdentity }
  /** No install is waiting. Confirming twice lands here, which is harmless. */
  | { status: 'nothing-pending' }
  /** Presented token did not match. The install stays pending; the clock runs on. */
  | { status: 'token-mismatch' }
  /** The window closed. Rolled back, and the outcome says how that went. */
  | { status: 'expired'; rollback: Awaited<ReturnType<typeof rollback>> };

export interface StagedInstall {
  /** Returned once. The browser presents it to commit. */
  token: string;
  expiresAt: string;
}

/**
 * Record an install as awaiting confirmation, and mint its token.
 *
 * Called after the material is swapped, reloaded and passed the internal probe
 * — that probe is a fast pre-check, not the decision. What commits the change
 * is a client reaching `confirm` over the new certificate.
 */
export async function markPending(
  root: string,
  setName: string,
  previousTarget: string | null,
  previousFingerprint: string | null,
  identity: BundleIdentity,
  now: Date,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<StagedInstall> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();

  const state: PendingState = {
    setName,
    previousTarget,
    previousFingerprint,
    tokenHash: hash(token),
    expiresAt,
    identity,
  };

  await writeFile(join(root, PENDING_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
  return { token, expiresAt };
}

export async function readPending(root: string): Promise<PendingState | null> {
  try {
    return JSON.parse(await readFile(join(root, PENDING_FILE), 'utf8')) as PendingState;
  } catch {
    return null;
  }
}

/**
 * Commit, if the caller holds the token and the window is still open.
 *
 * Reaching this at all is the evidence: the request arrived over a TLS
 * connection negotiated against the new certificate, in the client that has to
 * live with it. That is what the internal probe cannot establish.
 */
export async function confirmPending(
  root: string,
  token: string,
  ports: ProxyPorts,
): Promise<ConfirmOutcome> {
  const pending = await readPending(root);
  if (pending === null) return { status: 'nothing-pending' };

  // Expiry is checked before the token. A late caller with the right token is
  // still late, and the rollback must not depend on anyone turning up at all.
  if (ports.now() > new Date(pending.expiresAt)) {
    return { status: 'expired', rollback: await expire(root, pending, ports) };
  }

  if (!matches(token, pending.tokenHash)) return { status: 'token-mismatch' };

  await rm(join(root, PENDING_FILE), { force: true });
  await prune(root, pending.setName, pending.previousTarget);
  return { status: 'confirmed', identity: pending.identity };
}

/**
 * Roll back if the window has closed. Idempotent, and safe to call on a timer,
 * on a request, or both — whichever happens first wins and the second finds
 * nothing pending.
 */
export async function expireIfDue(
  root: string,
  ports: ProxyPorts,
): Promise<Awaited<ReturnType<typeof rollback>> | null> {
  const pending = await readPending(root);
  if (pending === null) return null;
  if (ports.now() <= new Date(pending.expiresAt)) return null;
  return expire(root, pending, ports);
}

/**
 * Undo anything left uncommitted by a previous process.
 *
 * Unconditional — the window is NOT consulted. A pending state surviving a
 * restart means nobody confirmed it before the helper went away, and time
 * inside a crash is not time an operator spent looking at a working console.
 * Waiting out the remainder would keep an unconfirmed certificate serving for
 * longer on the strength of a clock nobody was watching.
 */
export async function recoverOnStart(
  root: string,
  ports: ProxyPorts,
): Promise<Awaited<ReturnType<typeof rollback>> | null> {
  const pending = await readPending(root);
  if (pending === null) return null;
  return expire(root, pending, ports);
}

async function expire(
  root: string,
  pending: PendingState,
  ports: ProxyPorts,
): Promise<Awaited<ReturnType<typeof rollback>>> {
  // Cleared FIRST. If the rollback throws, the next start must not find the
  // same pending row and try again forever; the outcome is reported instead.
  await rm(join(root, PENDING_FILE), { force: true });

  return rollback(
    root,
    pending.previousTarget,
    pending.previousFingerprint,
    ports,
    'The certificate was not confirmed from a browser inside the confirmation window.',
  );
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time, so a wrong token cannot be narrowed by timing it. */
function matches(token: string, expected: string): boolean {
  const a = Buffer.from(hash(token), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type StageOutcome =
  | ({ status: 'pending'; identity: BundleIdentity } & StagedInstall)
  | Exclude<InstallOutcome, { status: 'installed' }>;

/**
 * Install a certificate and wait for a client to vouch for it.
 *
 * The whole flow in one call: validate, swap, reload, probe, then hold the
 * change open. `pending` is not success — it is "serving, and it will be undone
 * unless a browser says otherwise before expiresAt".
 */
export async function stageBundle(
  root: string,
  certPem: string,
  keyPem: string,
  ports: ProxyPorts,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<StageOutcome> {
  // Anything left over from a previous attempt is undone before another is
  // started. Two pending states cannot coexist: the second would overwrite the
  // first's rollback target and strand it.
  await recoverOnStart(root, ports);

  const outcome = await installBundle(root, certPem, keyPem, ports);
  if (outcome.status !== 'installed') return outcome;

  const staged = await markPending(
    root,
    outcome.setName,
    outcome.previousTarget,
    outcome.previousFingerprint,
    outcome.identity,
    ports.now(),
    windowSeconds,
  );

  return { status: 'pending', identity: outcome.identity, ...staged };
}
