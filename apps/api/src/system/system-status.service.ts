import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_TRANSPORT } from '@nexuspuppet/contracts';
import type { FailureDetail, IAuditTransport, SystemStatus } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditDeliveryOutbox } from '../auth/audit-delivery.outbox';
import { NodeProjectionService } from '../puppetdb/node-projection.service';

/**
 * Operational status of the deployment.
 *
 * Read-only, and deliberately cheap: this is polled by every open console, so
 * every query here rides an existing index. Counts group by `status`, and
 * "oldest" orders by `nextAttemptAt` — both covered by
 * `@@index([status, nextAttemptAt])` on the job tables. `createdAt` would be
 * the more intuitive ordering and is not indexed; "what is overdue" is the more
 * useful question anyway.
 *
 * The one number worth staring at is `materialization.failed`. A job that
 * exhausts its attempts is written back with status FAILED, and nothing in this
 * codebase ever claims, retries or clears it — `drainLocked` selects
 * `status: 'PENDING'` only. So each of those is a node whose ENC file could not
 * be written, still running its previous classification, with nothing scheduled
 * to fix it. Before this surface existed the only trace was one ERROR log line
 * at the time it happened.
 */
@Injectable()
export class SystemStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: AuditDeliveryOutbox,
    private readonly projection: NodeProjectionService,
    @Inject(AUDIT_TRANSPORT) private readonly transport: IAuditTransport,
  ) {}

  /**
   * @param includeDetail whether to include error strings.
   *
   * Passed in rather than decided here: a materialization error carries
   * filesystem paths and an audit delivery error carries the collector's
   * hostname, so the caller — which knows the principal's role — decides. The
   * counts are for everyone; the strings are for an administrator.
   */
  async status(includeDetail: boolean): Promise<SystemStatus> {
    const [materialization, auditDelivery, projection] = await Promise.all([
      this.materialization(includeDetail),
      this.auditDelivery(includeDetail),
      this.projectionStatus(),
    ]);

    return {
      materialization,
      ...(auditDelivery === null ? {} : { auditDelivery }),
      projection,
      includesDetail: includeDetail,
    };
  }

  private async materialization(includeDetail: boolean): Promise<SystemStatus['materialization']> {
    const [pending, failed, oldest] = await Promise.all([
      this.prisma.encMaterializationJob.count({ where: { status: 'PENDING' } }),
      this.prisma.encMaterializationJob.count({ where: { status: 'FAILED' } }),
      this.prisma.encMaterializationJob.findFirst({
        where: { status: 'PENDING' },
        orderBy: { nextAttemptAt: 'asc' },
        select: { nextAttemptAt: true },
      }),
    ]);

    // Bounded. A pathological estate could strand thousands of nodes, and a
    // status endpoint that returns thousands of error strings is a second
    // outage rather than a report on the first.
    const failures: FailureDetail[] = includeDetail
      ? (
          await this.prisma.encMaterializationJob.findMany({
            where: { status: 'FAILED' },
            orderBy: { nextAttemptAt: 'desc' },
            take: 20,
            select: {
              certname: true,
              reason: true,
              attempts: true,
              lastError: true,
              nextAttemptAt: true,
            },
          })
        ).map((job) => ({
          certname: job.certname,
          reason: job.reason,
          attempts: job.attempts,
          lastError: job.lastError,
          failedAt: job.nextAttemptAt.toISOString(),
        }))
      : [];

    return {
      pending,
      failed,
      oldestDueAt: oldest?.nextAttemptAt.toISOString() ?? null,
      failures,
    };
  }

  /**
   * Null when no transport is installed.
   *
   * Core forwards audit records nowhere, and that is a complete product rather
   * than a fault (ADR-0002). Reporting an empty delivery queue for a deployment
   * that was never going to deliver anything would invite someone to treat a
   * working system as broken.
   */
  private async auditDelivery(
    includeDetail: boolean,
  ): Promise<SystemStatus['auditDelivery'] | null> {
    if (!this.transport.configured) return null;

    const [pending, oldest] = await Promise.all([
      this.outbox.depth(),
      this.prisma.auditDeliveryJob.findFirst({
        orderBy: { nextAttemptAt: 'asc' },
        select: { nextAttemptAt: true },
      }),
    ]);

    // There is no terminal state for a delivery — no attempt limit, by design —
    // so "failing" means attempts have accumulated, not that it was abandoned.
    const failures: FailureDetail[] = includeDetail
      ? (
          await this.prisma.auditDeliveryJob.findMany({
            where: { attempts: { gt: 0 } },
            orderBy: { attempts: 'desc' },
            take: 20,
            select: { attempts: true, lastError: true, nextAttemptAt: true },
          })
        ).map((job) => ({
          certname: null,
          reason: 'audit-delivery',
          attempts: job.attempts,
          lastError: job.lastError,
          failedAt: job.nextAttemptAt.toISOString(),
        }))
      : [];

    return {
      configured: true,
      transport: this.transport.name,
      pending,
      oldestDueAt: oldest?.nextAttemptAt.toISOString() ?? null,
      failures,
    };
  }

  private async projectionStatus(): Promise<SystemStatus['projection']> {
    const [nodes, oldest] = await Promise.all([
      this.prisma.managedNode.count(),
      this.prisma.managedNode.findFirst({
        orderBy: { projectedAt: 'asc' },
        select: { projectedAt: true },
      }),
    ]);

    return {
      nodes,
      oldestProjectedAt: oldest?.projectedAt.toISOString() ?? null,
      // Not a query: the projector records this on every pass, because
      // recomputing it would mean re-reading every node's facts.
      factsNoNodeReports: [...this.projection.factsNoNodeReports()],
    };
  }
}
