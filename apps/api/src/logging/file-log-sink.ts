import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { SUPPORT_BUNDLE_MAX_HOURS } from '@nexuspuppet/contracts';
import { logFileName, parseLogFileName, safeHost } from './pure/log-record';

/**
 * The API's bounded local log history (ADR-0028).
 *
 * STDOUT IS STILL THE LOG. This is a second, bounded copy that exists so the
 * support bundle can include the last day of the API's own output without the
 * API being handed the Docker socket to read `docker logs` (ADR-0013 §1 says
 * why that trade is never worth it). Shipping logs anywhere remains the
 * runtime's job (ADR-0016).
 *
 * SYNCHRONOUS WRITES, deliberately:
 *
 *   - Stdout is already synchronous. In a container it is a pipe, and Node
 *     writes pipes synchronously on Linux — so every log line already costs one
 *     blocking write(2). This adds a second one of the same size to a local
 *     file, which is the same order of cost, not a new kind of cost.
 *   - A buffered writer loses its buffer when the process dies, and the lines
 *     just before a crash are the ones a support bundle exists to carry.
 *   - It is SMALL: one line, one write, no allocation beyond the line itself.
 *     The only multi-step operation is rotation, a handful of renames once
 *     every LOG_FILE_MAX_BYTES.
 *
 * The risk that buys is a slow disk stalling the event loop. The directory is a
 * local named volume, not a network mount; an operator who points LOG_DIR at
 * NFS takes that on, and LOG_FILE_MAX_BYTES=0 switches the copy off.
 *
 * NEVER THROWS. Any failure — a missing directory, a full disk, a permission
 * change — disables the sink, says so ONCE on stderr, and is reported in the
 * next support bundle's manifest. A logging side-channel that could take the
 * API down would be worse than not having one.
 */

export type LogSinkState =
  | { enabled: true; directory: string; file: string; maxBytes: number; keep: number }
  | { enabled: false; directory: string; reason: string };

export interface LogSinkOptions {
  directory: string;
  host: string;
  /** 0 disables the sink by configuration. */
  maxBytes: number;
  /** Rotated generations kept beside the live file. */
  keep: number;
  /** Where the one-time "disabled" notice goes. Injected for tests. */
  stderr?: (message: string) => void;
  /** Injected for tests; the real one is Date.now. */
  now?: () => number;
}

/**
 * How long another replica's file may go unwritten before it is removed.
 *
 * A container's hostname is its id, so every redeploy starts a NEW file and the
 * old container's set is never rotated again. Without pruning, a volume that
 * outlives many redeploys grows by up to MAX_BYTES × (KEEP + 1) each time.
 *
 * A file nobody has written for longer than the widest export window contains
 * nothing any bundle can include, so it is safe to delete. The day of margin
 * covers clock skew between hosts sharing the directory.
 */
export const STALE_FOREIGN_FILE_MS = (SUPPORT_BUNDLE_MAX_HOURS + 24) * 3_600_000;

/**
 * How often to check that the file we hold open is still the one at the path.
 *
 * Another replica's pruning, an operator's `rm`, or logrotate can unlink it;
 * writes would then vanish into an inode nobody can reach. Checked on write,
 * at most this often, so an idle API costs nothing.
 */
const REOPEN_CHECK_MS = 60_000;

export class FileLogSink {
  private fd: number | null = null;
  private size = 0;
  private inode = 0;
  private lastCheck = 0;
  private disabledReason: string | null = null;
  private readonly path: string;
  private readonly stderr: (message: string) => void;
  private readonly now: () => number;

  private constructor(private readonly options: LogSinkOptions) {
    this.path = join(options.directory, logFileName(options.host));
    this.stderr = options.stderr ?? ((message) => process.stderr.write(`${message}\n`));
    this.now = options.now ?? Date.now;
  }

  /** Open the sink. Never throws; a failure produces a disabled sink. */
  static open(options: LogSinkOptions): FileLogSink {
    const sink = new FileLogSink(options);

    if (options.maxBytes <= 0) {
      // Configuration, not a fault — so no stderr notice.
      sink.disabledReason = 'disabled by configuration (LOG_FILE_MAX_BYTES=0)';
      return sink;
    }

    try {
      sink.openFile();
    } catch (error) {
      sink.disable(error);
      return sink;
    }

    sink.pruneStaleForeignFiles();
    return sink;
  }

