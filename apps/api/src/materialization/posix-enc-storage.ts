import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { IEncFileWriter } from '@nexuspuppet/contracts';

/**
 * The only component permitted to touch the ENC output directory (ADR-0003).
 *
 * Every write is atomic: render to a temporary file in the SAME directory,
 * fsync it, then rename() over the target. POSIX guarantees rename atomicity
 * within a filesystem, so puppetserver can never observe a partially written
 * document — it sees either the old classification or the new one, never a
 * truncated file that would fail catalog compilation across the estate.
 *
 * The temp file must share a directory with the target. A rename across
 * filesystems is not atomic and would silently degrade to copy-then-delete.
 */

export class EncPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncPathError';
  }
}

export class EncWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EncWriteError';
  }
}

/**
 * A certname originates from an agent's certificate, but here it becomes a
 * filesystem path — so it is treated as untrusted input. Anything that could
 * escape the nodes directory is rejected outright rather than sanitised, since
 * a "cleaned" certname would silently classify the wrong node.
 */
const SAFE_CERTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$/;

export function assertSafeCertname(certname: string): void {
  if (!SAFE_CERTNAME.test(certname) || certname.includes('..')) {
    throw new EncPathError(`Refusing to build a filesystem path from certname "${certname}".`);
  }
}

@Injectable()
export class PosixEncStorage implements IEncFileWriter {
  private readonly logger = new Logger(PosixEncStorage.name);
  private readonly nodesDir: string;
  private readonly defaultFile: string;

  /** Absolute ENC output root, for diagnostics and health reporting. */
  readonly root: string;

  constructor(outputDir: string) {
    this.root = resolve(outputDir);
    this.nodesDir = join(this.root, 'nodes');
    this.defaultFile = join(this.root, 'default.yaml');
  }

  /** Create the directory tree. Safe to call repeatedly. */
  async ensureLayout(): Promise<void> {
    await mkdir(this.nodesDir, { recursive: true });
  }

  /**
   * @returns true if the file changed on disk, false if the content hash
   *          already matched and the write was skipped.
   */
  async writeNode(certname: string, yaml: string, contentHash: string): Promise<boolean> {
    assertSafeCertname(certname);
    const target = this.nodeFile(certname);

    if (await this.matchesOnDisk(target, contentHash)) {
      return false;
    }

    await this.atomicWrite(target, yaml);
    this.logger.debug(`Materialized ${certname}`);
    return true;
  }

  async removeNode(certname: string): Promise<void> {
    assertSafeCertname(certname);
    // An orphaned file would keep classifying a node forever, so a missing
    // file is success, not an error.
    await rm(this.nodeFile(certname), { force: true });

    // An unlink is not durable until the PARENT DIRECTORY is synced. Without
    // this a crash can resurrect the file, and a resurrected file classifies a
    // node that no longer exists — indefinitely, because nothing will queue
    // another delete for it. The write path already fsyncs for the mirror-image
    // reason; deletion deserves the same care.
    await this.syncDirectory(dirname(this.nodeFile(certname)));
  }

  /**
   * Flush a directory's own metadata, making a create or unlink within it
   * durable.
   *
   * Best-effort: some filesystems reject opening a directory for this, and
   * failing a delete because the sync could not be issued would be worse than
   * the small durability window it closes.
   */
  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.logger.debug(
        `Could not fsync ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async writeDefault(yaml: string): Promise<void> {
    await this.atomicWrite(this.defaultFile, yaml);
  }

  /** Certnames currently on disk. Used by the reconciler to find orphans. */
  async listMaterializedCertnames(): Promise<string[]> {
    try {
      const entries = await readdir(this.nodesDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
        .map((e) => e.name.slice(0, -'.yaml'.length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Whether the ENC volume is writable. Surfaced on the health endpoint: a
   * silently unwritable volume means classification changes stop reaching
   * Puppet while the UI happily reports success.
   */
  async isWritable(): Promise<boolean> {
    try {
      await access(this.nodesDir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private nodeFile(certname: string): string {
    const path = join(this.nodesDir, `${certname}.yaml`);
    // Defence in depth: even with a validated certname, never write outside
    // the nodes directory.
    if (!path.startsWith(this.nodesDir + sep)) {
      throw new EncPathError(`Resolved path escapes the ENC directory: ${path}`);
    }
    return path;
  }

  private async matchesOnDisk(target: string, contentHash: string): Promise<boolean> {
    try {
      const existing = await readFile(target, 'utf8');
      return createHash('sha256').update(existing, 'utf8').digest('hex') === contentHash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Write + fsync a temp file in the target's own directory, then rename.
   *
   * The fsync matters: without it a crash between rename and flush can leave a
   * correctly-named file with zero-length contents, which is worse than the old
   * classification because it looks valid.
   */
  private async atomicWrite(target: string, contents: string): Promise<void> {
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });

    // Same directory, therefore same filesystem, therefore rename is atomic.
    const tmp = join(dir, `.${randomUUID()}.tmp`);

    try {
      await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o644 });

      const handle = await open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new EncWriteError(
        `Failed to write ${target}: ${(error as Error).message}. ` +
          'Classification is unchanged on disk; Puppet runs continue against the previous state.',
        { cause: error },
      );
    }
  }
}
