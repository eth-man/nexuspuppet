import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The outbox for forwarding audit records to an external system (ADR-0005).
 *
 * WHY THIS EXISTS RATHER THAN THE SINK JUST SENDING
 * -------------------------------------------------
 * `IAuditSink.record` is called INSIDE the transaction that made the change
 * being audited — that is the ADR-0005 guarantee, and it is why the audit row
 * cannot be missing for a change that happened.
 *
 * An external sink cannot honour that. HTTP inside `prisma.$transaction` holds
 * a pooled connection and its locks open for a network round trip, so a slow
 * SIEM becomes a slow classification write and eventually an exhausted pool.
 * And a transaction that later rolls back would have already told the SIEM
 * about a change that never happened — an audit trail that reports fiction is
 * worse than one that is merely late.
 *
 * So delivery is decoupled exactly as ENC materialization is: enqueue in the
 * transaction, deliver afterwards. Late is acceptable; lost or invented is not.
 *
 * EXPOSED TO THE ENTERPRISE LAYER
 * -------------------------------
 * A forwarding sink registered under AUDIT_SINK injects this to queue its work.
 * It exists in core because only core owns the schema and the Prisma client —
 * ADR-0002 forbids the enterprise package reaching either.
 */
export type TransactionClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** One audit record awaiting delivery, with the record itself already loaded. */
export interface PendingDelivery {
  jobId: string;
  auditLogId: string;
  attempts: number;
  entry: {
    actorUserId: string | null;
    actorEmail: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    before: unknown;
    after: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
  };
}

@Injectable()
export class AuditDeliveryOutbox {
  private readonly logger = new Logger(AuditDeliveryOutbox.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Queue an audit record for delivery.
   *
   * THE ONLY CORRECT WAY TO USE THIS is inside the same transaction as the
   * change and its audit row:
   *
   *   await prisma.$transaction(async (tx) => {
   *     await tx.nodeGroupClass.create({ ... });
   *     const row = await tx.auditLog.create({ ... });
   *     await outbox.enqueue(tx, row.id);
   *   });
   *
   * Enqueuing outside it reintroduces exactly the gap the outbox prevents: the
   * change commits, the process dies, and the external system never hears about
   * something that definitely happened.
   *
   * Idempotent per audit record — a record has at most one delivery job, so a
   * retry of the surrounding operation cannot queue it twice.
   */
  async enqueue(tx: TransactionClient, auditLogId: string): Promise<void> {
    await tx.auditDeliveryJob.upsert({
      where: { auditLogId },
      create: { auditLogId },
      // Deliberately empty: an existing job may be mid-backoff after a failed
      // attempt, and resetting its schedule would restart the retry cycle.
      update: {},
    });
  }

  /**
   * Take a batch of due deliveries, oldest first.
   *
   * Claim-by-DELETE inside the caller's transaction, the same discipline the ENC
   * outbox uses: a job is either delivered or its claim rolls back and it stays
   * queued. There is no state where a worker has taken work and forgotten it.
   *
   * The audit record is loaded with the job, so a caller — including one in the
   * enterprise layer, which has no database access — receives everything it
   * needs to build a payload.
   */
  async claim(tx: TransactionClient, limit: number): Promise<PendingDelivery[]> {
    const jobs = await tx.auditDeliveryJob.findMany({
      where: { nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { auditLog: true },
    });

    if (jobs.length === 0) return [];

    await tx.auditDeliveryJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });

    return jobs.map((job) => ({
      jobId: job.id,
      auditLogId: job.auditLogId,
      attempts: job.attempts,
      entry: {
        actorUserId: job.auditLog.actorUserId,
        actorEmail: job.auditLog.actorEmail,
        action: job.auditLog.action,
        entityType: job.auditLog.entityType,
        entityId: job.auditLog.entityId,
        before: job.auditLog.before,
        after: job.auditLog.after,
        ipAddress: job.auditLog.ipAddress,
        userAgent: job.auditLog.userAgent,
        createdAt: job.auditLog.createdAt,
      },
    }));
  }

  /**
   * Put a failed delivery back with a backoff.
   *
   * Re-created rather than updated, because `claim` already deleted it. Runs on
   * the top-level client, not the caller's transaction: the point is to record
   * the failure even when the batch that produced it is rolling back.
   *
   * There is no attempt LIMIT. A dropped audit record is a compliance gap, and
   * an operator would rather find a backlog than discover that events were
   * discarded quietly while the SIEM was down for a weekend.
   */
  async reschedule(delivery: PendingDelivery, error: string, backoffMs: number): Promise<void> {
    const attempts = delivery.attempts + 1;
    try {
      await this.prisma.auditDeliveryJob.upsert({
        where: { auditLogId: delivery.auditLogId },
        create: {
          auditLogId: delivery.auditLogId,
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          lastError: error.slice(0, 1000),
        },
        update: {
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          lastError: error.slice(0, 1000),
        },
      });
    } catch (cause) {
      // The audit record itself was pruned while its delivery was in flight.
      // Nothing to reschedule against, and nothing an operator can do.
      this.logger.warn(
        `Could not reschedule delivery for audit record ${delivery.auditLogId}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** How many records are waiting. Surfaced so a stalled SIEM is visible. */
  async depth(): Promise<number> {
    return this.prisma.auditDeliveryJob.count();
  }
}
