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
    entityLabel: string | null;
    requestId: string | null;
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
   * Lease a batch of due deliveries, oldest first.
   *
   * LEASED, NOT DELETED, and the distinction matters more here than in the ENC
   * outbox. That one claims by delete because it does its work — writing a file
   * — inside the same transaction, so a crash rolls the claim back with it.
   *
   * Delivery cannot work that way: the network call has to happen OUTSIDE the
   * transaction, or a slow SIEM holds a pooled connection and its locks open.
   * That leaves a window between the claim committing and the delivery
   * finishing, and a delete would make a crash in that window destroy audit
   * records permanently — the exact compliance gap the retry policy below
   * exists to avoid.
   *
   * So a claim pushes `nextAttemptAt` out by the lease instead. A worker that
   * dies mid-delivery leaves rows that simply become visible again when the
   * lease expires. Delivery is at-least-once; a SIEM can dedupe on
   * `auditLogId`, and cannot recover a record nobody sent.
   *
   * The audit record is loaded with the job, so a caller — including one in the
   * enterprise layer, which has no database access — receives everything it
   * needs to build a payload.
   */
  async claim(tx: TransactionClient, limit: number, leaseMs: number): Promise<PendingDelivery[]> {
    const jobs = await tx.auditDeliveryJob.findMany({
      where: { nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { auditLog: true },
    });

    if (jobs.length === 0) return [];

    await tx.auditDeliveryJob.updateMany({
      where: { id: { in: jobs.map((j) => j.id) } },
      data: { nextAttemptAt: new Date(Date.now() + leaseMs) },
    });

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
        entityLabel: job.auditLog.entityLabel,
        requestId: job.auditLog.requestId,
        before: job.auditLog.before,
        after: job.auditLog.after,
        ipAddress: job.auditLog.ipAddress,
        userAgent: job.auditLog.userAgent,
        createdAt: job.auditLog.createdAt,
      },
    }));
  }

  /**
   * Remove deliveries that were accepted by the external system.
   *
   * The only thing that deletes a job. Runs on the top-level client because it
   * happens after the network call, outside any transaction.
   */
  async complete(auditLogIds: readonly string[]): Promise<number> {
    if (auditLogIds.length === 0) return 0;
    const { count } = await this.prisma.auditDeliveryJob.deleteMany({
      where: { auditLogId: { in: [...auditLogIds] } },
    });
    return count;
  }

  /**
   * Return a failed delivery to the queue with a backoff.
   *
   * Updates the leased row rather than re-creating it — the lease left it in
   * place — and shortens the lease to the backoff so a failure retries on its
   * own schedule rather than waiting out a lease sized for a slow success.
   *
   * There is no attempt LIMIT. A dropped audit record is a compliance gap, and
   * an operator would rather find a backlog than discover that events were
   * discarded quietly while the SIEM was down for a weekend.
   */
  async reschedule(delivery: PendingDelivery, error: string, backoffMs: number): Promise<void> {
    const attempts = delivery.attempts + 1;
    try {
      await this.prisma.auditDeliveryJob.update({
        where: { auditLogId: delivery.auditLogId },
        data: {
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
