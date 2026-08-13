import { Logger } from '@nestjs/common';
import type { IAuditTransport } from '@nexuspuppet/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditDeliveryOutbox, PendingDelivery } from './audit-delivery.outbox';
import { AuditDeliveryWorker, LAST_DELIVERY_KEY } from './audit-delivery.worker';

describe('AuditDeliveryWorker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps ticking while unconfigured, so a transport activated from the console drains without a restart', async () => {
    // `configured` flips mid-test, the way a live settings change flips it
    // under a real transport (ADR-0016 §4).
    let configured = false;
    const transport = {
      name: 'syslog',
      get configured(): boolean {
        return configured;
      },
      deliver: async (): Promise<void> => undefined,
    } as IAuditTransport;

    const outbox = {
      depth: async (): Promise<number> => 0,
      claim: async (): Promise<[]> => [],
      complete: async (): Promise<number> => 0,
      reschedule: async (): Promise<void> => undefined,
    } as unknown as AuditDeliveryOutbox;

    const withAdvisoryLock = jest.fn(
      async <T>(_lock: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    );
    const prisma = { withAdvisoryLock } as unknown as PrismaService;

    const worker = new AuditDeliveryWorker(prisma, outbox, transport, {
      intervalMs: 1_000,
      batchSize: 10,
      leaseMs: 1_000,
      backoffMs: 1,
      maxBackoffMs: 2,
    });

    worker.onModuleInit();

    // Unconfigured: the tick runs but leaves the queue untouched.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(withAdvisoryLock).not.toHaveBeenCalled();

    // The operator activates a transport; the next tick drains, no restart.
    configured = true;
    await jest.advanceTimersByTimeAsync(1_000);
    expect(withAdvisoryLock).toHaveBeenCalled();

    worker.onModuleDestroy();
  });

  it('records the last delivery outcome, success and failure alike', async () => {
    const pending: PendingDelivery = {
      jobId: 'job-1',
      auditLogId: 'log-1',
      attempts: 0,
      entry: {
        actorUserId: null,
        actorEmail: 'op@example.test',
        action: 'test.action',
        entityType: 'Test',
        entityId: null,
        entityLabel: null,
        requestId: null,
        before: null,
        after: null,
        ipAddress: null,
        userAgent: null,
        createdAt: new Date('2026-08-05T10:00:00Z'),
      },
    };

    let failNext = false;
    const transport = {
      name: 'syslog',
      configured: true,
      deliver: async (): Promise<void> => {
        if (failNext) throw new Error('connect ECONNREFUSED');
      },
    } as IAuditTransport;

    const outbox = {
      depth: async (): Promise<number> => 1,
      claim: async (): Promise<PendingDelivery[]> => [pending],
      complete: async (): Promise<number> => 1,
      reschedule: async (): Promise<void> => undefined,
    } as unknown as AuditDeliveryOutbox;

    const outcomes: unknown[] = [];
    const prisma = {
      withAdvisoryLock: async <T>(_lock: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn({}),
      appSetting: {
        upsert: async (args: { create: { value: unknown } }): Promise<void> => {
          outcomes.push(args.create.value);
        },
      },
    } as unknown as PrismaService;

    const worker = new AuditDeliveryWorker(prisma, outbox, transport, {
      intervalMs: 0,
      batchSize: 10,
      leaseMs: 1_000,
      backoffMs: 1,
      maxBackoffMs: 2,
    });

    await worker.drain();
    expect(outcomes.at(-1)).toMatchObject({ ok: true, delivered: 1, error: null });

    failNext = true;
    await worker.drain();
    expect(outcomes.at(-1)).toMatchObject({ ok: false, delivered: 0 });
    expect((outcomes.at(-1) as { error: string }).error).toContain('ECONNREFUSED');
    expect(LAST_DELIVERY_KEY).toBe('audit.delivery.lastOutcome');
  });
});
