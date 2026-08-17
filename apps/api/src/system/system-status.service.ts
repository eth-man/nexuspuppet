import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_TRANSPORT } from '@nexuspuppet/contracts';
import type { FailureDetail, IAuditTransport, SystemStatus } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditDeliveryOutbox } from '../auth/audit-delivery.outbox';
import { LAST_DELIVERY_KEY, type LastDeliveryOutcome } from '../auth/audit-delivery.worker';
import {
  UNDELIVERED_DROPS_KEY,
  type AuditRetentionPolicy,
  type UndeliveredDrops,
} from '../auth/audit-retention.sweeper';
import { AuditForwardingService } from '../settings/audit-forwarding.service';
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
    private readonly forwarding: AuditForwardingService,
    /** Whether this deployment holds `audit.export` — forwarding can exist at all. */
    private readonly forwardingAvailable: () => boolean,
    /** The same policy object the sweeper runs with; two copies would drift. */
    private readonly retention: AuditRetentionPolicy,
    /**
     * Replication config, passed in rather than read from the environment here.
     *
     * The listener is opened by main.ts from the same values, so a single
     * source keeps the console from reporting a listener that was never opened
     * — or staying silent about one that was.
     */
    private readonly replicationConfig: { enabled: boolean; allowedCertnames: readonly string[] },
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
    const [materialization, auditDelivery, auditForwarding, retention, projection, replication] =
      await Promise.all([
        this.materialization(includeDetail),
        this.auditDelivery(includeDetail),
        this.auditForwarding(includeDetail),
        this.retentionStatus(),
        this.projectionStatus(),
        this.replicationStatus(),
      ]);

    return {
      materialization,
      ...(auditDelivery === null ? {} : { auditDelivery }),
      auditForwarding,
      retention,
      projection,
      replication,
      includesDetail: includeDetail,
    };
  }

  /**
   * Whether classification is reaching a puppetserver (ADR-0019 §6).
   *
   * `behind` is computed HERE rather than left to the console, so one
   * definition of "the Puppet server is serving something older than what you
   * are looking at" exists rather than two.
   *
   * It compares against the newest ENC write, not against the current tree
   * hash. Hashing the tree would mean reading every node file on every status
   * poll — and the materializer already refuses to write when content is
   * unchanged, so its newest `writtenAt` only advances on a real change.
   *
   * Both timestamps are stamped by THIS process, which is what makes the
   * comparison sound. A peer's own clock never enters it: two hosts that
   * disagree by a few seconds would otherwise decide whether an estate looks
   * healthy. It also still catches a peer that has stopped polling entirely —
   * its `lastFetchAt` freezes, so the next real change leaves it behind.
   */
  private async replicationStatus(): Promise<SystemStatus['replication']> {
    const now = Date.now();
    const [peers, newest, receipts] = await Promise.all([
      this.prisma.encReplicationPeer.findMany({ orderBy: { lastFetchAt: 'desc' }, take: 50 }),
      this.prisma.encMaterialization.findFirst({
        orderBy: { writtenAt: 'desc' },
        select: { writtenAt: true },
      }),
      // Grouped rather than counted per peer: fifty peers would otherwise be
      // fifty queries on a page an operator refreshes.
      this.prisma.compileReceipt.groupBy({ by: ['peerCertname'], _count: { _all: true } }),
    ]);

    const receiptsByPeer = new Map(receipts.map((r) => [r.peerCertname, r._count._all]));

    /*
     * Peers that report but have never fetched (ADR-0022).
     *
     * Computed from the two sets we already have rather than stored on the
     * receipt: a peer that starts fetching tomorrow makes yesterday's receipts
     * legitimate, and a stored flag would go on insisting they were not.
     */
    const known = new Set(peers.map((p) => p.certname));
    const reportingStrangers = receipts
      .map((r) => r.peerCertname)
      .filter((certname) => !known.has(certname));

    const lastMaterializedAt = newest?.writtenAt ?? null;

    return {
      enabled: this.replicationConfig.enabled,
      allowedCertnames: [...this.replicationConfig.allowedCertnames],
      lastMaterializedAt: lastMaterializedAt?.toISOString() ?? null,
      reportingStrangers,
      peers: peers.map((peer) => ({
        certname: peer.certname,
        lastFetchAt: peer.lastFetchAt.toISOString(),
        lastStatus: peer.lastStatus,
        lastChangedAt: peer.lastChangedAt?.toISOString() ?? null,
        fetchCount: peer.fetchCount,
        /*
         * A peer that has NEVER received a tree is behind as soon as anything
         * has been materialized — it is reachable and holds nothing, which is
         * the worst state and the easiest to miss.
         *
         * Otherwise the question is "has it POLLED since the last real change",
         * not "has it TRANSFERRED since the last real change". A peer that
         * polls and is answered 304 is current BY DEFINITION — 304 means the
         * bytes it holds are identical to the ones we would send. Comparing
         * against `lastChangedAt`, which only advances on a 200, marks every
         * such peer permanently behind: it will never transfer again precisely
         * because it is already up to date.
         */
        behind:
          lastMaterializedAt !== null &&
          (peer.lastChangedAt === null || peer.lastFetchAt < lastMaterializedAt),
        reportedCount: receiptsByPeer.get(peer.certname) ?? 0,
        /*
         * The clock is read HERE, not in the catalogue. The catalogue is pure
         * and owns the threshold; handing it a timestamp would make it need a
         * clock to decide anything, which is exactly what it refuses to do.
         */
        secondsSinceChange:
          peer.lastChangedAt === null
            ? null
            : Math.floor((now - peer.lastChangedAt.getTime()) / 1000),
      })),
    };
  }

  /**
   * The forwarding pipeline as one report, in EVERY edition (issue #95).
   *
   * Unlike `auditDelivery` below, the unlicensed case is a state, not an
   * omission: "forwarding unavailable" is what the Integrations screen grays
   * out, and the status surface should say the same thing in the same terms.
   */
  private async auditForwarding(includeDetail: boolean): Promise<SystemStatus['auditForwarding']> {
    const [view, pending, oldest, last] = await Promise.all([
      this.forwarding.describe(),
      this.outbox.depth(),
      this.prisma.auditDeliveryJob.findFirst({
        orderBy: { nextAttemptAt: 'asc' },
        select: { nextAttemptAt: true },
      }),
      this.prisma.appSetting.findUnique({ where: { key: LAST_DELIVERY_KEY } }),
    ]);

    const outcome = isOutcome(last?.value) ? last.value : null;

    return {
      available: this.forwardingAvailable(),
      active: view.active,
      configured: this.transport.configured,
      // The flag rides the ACTIVE mode, not the stored one: a saved UDP
      // configuration that is not delivering proves nothing either way.
      unconfirmableDelivery: view.active === 'syslog' && view.syslog.config?.protocol === 'udp',
      pending,
      oldestDueAt: oldest?.nextAttemptAt.toISOString() ?? null,
      lastDelivery:
        outcome === null
          ? null
          : {
              at: outcome.at,
              ok: outcome.ok,
              delivered: outcome.delivered,
              // The error names the collector; same audience rule as every
              // other failure string here.
              error: includeDetail ? outcome.error : null,
            },
    };
  }

  /** The retention bounds in force, and what the ceiling has cost (ADR-0016 §6). */
  private async retentionStatus(): Promise<SystemStatus['retention']> {
    const row = await this.prisma.appSetting.findUnique({
      where: { key: UNDELIVERED_DROPS_KEY },
    });
    const drops = isDrops(row?.value) ? row.value : null;

    return {
      ageDays: this.retention.retentionDays,
      maxRows: this.retention.maxRows,
      undeliveredDropped: {
        total: drops?.total ?? 0,
        lastDroppedAt: drops?.lastDroppedAt ?? null,
      },
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

function isOutcome(value: unknown): value is LastDeliveryOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LastDeliveryOutcome).at === 'string' &&
    typeof (value as LastDeliveryOutcome).ok === 'boolean'
  );
}

function isDrops(value: unknown): value is UndeliveredDrops {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UndeliveredDrops).total === 'number'
  );
}
