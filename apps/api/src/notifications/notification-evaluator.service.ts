import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { SystemStatus } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { SystemStatusService } from '../system/system-status.service';
import { ConsoleTlsService } from '../system/console-tls.service';
import { NodeProjectionService } from '../puppetdb/node-projection.service';
import { readConditions, type ConditionReading } from './pure/condition-catalogue';
import { decide, isOpen, type ConditionState } from './pure/condition-lifecycle';

/**
 * Evaluates the condition catalogue on a timer (ADR-0021).
 *
 * `SystemStatusService` computes almost everything here already, but only when
 * the console asks — so every condition is visible exactly when somebody
 * happens to look. This is the thing that looks when nobody is.
 *
 * REUSES the status service rather than re-deriving. Two definitions of
 * "materialization is unhealthy" would drift, and the one on the dashboard is
 * the one people already trust.
 */

/** Announced cumulative drops, so the same drop is not re-opened forever. */
export const ANNOUNCED_DROPS_KEY = 'notifications.announcedUndeliveredDrops';

export interface EvaluatorPacing {
  /**
   * How often conditions are evaluated. 0 disables it in this process.
   *
   * COUPLED TO THE SYNC TIMER, which is configured on the Puppet server and
   * which this deployment cannot see (ADR-0021, Consequences). Three
   * evaluations at five minutes is a fifteen-minute floor before "a Puppet
   * server is behind" opens — comfortably longer than a five-minute sync
   * timer plus its jitter. Shorten this and that condition starts firing on
   * routine edits.
   */
  intervalMs: number;
}

export const DEFAULT_EVALUATOR_PACING: EvaluatorPacing = { intervalMs: 300_000 };

