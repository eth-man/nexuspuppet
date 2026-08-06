import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildTar, type TarEntry } from './ustar';

/**
 * Serves the materialized ENC tree to a puppetserver that pulls it (ADR-0019).
 *
 * BINDING CONSTRAINT, from that ADR: this must never compute classification on
 * demand. It reads what the materializer already wrote to disk and nothing
 * else. Computing per request would recreate the synchronous coupling ADR-0003
 * forbids — and it would do so behind an endpoint that already exists and looks
 * harmless, which is exactly how that boundary gets lost.
 *
 * Reading from DISK rather than from EncMaterialization is deliberate. The
 * database says what should be on disk; the disk is what the ENC script will
 * actually read. Serving the database would let a replica converge on a tree
 * the origin does not itself have, and the divergence would be invisible.
 */

export interface EncTree {
  /** SHA-256 of the archive bytes. Serves as the ETag and as the peer revision. */
  etag: string;
  archive: Buffer;
  fileCount: number;
}

@Injectable()
export class EncReplicationService {
  private readonly logger = new Logger(EncReplicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encDir: string,
  ) {}

  /**
   * Read and pack the tree.
   *
   * Entries are sorted by name before packing. `readdir` order is not
   * guaranteed stable across filesystems or even across calls, and an unsorted
   * archive would hash differently each time — turning every poll into a full
   * transfer and an estate-wide rewrite.
   */
  async readTree(): Promise<EncTree> {
    const entries: TarEntry[] = [];

    const defaultYaml = await this.readIfPresent(join(this.encDir, 'default.yaml'));
    if (defaultYaml !== null) entries.push({ name: 'default.yaml', content: defaultYaml });

    const nodesDir = join(this.encDir, 'nodes');
    let names: string[] = [];
    try {
      const dirents = await readdir(nodesDir, { withFileTypes: true });
      names = dirents.filter((d) => d.isFile() && d.name.endsWith('.yaml')).map((d) => d.name);
    } catch (error: unknown) {
      // An absent nodes/ directory is a real state — a deployment that has
      // materialized nothing yet. Serving an empty tree is correct; refusing
      // would make a puller retry forever against a healthy origin.
      if (!isNotFound(error)) throw error;
    }

    for (const name of [...names].sort()) {
      const content = await this.readIfPresent(join(nodesDir, name));
      if (content !== null) entries.push({ name: `nodes/${name}`, content });
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const archive = buildTar(entries);
    return {
      etag: createHash('sha256').update(archive).digest('hex'),
      archive,
      fileCount: entries.length,
    };
  }

  /**
   * Record that a peer fetched, so the console can say whether classification
   * is actually reaching the Puppet server (ADR-0019 §6).
   *
   * `lastChangedAt` advances only on a 200. A peer sitting on 304s is healthy
   * and current; a peer that has never had a 200 has never received anything,
   * and only a separate column can tell those apart.
   */
  async recordFetch(certname: string, etag: string, status: 200 | 304): Promise<void> {
    const now = new Date();
    const changed = status === 200 ? { lastChangedAt: now } : {};

    try {
      await this.prisma.encReplicationPeer.upsert({
        where: { certname },
        create: {
          certname,
          lastFetchAt: now,
          lastEtag: etag,
          lastStatus: status,
          fetchCount: 1,
          ...changed,
        },
        update: {
          lastFetchAt: now,
          lastEtag: etag,
          lastStatus: status,
          fetchCount: { increment: 1 },
          ...changed,
        },
      });
    } catch (error: unknown) {
      /*
       * Bookkeeping must never fail the fetch. If the database is unreachable,
       * the puller should still get its tree: replication working while the
       * console cannot say so is strictly better than a Puppet server drifting
       * because NexusPuppet could not write an audit row.
       *
       * That ordering is the whole point of ADR-0003 applied here.
       */
      this.logger.warn(
        `Served the ENC tree to ${certname} but could not record the fetch: ${describe(error)}`,
      );
    }
  }

  private async readIfPresent(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path);
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
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
