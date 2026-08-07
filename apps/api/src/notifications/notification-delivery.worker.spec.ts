import type { NotificationPayload, NotificationWebhookSettings } from '@nexuspuppet/contracts';
import {
  NotificationDeliveryWorker,
  DEFAULT_DELIVERY_PACING,
  type DeliveryPacing,
} from './notification-delivery.worker';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsStore } from '../settings/settings.store';
import type { NotificationWebhookTransport } from './notification-webhook.transport';

const NOW = new Date('2026-08-07T12:00:00.000Z');

const JOB = {
  id: 'job-1',
  conditionKey: 'puppetdb.unreachable',
  transition: 'opened',
  payload: {
    transition: 'opened',
    key: 'puppetdb.unreachable',
    kind: 'puppetdb.unreachable',
    severity: 'warning',
    summary: 'PuppetDB is not answering.',
    at: NOW.toISOString(),
  } satisfies NotificationPayload,
  attempts: 0,
  nextAttemptAt: NOW,
  lastError: null,
  createdAt: NOW,
};

const SETTINGS: NotificationWebhookSettings = {
  url: 'https://collector.example.test/hook',
  timeoutMs: 10_000,
};

function build(options: {
  jobs?: unknown[];
  configured?: boolean;
  deliver?: jest.Mock;
  pacing?: Partial<DeliveryPacing>;
}) {
  const findMany = jest.fn().mockResolvedValue(options.jobs ?? []);
  const del = jest.fn().mockResolvedValue(undefined);
  const update = jest.fn().mockResolvedValue(undefined);

  const prisma = {
    notificationDeliveryJob: { findMany, delete: del, update },
  } as unknown as PrismaService;

  const store = {
    resolve: jest
      .fn()
      .mockResolvedValue(
        options.configured === false
          ? { source: 'unset', config: null }
          : { source: 'database', config: SETTINGS },
      ),
  } as unknown as SettingsStore;

  const deliver = options.deliver ?? jest.fn().mockResolvedValue({ ok: true, error: null });
  const transport = { deliver } as unknown as NotificationWebhookTransport;

  const worker = new NotificationDeliveryWorker(prisma, store, transport, {
    ...DEFAULT_DELIVERY_PACING,
    ...options.pacing,
  });

  return { worker, findMany, del, update, deliver };
}

describe('NotificationDeliveryWorker', () => {
  it('delivers a due job and removes it', async () => {
    const { worker, deliver, del } = build({ jobs: [JOB] });

    await worker.drain(NOW);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ where: { id: 'job-1' } });
  });

  it('sends the payload captured at enqueue, not a fresh lookup', async () => {
    const { worker, deliver } = build({ jobs: [JOB] });

    await worker.drain(NOW);

    expect(deliver.mock.calls[0]?.[1]).toEqual(JOB.payload);
  });

  /*
   * An operator who configures a webhook after a bad night should receive what
   * they missed. A queue quietly emptied by the ABSENCE of configuration is
   * indistinguishable from one that was delivered.
   */
  it('leaves the queue alone when no destination is configured', async () => {
    const { worker, findMany, del, deliver } = build({ jobs: [JOB], configured: false });

    await worker.drain(NOW);

    expect(findMany).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('backs off after a failure rather than spinning', async () => {
    const deliver = jest.fn().mockResolvedValue({ ok: false, error: 'connection refused' });
    const { worker, update, del } = build({ jobs: [JOB], deliver });

    await worker.drain(NOW);

    expect(del).not.toHaveBeenCalled();
    const data = update.mock.calls[0]?.[0] as { data: { attempts: number; nextAttemptAt: Date } };
    expect(data.data.attempts).toBe(1);
    expect(data.data.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('caps the backoff so a long outage still retries', async () => {
    const deliver = jest.fn().mockResolvedValue({ ok: false, error: 'nope' });
    const { worker, update } = build({
      jobs: [{ ...JOB, attempts: 8 }],
      deliver,
      pacing: { maxBackoffMs: 900_000, maxAttempts: 100 },
    });

    await worker.drain(NOW);

    const data = update.mock.calls[0]?.[0] as { data: { nextAttemptAt: Date } };
    expect(data.data.nextAttemptAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(900_000);
  });

  /*
   * A notification about a condition from three days ago is noise, not
   * information — which is why this worker gives up and the audit one does
   * not. Giving up SILENTLY would be worse than never having sent it, because
   * the operator believes the channel works.
   */
  it('gives up after the attempt ceiling, and does not do it quietly', async () => {
    const deliver = jest.fn().mockResolvedValue({ ok: false, error: 'still down' });
    const { worker, del } = build({
      jobs: [{ ...JOB, attempts: 9 }],
      deliver,
      pacing: { maxAttempts: 10 },
    });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);

    await worker.drain(NOW);

    expect(del).toHaveBeenCalledWith({ where: { id: 'job-1' } });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Gave up delivering'));
  });

  it('delivers each due job in the batch', async () => {
    const { worker, deliver } = build({
      jobs: [JOB, { ...JOB, id: 'job-2' }, { ...JOB, id: 'job-3' }],
    });

    await worker.drain(NOW);

    expect(deliver).toHaveBeenCalledTimes(3);
  });
});