@Injectable()
export class NotificationEvaluatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEvaluatorService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly status: SystemStatusService,
    private readonly tls: ConsoleTlsService,
    private readonly projection: NodeProjectionService,
    private readonly puppetDbReachable: () => Promise<{
      reachable: boolean;
      lastSuccessAt: string | null;
    }>,
    private readonly pacing: EvaluatorPacing = DEFAULT_EVALUATOR_PACING,
  ) {}

  onModuleInit(): void {
    if (this.pacing.intervalMs <= 0) {
      this.logger.log('Condition evaluation disabled in this process.');
      return;
    }

    this.timer = setInterval(() => void this.safeEvaluate(), this.pacing.intervalMs);
    this.timer.unref();
    this.logger.log(`Evaluating operational conditions every ${String(this.pacing.intervalMs)}ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /**
   * A failing evaluation must not stop the timer.
   *
   * An unhandled rejection inside setInterval ends the interval in some
   * runtimes, and the failure mode is the worst one available: alerting stops
   * silently, and the console keeps showing whatever was open at the time.
   * Nobody notices, because the symptom of broken alerting is silence.
   */
  private async safeEvaluate(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.evaluate();
    } catch (error: unknown) {
      this.logger.error(
        `Condition evaluation failed; the timer continues. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async evaluate(now: Date = new Date()): Promise<void> {
    const [status, tls, puppetDb, announced] = await Promise.all([
      this.status.status(false),
      this.tls.status(),
      this.puppetDbReachable(),
      this.announcedDrops(),
    ]);

    const readings = readConditions({
      status,
      puppetDbReachable: puppetDb.reachable,
      puppetDbLastSuccessAt: puppetDb.lastSuccessAt,
      consoleCertDaysRemaining: tls.certificate?.daysRemaining ?? null,
      announcedUndeliveredDrops: announced,
      pruneSkippedReason: this.projection.lastProjection()?.pruneSkippedReason ?? null,
    });

    const stored = await this.prisma.notificationCondition.findMany();
    const byKey = new Map(stored.map((row) => [row.key, row]));

    for (const reading of readings) {
      await this.applyReading(reading, byKey.get(reading.key) ?? null, now);
    }

    /*
     * Conditions the catalogue no longer produces — a peer removed from the
     * allowlist, replication switched off, a capability lost. They are treated
     * as passing and resolved.
     *
     * Leaving them open would strand an alert about something that no longer
     * exists, which nobody can clear and everybody learns to ignore.
     */
    const produced = new Set(readings.map((r) => r.key));
    for (const row of stored) {
      if (produced.has(row.key)) continue;
      if (!isOpen(row)) continue;

      await this.prisma.notificationCondition.update({
        where: { key: row.key },
        data: { resolvedAt: now, consecutiveFailures: 0, lastEvaluatedAt: now },
      });
      this.logger.log(`Condition resolved (no longer applicable): ${row.key}`);
    }

    // Record the drop total only once it has been announced, so the cumulative
    // counter does not re-open the same condition on every evaluation.
    const total = status.retention.undeliveredDropped.total;
    if (total > announced) await this.recordAnnouncedDrops(total);
  }

  private async applyReading(
    reading: ConditionReading,
    previous: (ConditionState & { key: string }) | null,
    now: Date,
  ): Promise<void> {
    const decision = decide(
      previous === null
        ? null
        : {
            consecutiveFailures: previous.consecutiveFailures,
            openedAt: previous.openedAt,
            resolvedAt: previous.resolvedAt,
          },
      { failing: reading.failing, selfResolving: reading.selfResolving },
      now,
    );

    const data = {
      kind: reading.kind,
      severity: reading.severity,
      summary: reading.summary,
      consecutiveFailures: decision.state.consecutiveFailures,
      openedAt: decision.state.openedAt,
      resolvedAt: decision.state.resolvedAt,
      lastEvaluatedAt: now,
    };

    /*
     * ONE TRANSACTION, condition and delivery together (ADR-0021 §7).
     *
     * Splitting them lets a condition open with no delivery owed — the
     * console would show it and nobody would be told, which is precisely the
     * silence this feature exists to end. Same reasoning as the audit outbox,
     * and as every classification write.
     *
     * Only the EDGES enqueue. A condition that is merely still-open produces
     * nothing, which is the entire point of the model.
     */
    await this.prisma.$transaction(async (tx) => {
      await tx.notificationCondition.upsert({
        where: { key: reading.key },
        create: { key: reading.key, ...data },
        update: data,
      });

      if (decision.transition === null) return;

      await tx.notificationDeliveryJob.create({
        data: {
          conditionKey: reading.key,
          transition: decision.transition,
          /*
           * The message AS IT IS NOW, not a reference to be resolved later.
           * By delivery time the condition may have resolved or its summary
           * changed, and a delivery describing a state that never existed is
           * worse than a late one.
           */
          payload: {
            transition: decision.transition,
            key: reading.key,
            kind: reading.kind,
            severity: reading.severity,
            summary: reading.summary,
            at: now.toISOString(),
          },
        },
      });
    });

    if (decision.transition === 'opened') {
      this.logger.warn(`Condition opened: ${reading.key} — ${reading.summary}`);
    } else if (decision.transition === 'resolved') {
      this.logger.log(`Condition resolved: ${reading.key}`);
    }
  }

  private async announcedDrops(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: ANNOUNCED_DROPS_KEY } });
    const value = (row?.value as { total?: unknown } | undefined)?.total;
    return typeof value === 'number' ? value : 0;
  }

  private async recordAnnouncedDrops(total: number): Promise<void> {
    await this.prisma.appSetting.upsert({
      where: { key: ANNOUNCED_DROPS_KEY },
      create: { key: ANNOUNCED_DROPS_KEY, value: { total } },
      update: { value: { total } },
    });
  }
}

/** The open conditions, newest first — what the console panel renders. */
export async function openConditions(prisma: PrismaService): Promise<
  Array<{
    key: string;
    kind: string;
    severity: string;
    summary: string;
    openedAt: Date;
  }>
> {
  const rows = await prisma.notificationCondition.findMany({
    where: { openedAt: { not: null }, resolvedAt: null },
    orderBy: { openedAt: 'desc' },
  });

  return rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    severity: row.severity,
    summary: row.summary,
    openedAt: row.openedAt as Date,
  }));
}

export type { SystemStatus };
