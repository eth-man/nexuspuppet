import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService, ADVISORY_LOCKS } from '../prisma/prisma.service';
import type { IEncFileWriter } from '@nexuspuppet/contracts';
import { MaterializerService } from './materializer.service';

/**
 * Drives the materializer and repairs drift (ADR-0003).
 *
 * Two loops:
 *
 *   drain      — fast, frequent. Turns queued classification changes into
 *                files. This is the latency an operator feels after saving.
 *   reconcile  — slow, periodic. Recomputes everything and deletes orphaned
 *                files, so the ENC tree is self-healing.
 *
 * The reconcile loop is not belt-and-braces. Two things genuinely require it:
 *
 *   1. ORPHANS. Delete a node group and a node may stop matching anything — but
 *      its YAML file remains on disk, and puppetserver keeps reading it. Puppet
 *      would go on applying a classification the database no longer describes,
 *      indefinitely, with nothing in the UI to suggest it. Only a sweep that
 *      compares disk against the database can find that.
 *
 *   2. STALE FACTS. Rule matching runs against the ManagedNode projection. When
 *      the projector refreshes facts, a node's group membership can change with
 *      no classification edit to trigger a job. Without a sweep the node keeps
 *      its old classification until someone happens to edit something.
 *
 * Timers rather than @nestjs/schedule decorators: intervals come from
 * configuration, and decorator arguments are fixed at class-definition time.
 */
@Injectable()
export class ReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcilerService.name);

  private drainTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly materializer: MaterializerService,
    private readonly writer: IEncFileWriter,
    private readonly drainIntervalMs: number,
    private readonly reconcileIntervalMs: number,
    /**
     * The identity of the tree as it now stands on disk (ADR-0022 §2).
     *
     * A callback rather than the replication service itself: the reconciler
     * has no business knowing that replication exists, and a co-located
     * deployment with `ENC_REPLICATION_ENABLED=false` still needs this. What
     * matters is that both callers compute it the SAME way — see
     * `writeRevision` on IEncFileWriter.
     */
    private readonly treeRevision: () => Promise<string>,
  ) {}

  async onModuleInit(): Promise<void> {
    // default.yaml must exist before puppetserver asks for an unknown node,
    // otherwise the ENC script exits non-zero and catalog compilation fails.
    await this.materializer.ensureDefaultDocument();

    // A restart may have missed changes, and the file tree may have been
    // restored from a backup or wiped. Start from a known-good state.
    await this.reconcile('startup');

    // Unconditionally at boot, not only when something changed: a tree written
    // by a version that predates this, or restored from a backup, is on disk
    // and anonymous. Nothing else would ever name it, because nothing about it
    // is going to change.
    await this.stampRevision('startup');

    this.drainTimer = setInterval(() => {
      void this.tick();
    }, this.drainIntervalMs);

    this.reconcileTimer = setInterval(() => {
      void this.reconcile('scheduled');
    }, this.reconcileIntervalMs);

    // Do not hold the process open purely for these timers.
    this.drainTimer.unref();
    this.reconcileTimer.unref();

    this.logger.log(
      `Materializer running (drain every ${this.drainIntervalMs}ms, reconcile every ${this.reconcileIntervalMs}ms).`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
  }

  /**
   * One drain pass, guarded against overlap.
   *
   * `running` prevents a slow tick from being re-entered by the next timer
   * firing in the same process. The advisory lock inside drain() handles the
   * separate question of other replicas.
   */
  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;

    try {
      const result = await this.materializer.drain();
      if (result.failed > 0) {
        this.logger.warn(`${result.failed} materialization job(s) failed this tick.`);
      }
      // Only when the tree actually moved. Recomputing the identity means
      // reading every file in it, so doing it on every idle tick would turn a
      // 2-second no-op into a full tree read forever.
      if (result.filesChanged > 0) await this.stampRevision('drain');
    } catch (error) {
      // A thrown drain must never kill the timer; the next tick retries.
      this.logger.error(
        `Materializer tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Queue a full recomputation and remove orphaned files.
   *
   * @returns the number of orphaned files removed.
   */
  async reconcile(reason: string): Promise<number> {
    const removed = await this.prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_RECONCILER, async () => {
      await this.prisma.$transaction(async (tx) => {
        await tx.encMaterializationJob.upsert({
          where: { dedupeKey: 'full-reconcile' },
          create: { dedupeKey: 'full-reconcile', certname: null, reason: `reconcile:${reason}` },
          update: { status: 'PENDING', nextAttemptAt: new Date(), reason: `reconcile:${reason}` },
        });
      });

      return this.removeOrphans();
    });

    if (removed !== null && removed > 0) {
      this.logger.log(`Reconcile (${reason}) removed ${removed} orphaned ENC file(s).`);
      // A deletion changes the tree exactly as much as a write does.
      await this.stampRevision(`reconcile:${reason}`);
    }

    return removed ?? 0;
  }

  /**
   * Record what the tree on disk now is, for compile receipts (ADR-0022 §2).
   *
   * WRITTEN AFTER THE TREE SETTLES, deliberately. The replication puller can
   * name a tree before publishing it, because it swaps a whole directory into
   * place atomically. A local materializer updates files in place, so there is
   * no instant at which the tree atomically becomes revision R — and between
   * the first node write and this stamp, a compile sees new content under the
   * previous revision.
   *
   * Stamping afterwards makes that window under-claim: a receipt in it names
   * the older revision, so the node looks behind when it is in fact current.
   * Stamping first would invert it — nodes would claim a revision they had not
   * yet received, and "current" would be a lie rather than a lag. Between a
   * false negative and a false positive on "did this node get my change", only
   * one of them is safe.
   *
   * Never throws. Receipts are droppable by design (ADR-0022 §5); classification
   * delivery is not, and a tree that materialized correctly must not be treated
   * as failed because it could not be named.
   */
  private async stampRevision(reason: string): Promise<void> {
    try {
      await this.writer.writeRevision(await this.treeRevision());
    } catch (error) {
      this.logger.warn(
        `Could not stamp the ENC tree revision after ${reason}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Classification is unaffected; compile receipts for this revision will be dropped.',
      );
    }
  }

  /**
   * Delete ENC files for nodes the database no longer knows about.
   *
   * Without this, deleting a node group or a node leaves a file that
   * puppetserver keeps honouring — the estate stays configured by a rule that
   * no longer exists anywhere in the system.
   */
  private async removeOrphans(): Promise<number> {
    const onDisk = await this.writer.listMaterializedCertnames();
    if (onDisk.length === 0) return 0;

    const known = await this.prisma.managedNode.findMany({ select: { certname: true } });
    const knownSet = new Set(known.map((n) => n.certname));

    let removed = 0;
    for (const certname of onDisk) {
      if (knownSet.has(certname)) continue;

      try {
        // Validation belongs to the storage implementation, not here: what is
        // dangerous depends on the medium. `..` traverses a filesystem; an
        // object store cares about key shape instead. removeNode rejects an
        // unsafe identifier itself, and the catch below turns that into a
        // skipped file rather than a failed sweep.
        await this.writer.removeNode(certname);
        await this.prisma.encMaterialization.delete({ where: { certname } }).catch(() => undefined);
        removed += 1;
      } catch (error) {
        this.logger.warn(
          `Could not remove orphaned ENC file for "${certname}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return removed;
  }
}
