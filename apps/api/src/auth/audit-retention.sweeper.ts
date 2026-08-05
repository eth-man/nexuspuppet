import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma';
import { ADVISORY_LOCKS, PrismaService } from '../prisma/prisma.service';

export interface AuditRetentionPolicy {
  /** Records older than this are eligible for age-based sweeping. */
  retentionDays: number;
  /** Hard row ceiling, or null when the operator has not opted in. */
  maxRows: number | null;
  /** How often to look for work. 0 disables the sweeper in this process. */
  intervalMs: number;
  /** Rows deleted per batch. */
  batchSize: number;
  /** Batches per pass — the "stop rather than catch up" budget. */
  maxBatchesPerPass: number;
}

export interface SweepResult {
  /** Rows removed because they aged out (pending deliveries exempt). */
  agedDeleted: number;
  /** Rows removed by the ceiling (pending deliveries NOT exempt). */
  ceilingDeleted: number;
  /** How many of the ceiling's removals still had a pending delivery job. */
  undeliveredDropped: number;
  /** True when the pass stopped on budget with work remaining. */
  exhaustedBudget: boolean;
  /** False when another replica held the lock. */
  ranHere: boolean;
}

/**
 * Where the sweeper records undelivered drops, cumulatively, so
 * `GET /system/status` can report them across restarts (ticket #95 reads this).
 */
export const UNDELIVERED_DROPS_KEY = 'audit.retention.undeliveredDrops';

/** A type alias, not an interface: Prisma's Json input needs the implicit
 * index signature that only object type literals carry. */
export type UndeliveredDrops = {
  total: number;
  lastDroppedAt: string;
};

/**
 * Bounds the audit table by age and, when opted into, by row count
 * (ADR-0016 §6).
 *
 * The rules that matter, in the order they were argued:
 *
 * - **Age-based sweeping skips rows with a pending delivery job**, however
 *   old. A record still queued for a collector must not be swept away because
 *   it aged out while the collector was down — that turns an outage into
 *   silent data loss, the failure the outbox exists to prevent.
 * - **The row ceiling does not skip them**, because something has to bound the
 *   case where a collector is down for a month. It deletes oldest-first and
 *   records how many undelivered rows it dropped — a pending queue growing
 *   past its ceiling is an operational alarm, not a silent condition.
 * - **Deleting must not become the bloat it prevents.** In PostgreSQL a DELETE
 *   writes dead tuples; one enormous delete produces exactly the I/O spike
 *   this table's bound exists to avoid. So: bounded batches, a per-pass
 *   budget that stops rather than catches up, an interval with jitter, and
 *   never inside a request.
 *
 * Each batch takes the advisory lock in its own short transaction — holding
 * one transaction across a whole pass is the vacuum-blocking behaviour the
 * ADR names. Replicas may interleave between batches; deletes are disjoint by
 * id, so that is contention, not corruption.
 */