  /** A sink that was never opened — for tests, and for a module built without main.ts. */
  static disabled(directory: string, reason: string): FileLogSink {
    const sink = new FileLogSink({ directory, host: 'none', maxBytes: 0, keep: 0 });
    sink.disabledReason = reason;
    return sink;
  }

  state(): LogSinkState {
    if (this.disabledReason !== null || this.fd === null) {
      return {
        enabled: false,
        directory: this.options.directory,
        reason: this.disabledReason ?? 'not open',
      };
    }
    return {
      enabled: true,
      directory: this.options.directory,
      file: logFileName(this.options.host),
      maxBytes: this.options.maxBytes,
      keep: this.options.keep,
    };
  }

  get host(): string {
    return safeHost(this.options.host);
  }

  /** Append one line. The caller supplies no newline. */
  write(line: string): void {
    if (this.fd === null) return;

    try {
      const bytes = Buffer.from(`${line}\n`, 'utf8');

      this.reopenIfReplaced();
      if (this.size > 0 && this.size + bytes.length > this.options.maxBytes) this.rotate();

      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
      }
      this.size += bytes.length;
    } catch (error) {
      this.disable(error);
    }
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Closing is best effort; the process is going away.
    }
    this.fd = null;
  }

  private openFile(): void {
    // 0640: the log may name hosts and paths. Nobody but the service and its
    // group has a reason to read it.
    this.fd = openSync(this.path, 'a', 0o640);
    const stat = fstatSync(this.fd);
    this.size = stat.size;
    this.inode = stat.ino;
    this.lastCheck = this.now();
  }

  /**
   * api.log.(keep-1) → api.log.keep, …, api.log → api.log.1, then a fresh file.
   *
   * The oldest generation is overwritten by the rename rather than deleted
   * first, so there is no moment with fewer files than the bound allows.
   */
  private rotate(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;

    if (this.options.keep === 0) {
      unlinkIfPresent(this.path);
    } else {
      for (let generation = this.options.keep - 1; generation >= 1; generation--) {
        renameIfPresent(
          `${this.path}.${String(generation)}`,
          `${this.path}.${String(generation + 1)}`,
        );
      }
      renameIfPresent(this.path, `${this.path}.1`);
    }

    this.openFile();
  }

  private reopenIfReplaced(): void {
    const now = this.now();
    if (now - this.lastCheck < REOPEN_CHECK_MS) return;
    this.lastCheck = now;

    let current: number | null;
    try {
      current = statSync(this.path).ino;
    } catch {
      current = null;
    }
    if (current === this.inode) return;

    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.openFile();
  }

  /**
   * Remove other replicas' files that nobody has written for longer than any
   * export could reach. Never this replica's own; never anything that does not
   * look like ours. Best effort: a failure here costs disk, not correctness.
   */
  private pruneStaleForeignFiles(): void {
    const own = safeHost(this.options.host);
    let names: string[];
    try {
      names = readdirSync(this.options.directory);
    } catch {
      return;
    }

    const cutoff = this.now() - STALE_FOREIGN_FILE_MS;
    for (const name of names) {
      const parsed = parseLogFileName(name);
      if (parsed === null || parsed.host === own) continue;
      const path = join(this.options.directory, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // Another replica may be pruning the same file. Either way it is gone.
      }
    }
  }

  private disable(error: unknown): void {
    const reason = describe(error);
    const first = this.disabledReason === null;
    this.disabledReason = reason;
    this.close();

    if (first) {
      // stderr, not the logger: this runs INSIDE the logger, and logging a
      // failure to log would recurse. Said once — a message per line would
      // bury the output it is trying to protect.
      this.stderr(
        `[nexuspuppet] The local log copy in ${this.options.directory} is disabled: ${reason}. ` +
          'Logging to stdout is unaffected; support bundles will not include API logs until ' +
          'the directory is writable and the API restarts. See DEPLOYMENT.md, "Support bundles".',
      );
    }
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}
