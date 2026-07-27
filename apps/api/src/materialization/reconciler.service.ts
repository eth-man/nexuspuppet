import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService, ADVISORY_LOCKS } from '../prisma/prisma.service';
import { EncFileWriter, assertSafeCertname } from './enc-file-writer';
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
    private readonly writer: EncFileWriter,
    private readonly drainIntervalMs: number,
    private readonly reconcileIntervalMs: number,
  ) {}

  async onModuleInit(): Promise<void> {
    // default.yaml must exist before puppetserver asks for an unknown node,
    // otherwise the ENC script exits non-zero and catalog compilation fails.
    await this.materializer.ensureDefaultDocument();

    // A restart may have missed changes, and the file tree may have been
    // restored from a backup or wiped. Start from a known-good state.
    await this.reconcile('startup');

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
    }

    return removed ?? 0;
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
        // Defensive: a file could have been placed here by hand.
        assertSafeCertname(certname);
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