@Injectable()
export class AuditRetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetentionSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: AuditRetentionPolicy,
  ) {}

  onModuleInit(): void {
    if (this.policy.intervalMs <= 0) return;

    this.logger.log(
      `Audit retention sweeping every ~${this.policy.intervalMs}ms: ` +
        `age ${this.policy.retentionDays}d, ` +
        (this.policy.maxRows === null
          ? 'no row ceiling configured'
          : `row ceiling ${this.policy.maxRows}`) +
        `, up to ${this.policy.maxBatchesPerPass}×${this.policy.batchSize} rows per pass.`,
    );
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * A timeout chain rather than setInterval, because every delay is jittered:
   * ±10% keeps replicas that booted together from sweeping in lockstep.
   */
  private schedule(): void {
    if (this.stopping) return;
    const jittered = this.policy.intervalMs * (0.9 + Math.random() * 0.2);
    this.timer = setTimeout(() => {
      void this.tick();
    }, jittered);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const result = await this.sweep();
      if (result.agedDeleted + result.ceilingDeleted > 0) {
        this.logger.log(
          `Swept ${result.agedDeleted} aged and ${result.ceilingDeleted} over-ceiling ` +
            `audit record(s)` +
            (result.exhaustedBudget ? ' — budget exhausted, more remains for the next pass.' : '.'),
        );
      }
    } catch (error) {
      // A pass must never take the process down; the next one tries again.
      this.logger.error(
        `Audit retention pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  /**
   * One pass: age batches first (they may bring the table under the ceiling
   * for free), then ceiling batches, sharing one budget.
   */
  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = {
      agedDeleted: 0,
      ceilingDeleted: 0,
      undeliveredDropped: 0,
      exhaustedBudget: false,
      ranHere: true,
    };

    const cutoff = new Date(now.getTime() - this.policy.retentionDays * 86_400_000);
    let budget = this.policy.maxBatchesPerPass;

    // A partial batch means the aged backlog is DONE; running out of budget
    // after a full batch means it probably is not. Only the second case may
    // claim the budget was exhausted — a pass that finished the work must not
    // report that more remains.
    let agedDone = false;
    while (budget > 0) {
      const deleted = await this.ageBatch(cutoff);
      if (deleted === null) return { ...result, ranHere: false };
      budget -= 1;
      result.agedDeleted += deleted;
      if (deleted < this.policy.batchSize) {
        agedDone = true;
        break;
      }
    }

    if (!agedDone) {
      result.exhaustedBudget = true;
      return result;
    }

    if (this.policy.maxRows === null) return result;

    if (budget === 0) {
      // Age-sweeping finished exactly on budget, and a ceiling exists that
      // this pass never got to look at. Whether it has work is unknown, so
      // claim the conservative thing: the next pass checks.
      result.exhaustedBudget = true;
      return result;
    }

    while (budget > 0) {
      const batch = await this.ceilingBatch(this.policy.maxRows, now);
      if (batch === null) return { ...result, ranHere: false };
      budget -= 1;
      result.ceilingDeleted += batch.deleted;
      result.undeliveredDropped += batch.undelivered;
      if (batch.deleted < this.policy.batchSize) return result;
    }

    result.exhaustedBudget = true;
    return result;
  }

  /**
   * Delete one batch of records older than the cutoff, skipping any with a
   * pending delivery job. Returns rows deleted, or null when another replica
   * holds the lock.
   */
  private async ageBatch(cutoff: Date): Promise<number | null> {
    return this.prisma.withAdvisoryLock(
      ADVISORY_LOCKS.AUDIT_RETENTION,
      async (tx) => {
        const rows = await tx.auditLog.findMany({
          where: { createdAt: { lt: cutoff }, deliveryJob: { is: null } },
          orderBy: { createdAt: 'asc' },
          take: this.policy.batchSize,
          select: { id: true },
        });
        if (rows.length === 0) return 0;

        const { count } = await tx.auditLog.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        return count;
      },
      { timeoutMs: 30_000 },
    );
  }

  /**
   * Delete one oldest-first batch of the rows above the ceiling — pending
   * deliveries included, counted, and recorded. Returns null when another
   * replica holds the lock.
   */
  private async ceilingBatch(
    maxRows: number,
    now: Date,
  ): Promise<{ deleted: number; undelivered: number } | null> {
    return this.prisma.withAdvisoryLock(
      ADVISORY_LOCKS.AUDIT_RETENTION,
      async (tx) => {
        const total = await tx.auditLog.count();
        if (total <= maxRows) return { deleted: 0, undelivered: 0 };

        const excess = Math.min(total - maxRows, this.policy.batchSize);
        const rows = await tx.auditLog.findMany({
          orderBy: { createdAt: 'asc' },
          take: excess,
          select: { id: true, deliveryJob: { select: { id: true } } },
        });
        if (rows.length === 0) return { deleted: 0, undelivered: 0 };

        const undelivered = rows.filter((row) => row.deliveryJob !== null).length;

        const { count } = await tx.auditLog.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });

        if (undelivered > 0) {
          // Recorded in the SAME transaction as the delete: a drop that
          // happened must not be unreported, nor reported without happening.
          await this.recordDrops(tx, undelivered, now);
          this.logger.warn(
            `Row ceiling dropped ${undelivered} audit record(s) that were never delivered ` +
              'to the collector. A pending queue past its ceiling is an operational alarm — ' +
              'check the forwarding configuration and the collector.',
          );
        }

        return { deleted: count, undelivered };
      },
      { timeoutMs: 30_000 },
    );
  }

  private async recordDrops(
    tx: Prisma.TransactionClient,
    dropped: number,
    now: Date,
  ): Promise<void> {
    const existing = await tx.appSetting.findUnique({ where: { key: UNDELIVERED_DROPS_KEY } });
    const prior =
      existing !== null && isDropsValue(existing.value) ? existing.value.total : 0;

    const value: UndeliveredDrops = {
      total: prior + dropped,
      lastDroppedAt: now.toISOString(),
    };

    await tx.appSetting.upsert({
      where: { key: UNDELIVERED_DROPS_KEY },
      create: { key: UNDELIVERED_DROPS_KEY, value },
      update: { value },
    });
  }
}

function isDropsValue(value: unknown): value is UndeliveredDrops {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UndeliveredDrops).total === 'number'
  );
}
