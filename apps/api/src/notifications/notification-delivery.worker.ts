import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NotificationPayload, NotificationWebhookSettings } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsStore } from '../settings/settings.store';
import { NotificationWebhookTransport } from './notification-webhook.transport';

/**
 * Drains the notification outbox (ADR-0021 §7).
 *
 * Same shape as audit delivery, deliberately: one mechanism, not two. Two
 * would mean two retry policies and two backlogs to reason about during the
 * incident that produced both.
 */

export interface DeliveryPacing {
  intervalMs: number;
  batchSize: number;
  /** Backoff after a failed attempt, capped so a long outage still retries. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /**
   * Attempts before a job is given up on.
   *
   * Bounded because a notification about a condition from three days ago is
   * noise, not information — unlike an audit record, which must survive. That
   * difference is why this worker has a ceiling and the audit one does not.
   */
  maxAttempts: number;
}

export const DEFAULT_DELIVERY_PACING: DeliveryPacing = {
  intervalMs: 30_000,
  batchSize: 20,
  baseBackoffMs: 60_000,
  maxBackoffMs: 900_000,
  maxAttempts: 10,
};

@Injectable()
export class NotificationDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: SettingsStore,
    private readonly transport: NotificationWebhookTransport,
    private readonly pacing: DeliveryPacing = DEFAULT_DELIVERY_PACING,
  ) {}

  onModuleInit(): void {
    if (this.pacing.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.safeDrain(), this.pacing.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** A failure here must not end the interval, or delivery stops silently. */
  private async safeDrain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drain();
    } catch (error: unknown) {
      this.logger.error(
        `Notification delivery failed; the timer continues. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async drain(now: Date = new Date()): Promise<void> {
    const settings = await this.webhookSettings();

    /*
     * No destination configured: leave the queue alone.
     *
     * NOT drained-and-discarded. An operator who configures a webhook after a
     * bad night should receive what they missed, and a queue quietly emptied
     * by the absence of configuration is indistinguishable from one that was
     * delivered.
     */
    if (settings === null) return;

    const due = await this.prisma.notificationDeliveryJob.findMany({
      where: { nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: this.pacing.batchSize,
    });

    for (const job of due) {
      const payload = job.payload as unknown as NotificationPayload;
      const outcome = await this.transport.deliver(settings, payload);

      if (outcome.ok) {
        await this.prisma.notificationDeliveryJob.delete({ where: { id: job.id } });
        continue;
      }

      const attempts = job.attempts + 1;

      if (attempts >= this.pacing.maxAttempts) {
        // Given up on, and said out loud. A notification silently discarded
        // after ten attempts is worse than one that never existed, because the
        // operator believes the channel works.
        await this.prisma.notificationDeliveryJob.delete({ where: { id: job.id } });
        this.logger.error(
          `Gave up delivering ${job.transition} for ${job.conditionKey} after ${String(attempts)} attempts: ${outcome.error ?? 'unknown error'}`,
        );
        continue;
      }

      const backoff = Math.min(
        this.pacing.baseBackoffMs * 2 ** (attempts - 1),
        this.pacing.maxBackoffMs,
      );

      await this.prisma.notificationDeliveryJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: outcome.error,
          nextAttemptAt: new Date(now.getTime() + backoff),
        },
      });
    }
  }

  private async webhookSettings(): Promise<NotificationWebhookSettings | null> {
    const resolved = await this.store.resolve<NotificationWebhookSettings>(
      'notifications.webhook',
      () => null,
    );
    return resolved.source === 'unset' ? null : (resolved.config ?? null);
  }
}
