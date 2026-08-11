import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { assertSafeCertname, EncPathError } from './posix-enc-storage';

/**
 * Reads back the ENC document a node will actually be served (#143).
 *
 * SEPARATE FROM THE WRITER, deliberately. `IEncFileWriter` is a published
 * capability seam that the enterprise layer may implement (ADR-0002), so
 * adding a required method to it would break any implementation that already
 * exists. Reading needs none of the writer's guarantees — no atomicity, no
 * fsync, no change detection — so it does not belong on that interface.
 *
 * READS THE FILE, never re-renders it. Re-rendering would answer "what would
 * we write now", which is a different and quieter question: it would silently
 * paper over a file that failed to write, was edited by hand, or belongs to a
 * classification that has since changed. What an operator needs to see is the
 * bytes `nexuspuppet-enc.sh` will `cat`.
 */
@Injectable()
export class EncDocumentReader {
  private readonly logger = new Logger(EncDocumentReader.name);
  private readonly nodesDir: string;
  private readonly defaultFile: string;

  private readonly revisionFile: string;

  constructor(outputDir: string) {
    this.nodesDir = join(outputDir, 'nodes');
    this.defaultFile = join(outputDir, 'default.yaml');
    this.revisionFile = join(outputDir, '.revision');
  }

  /**
   * The revision the tree on disk is currently carrying (ADR-0022 §2).
   *
   * READ FROM `.revision`, not recomputed. That file is what the ENC script
   * actually reads and what it stamps on every receipt, so comparing a receipt
   * against it is comparing like with like. Recomputing the tree hash here
   * would answer "what would the identity be now", which is a different
   * question and re-reads every file in the estate on a page view.
   *
   * Null when the tree has never been stamped — a deployment older than the
   * stamp, or one whose materializer has not run. Not an error: it means the
   * comparison cannot be made, which the console must say rather than guess.
   */
  async readRevision(): Promise<string | null> {
    const raw = await this.readIfPresent(this.revisionFile);
    const trimmed = raw?.trim();
    return trimmed === undefined || trimmed === '' ? null : trimmed;
  }

  /**
   * The YAML on disk for this node, or null when it has none.
   *
   * Null means the node receives `default.yaml` — which is a valid
   * classification, not an error (ADR-0003). The caller decides how to say so.
   */
  async readNode(certname: string): Promise<string | null> {
    // The same guard the writer uses. A certname reaches here from a URL, so
    // it is untrusted input being turned into a filesystem path — rejected
    // outright rather than sanitised, because a "cleaned" certname would read
    // the wrong node's classification.
    try {
      assertSafeCertname(certname);
    } catch (error: unknown) {
      if (error instanceof EncPathError) return null;
      throw error;
    }

    return this.readIfPresent(join(this.nodesDir, `${certname}.yaml`));
  }

  /** The fallback every unmatched node receives. */
  async readDefault(): Promise<string | null> {
    return this.readIfPresent(this.defaultFile);
  }

  private async readIfPresent(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      /*
       * A permission error is NOT absence, and must not be reported as "this
       * node has no classification". The console would then show an empty
       * document for a node that has a perfectly good one on disk.
       */
      this.logger.warn(`Could not read ${path}: ${describe(error)}`);
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
