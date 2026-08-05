import { Logger } from '@nestjs/common';
import type { IAuditTransport } from '@nexuspuppet/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditDeliveryOutbox } from './audit-delivery.outbox';
import { AuditDeliveryWorker } from './audit-delivery.worker';

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
});
