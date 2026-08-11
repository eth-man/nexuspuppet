import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Receives compile receipts and records, per node, the revision it was last
 * served (ADR-0022 §7–§12).
 *
 * The peer certname arrives from the caller's VERIFIED client certificate and
 * is passed in — never parsed from the body. A puller may report for itself and
 * nothing else (binding constraint 1), and this class is given no way to learn
 * an identity any other way.
 */

/** `<revision> <certname>`; a hex tree revision and a certname. */
const RECEIPT_LINE = /^([0-9a-f]{1,64}) (\S{1,255})$/;

/**
 * The most receipts one batch may contribute.
 *
 * Matches the puller's own default cap, so a correctly-behaving puller is never
 * truncated. See `truncate` for why exceeding it is not an error.
 */
export const MAX_RECEIPTS_PER_BATCH = 20_000;

export interface IngestResult {
  /** Rows written — distinct nodes, not lines received. */
  stored: number;
  /** Lines dropped for being unparseable. */
  malformed: number;
  /** Lines dropped for being over the cap, oldest first. */
  discarded: number;
}

@Injectable()
export class CompileReceiptsService {
  private readonly logger = new Logger(CompileReceiptsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a batch from one Puppet server.
   *
   * @param peerCertname from the verified client certificate, never the body.
   */
  async ingest(peerCertname: string, body: string): Promise<IngestResult> {
    const { lines, malformed } = parse(body);
    const { kept, discarded } = truncate(lines);

    // Last occurrence wins (§7). The file is built by append, and a failed
    // upload is merged oldest-first, so position IS compile order. Revisions
    // are content hashes and carry no order of their own, so there is nothing
    // else to sort by — which is exactly why the cap drops from the front.
    const latest = new Map<string, string>();
    for (const { certname, revision } of kept) latest.set(certname, revision);

    const stored = await this.store(peerCertname, latest);

    if (discarded > 0) {
      // Never silent. A 2xx that quietly dropped input would read as "all
      // received" (§10), which is the one thing this must not imply.
      this.logger.warn(
        `Peer ${JSON.stringify(peerCertname)}: discarded ${String(discarded)} compile receipt(s) ` +
          `over the ${String(MAX_RECEIPTS_PER_BATCH)} cap, oldest first.`,
      );
    }
    if (malformed > 0) {
      this.logger.warn(
        `Peer ${JSON.stringify(peerCertname)}: ignored ${String(malformed)} malformed receipt line(s).`,
      );
    }

    return { stored, malformed, discarded };
  }

  /**
   * Upsert one row per node.
   *
   * Idempotent by construction: the key is (peer, node) and the write is an
   * upsert, so a puller that uploads and then fails before discarding replays
   * the same batch to the same end state (§4). Nothing accumulates and nothing
   * double-counts.
   */
  private async store(peerCertname: string, latest: Map<string, string>): Promise<number> {
    if (latest.size === 0) return 0;

    const certnames = [...latest.keys()];

    // One query rather than one per node: a batch after an outage can name
    // thousands, and this decides only a boolean per row.
    const known = new Set(
      (
        await this.prisma.managedNode.findMany({
          where: { certname: { in: certnames } },
          select: { certname: true },
        })
      ).map((n) => n.certname),
    );

    const reportedAt = new Date();

    await this.prisma.$transaction(
      certnames.map((certname) => {
        const revision = latest.get(certname) ?? '';
        const matchedAtIngest = known.has(certname);
        return this.prisma.compileReceipt.upsert({
          where: { peerCertname_certname: { peerCertname, certname } },
          create: { peerCertname, certname, revision, reportedAt, matchedAtIngest },
          // matchedAtIngest is refreshed rather than left as first seen: a node
          // that has since been projected stops being a finding, and one that
          // has been removed becomes debris the sweep may collect (§11).
          update: { revision, reportedAt, matchedAtIngest },
        });
      }),
    );

    return certnames.length;
  }

  /** Every receipt for a node, newest report first. */
  async forNode(certname: string): Promise<
    Array<{
      peerCertname: string;
      revision: string;
      reportedAt: Date;
    }>
  > {
    return this.prisma.compileReceipt.findMany({
      where: { certname },
      select: { peerCertname: true, revision: true, reportedAt: true },
      orderBy: { reportedAt: 'desc' },
    });
  }

  /**
   * Delete receipts for nodes that once existed and no longer do (§11).
   *
   * ONLY `matchedAtIngest` rows. A receipt that never matched is evidence about
   * a node the projection has not caught up with — the node somebody is most
   * likely to be debugging — and sweeping it would destroy exactly what the
   * missing foreign key exists to preserve.
   */
  async sweepOrphans(knownCertnames: Set<string>): Promise<number> {
    const candidates = await this.prisma.compileReceipt.findMany({
      where: { matchedAtIngest: true },
      select: { peerCertname: true, certname: true },
    });

    const orphaned = candidates.filter((r) => !knownCertnames.has(r.certname));
    if (orphaned.length === 0) return 0;

    const { count } = await this.prisma.compileReceipt.deleteMany({
      where: { OR: orphaned.map((r) => ({ peerCertname: r.peerCertname, certname: r.certname })) },
    });

    return count;
  }
}

interface ReceiptLine {
  revision: string;
  certname: string;
}

/**
 * Parse the body, dropping bad lines individually.
 *
 * A malformed line never fails the batch: the file is appended to by a shell
 * loop on a machine we do not control, and one truncated write must not cost
 * every other node's receipt.
 */
function parse(body: string): { lines: ReceiptLine[]; malformed: number } {
  const lines: ReceiptLine[] = [];
  let malformed = 0;

  for (const raw of body.split('\n')) {
    if (raw === '') continue;
    const match = RECEIPT_LINE.exec(raw);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      malformed += 1;
      continue;
    }
    lines.push({ revision: match[1], certname: match[2] });
  }

  return { lines, malformed };
}

/**
 * Keep the newest, drop the oldest (§5, §10).
 *
 * NOT an error. The shipped puller treats anything outside 2xx/404/405/501 as
 * retryable and re-uploads the identical body forever, so refusing an oversized
 * batch — which is what HTTP semantics ask for — wedges that peer permanently
 * and silently. Truncating applies the rule the puller itself uses at rotation,
 * and the caller logs what was lost.
 */
function truncate(lines: ReceiptLine[]): { kept: ReceiptLine[]; discarded: number } {
  if (lines.length <= MAX_RECEIPTS_PER_BATCH) return { kept: lines, discarded: 0 };

  return {
    kept: lines.slice(lines.length - MAX_RECEIPTS_PER_BATCH),
    discarded: lines.length - MAX_RECEIPTS_PER_BATCH,
  };
}
