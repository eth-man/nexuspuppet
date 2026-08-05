import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AUDIT_TRANSPORT } from '@nexuspuppet/contracts';
import type { AuditDeliveryEntry, IAuditTransport } from '@nexuspuppet/contracts';
import { PrismaService, ADVISORY_LOCKS } from '../prisma/prisma.service';
import { AuditDeliveryOutbox, type PendingDelivery } from './audit-delivery.outbox';

/**
 * Core's default transport: there isn't one.
 *
 * Core writes audit records to Postgres and forwards them nowhere, which is a
 * complete product rather than a missing feature (ADR-0002). It reports
 * `configured: false`, so the worker leaves the queue untouched instead of
 * draining records into a void.
 *
 * `deliver` throws rather than returning quietly. Nothing should call it, and
 * if something does, a loud failure that leaves the record queued is much
 * better than a silent success that deletes it.
 */
@Injectable()
export class NoopAuditTransport implements IAuditTransport {
  readonly name = 'none';
  readonly configured = false;

  async deliver(): Promise<void> {
    throw new Error(
      'No audit transport is configured. Core forwards audit records nowhere; ' +
        'install a capability that registers AUDIT_TRANSPORT.',
    );
  }
}

export interface AuditDeliveryPacing {
  /** How often to look for work. 0 disables the worker in this process. */
  intervalMs: number;
  /** Records handed to the transport in one call. */
  batchSize: number;
  /**
   * How long a claimed batch stays invisible to other workers.
   *
   * Must comfortably exceed the slowest plausible delivery. Too short and a
   * second worker re-sends a batch still in flight; too long and a crashed
   * worker's records wait that long to be retried. Neither loses data.
   */
  leaseMs: number;
  /** First retry delay; doubles per attempt up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_AUDIT_PACING: AuditDeliveryPacing = {
  intervalMs: 15_000,
  batchSize: 100,
  leaseMs: 120_000,
  backoffMs: 30_000,
  maxBackoffMs: 3_600_000,
};

/**
 * Where the worker records its most recent delivery outcome, for
 * `GET /system/status` (issue #95).
 *
 * Persisted because success leaves no other trace: a delivered job's row is
 * deleted, so without this the one question an operator asks a working
 * pipeline — "when did it last deliver?" — has no answer anywhere.
 */
export const LAST_DELIVERY_KEY = 'audit.delivery.lastOutcome';

export type LastDeliveryOutcome = {
  at: string;
  ok: boolean;
  delivered: number;
  error: string | null;
};

/**
 * Drains the audit delivery outbox (ADR-0005).
 *
 * Lives in core because only core has database access — the enterprise layer
 * supplies the transport, not the plumbing. The split is deliberate: retries,
 * leases, backoff and single-flight are properties of the queue and should not
 * be reimplemented by every transport.
 *
 * Runs under an advisory lock so exactly one replica drains at a time, the same
 * arrangement the ENC materializer uses.
 */
@Injectable()
export class AuditDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditDeliveryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  /** Warn once, not every tick, when records are queued with nowhere to go. */
  private warnedUnconfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: AuditDeliveryOutbox,
    @Inject(AUDIT_TRANSPORT) private readonly transport: IAuditTransport,
    private readonly pacing: AuditDeliveryPacing = DEFAULT_AUDIT_PACING,
  ) {}

  onModuleInit(): void {
    if (this.pacing.intervalMs <= 0) return;

    if (!this.transport.configured) {
      // Say so once at boot — but the timer still starts. `configured` may
      // become true while the process runs (ADR-0016 §4: reconfiguration is
      // live), and drain() re-checks it every tick, so an operator activating
      // a transport from the console must not need a restart before delivery
      // begins.
      this.logger.log(
        `Audit delivery idle — transport "${this.transport.name}" is not configured. ` +
          'Records are still written to Postgres.',
      );
    } else {
      this.logger.log(
        `Audit delivery running every ${this.pacing.intervalMs}ms via "${this.transport.name}".`,
      );
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pacing.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      await this.drain();
    } catch (error) {
      // A tick must never take the process down; the next one tries again.
      this.logger.error(
        `Audit delivery tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass: lease a batch, deliver it, then settle it.
   *
   * The transport is called OUTSIDE the advisory-lock transaction. Holding a
   * database transaction open across a network call is the thing this whole
   * design exists to avoid.
   */
  async drain(): Promise<{ delivered: number; failed: number; ranHere: boolean }> {
    if (!this.transport.configured) {
      const waiting = await this.outbox.depth();
      if (waiting > 0 && !this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn(
          `${waiting} audit record(s) are queued for delivery but no transport is ` +
            'configured. They are retained, not dropped — records are never discarded ' +
            'to relieve a backlog.',
        );
      }
      return { delivered: 0, failed: 0, ranHere: false };
    }

    const claimed = await this.prisma.withAdvisoryLock(
      ADVISORY_LOCKS.AUDIT_DELIVERY,
      (tx) => this.outbox.claim(tx, this.pacing.batchSize, this.pacing.leaseMs),
      { timeoutMs: 30_000 },
    );

    // null means another replica holds the lock; [] means nothing is due.
    if (claimed === null) return { delivered: 0, failed: 0, ranHere: false };
    if (claimed.length === 0) return { delivered: 0, failed: 0, ranHere: true };

    const entries = claimed.map(toEntry);

    try {
      await this.transport.deliver(entries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The whole batch failed, so the whole batch goes back. Partial success is
      // not detectable through this interface, and re-sending a record the SIEM
      // already has is harmless — dropping one is not.
      await this.rescheduleAll(claimed, message);
      await this.recordOutcome({
        at: new Date().toISOString(),
        ok: false,
        delivered: 0,
        error: message,
      });
      this.logger.warn(
        `Audit delivery via "${this.transport.name}" failed for ${claimed.length} record(s): ${message}`,
      );
      return { delivered: 0, failed: claimed.length, ranHere: true };
    }

    const removed = await this.outbox.complete(claimed.map((c) => c.auditLogId));
    await this.recordOutcome({
      at: new Date().toISOString(),
      ok: true,
      delivered: removed,
      error: null,
    });
    this.logger.debug(`Delivered ${removed} audit record(s) via "${this.transport.name}".`);
    return { delivered: removed, failed: 0, ranHere: true };
  }

  /** Status reporting must never break delivery, so a failed write only logs. */
  private async recordOutcome(outcome: LastDeliveryOutcome): Promise<void> {
    try {
      await this.prisma.appSetting.upsert({
        where: { key: LAST_DELIVERY_KEY },
        create: { key: LAST_DELIVERY_KEY, value: outcome },
        update: { value: outcome },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record the delivery outcome: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async rescheduleAll(batch: readonly PendingDelivery[], error: string): Promise<void> {
    for (const delivery of batch) {
      // Exponential, capped. An hour is long enough not to hammer a SIEM that
      // is down for maintenance, and short enough that recovery is unattended.
      const backoff = Math.min(
        this.pacing.backoffMs * 2 ** delivery.attempts,
        this.pacing.maxBackoffMs,
      );
      await this.outbox.reschedule(delivery, error, backoff);
    }
  }
}

/** Prisma row shape to the wire shape the transport contract declares. */
function toEntry(delivery: PendingDelivery): AuditDeliveryEntry {
  return {
    auditLogId: delivery.auditLogId,
    actorUserId: delivery.entry.actorUserId,
    actorEmail: delivery.entry.actorEmail,
    action: delivery.entry.action,
    entityType: delivery.entry.entityType,
    entityId: delivery.entry.entityId,
    before: delivery.entry.before,
    after: delivery.entry.after,
    ipAddress: delivery.entry.ipAddress,
    userAgent: delivery.entry.userAgent,
    createdAt: delivery.entry.createdAt.toISOString(),
  };
}
