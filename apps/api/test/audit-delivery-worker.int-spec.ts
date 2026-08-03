import { Logger } from '@nestjs/common';
import type {
  AuditDeliveryEntry,
  AuthenticatedPrincipal,
  IAuditTransport,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { AuditDeliveryOutbox } from '../src/auth/audit-delivery.outbox';
import {
  AuditDeliveryWorker,
  NoopAuditTransport,
  type AuditDeliveryPacing,
} from '../src/auth/audit-delivery.worker';
import { roleIdFor } from './support/roles';

/**
 * The delivery worker, against a REAL PostgreSQL.
 *
 * The property under test is the one an auditor cares about: **a record is
 * removed from the queue only once something outside NexusPuppet has accepted
 * it.** Everything else — backoff, leases, single-flight — exists to make that
 * true when the network, the SIEM or this process misbehaves.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const ACTOR: AuthenticatedPrincipal = {
  userId: '00000000-0000-0000-0000-0000000000aa',
  email: 'ops@example.com',
  displayName: 'Ops',
  role: 'ADMIN',
  authSource: 'local',
};

jest.setTimeout(30_000);

/** Records what it was asked to send, and fails on demand. */
class RecordingTransport implements IAuditTransport {
  readonly name = 'recording';
  configured = true;
  batches: AuditDeliveryEntry[][] = [];
  failWith: string | null = null;

  async deliver(entries: readonly AuditDeliveryEntry[]): Promise<void> {
    if (this.failWith !== null) throw new Error(this.failWith);
    this.batches.push([...entries]);
  }

  get delivered(): AuditDeliveryEntry[] {
    return this.batches.flat();
  }
}

const pacing = (over: Partial<AuditDeliveryPacing> = {}): AuditDeliveryPacing => ({
  intervalMs: 0, // tests drive drain() directly
  batchSize: 100,
  leaseMs: 60_000,
  backoffMs: 1_000,
  maxBackoffMs: 3_600_000,
  ...over,
});

describe('audit delivery worker (integration)', () => {
  let prisma: PrismaService;
  let outbox: AuditDeliveryOutbox;
  let sink: PrismaAuditSink;
  let transport: RecordingTransport;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    outbox = new AuditDeliveryOutbox(prisma);
    sink = new PrismaAuditSink(prisma);
    transport = new RecordingTransport();

    await prisma.auditDeliveryJob.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.create({
      data: {
        id: ACTOR.userId,
        email: ACTOR.email,
        displayName: ACTOR.displayName,
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        passwordHash: 'x',
        isActive: true,
      },
    });
  });

  const worker = (t: IAuditTransport = transport, over: Partial<AuditDeliveryPacing> = {}) =>
    new AuditDeliveryWorker(prisma, outbox, t, pacing(over));

  /** What a composing enterprise sink does: delegate the write, then enqueue. */
  const emit = (action: string) =>
    prisma.$transaction(async (tx) => {
      await sink.record(
        {
          actorUserId: ACTOR.userId,
          actorEmail: ACTOR.email,
          action,
          entityType: 'NodeGroup',
          entityId: '11111111-1111-1111-1111-111111111111',
          before: null,
          after: { name: 'web-tier' },
          ipAddress: '10.0.0.1',
          userAgent: 'jest',
        },
        tx,
      );
      const row = await tx.auditLog.findFirstOrThrow({
        where: { action },
        orderBy: { createdAt: 'desc' },
      });
      await outbox.enqueue(tx, row.id);
      return row.id;
    });

  describe('delivering', () => {
    it('sends queued records and removes them once accepted', async () => {
      await emit('nodegroup.create');
      await emit('nodegroup.update');

      const result = await worker().drain();

      expect(result.delivered).toBe(2);
      expect(transport.delivered).toHaveLength(2);
      expect(await prisma.auditDeliveryJob.count()).toBe(0);
    });

    /**
     * The transport lives in the enterprise layer and has no database access,
     * so everything it needs to build a payload has to arrive in the entry.
     */
    it('hands the transport a complete, serialisable record', async () => {
      const id = await emit('nodegroup.create');

      await worker().drain();

      const entry = transport.delivered[0];
      expect(entry?.auditLogId).toBe(id);
      expect(entry?.action).toBe('nodegroup.create');
      expect(entry?.actorEmail).toBe(ACTOR.email);
      expect(entry?.after).toEqual({ name: 'web-tier' });
      expect(entry?.ipAddress).toBe('10.0.0.1');
      // ISO-8601, not a Date: this is about to be serialised by a transport
      // that must not depend on core's storage types.
      expect(typeof entry?.createdAt).toBe('string');
      expect(() => new Date(entry?.createdAt ?? '').toISOString()).not.toThrow();
    });

    it('respects the batch size and drains the rest on the next pass', async () => {
      for (const n of ['a', 'b', 'c']) await emit(`action.${n}`);

      const first = await worker(transport, { batchSize: 2 }).drain();
      expect(first.delivered).toBe(2);

      const second = await worker(transport, { batchSize: 2 }).drain();
      expect(second.delivered).toBe(1);
      expect(await prisma.auditDeliveryJob.count()).toBe(0);
    });

    it('does nothing when the queue is empty', async () => {
      const result = await worker().drain();

      expect(result).toEqual({ delivered: 0, failed: 0, ranHere: true });
      expect(transport.batches).toHaveLength(0);
    });
  });

  describe('when delivery fails', () => {
    /** The guarantee. A record survives a transport that refuses it. */
    it('keeps the record queued', async () => {
      await emit('nodegroup.create');
      transport.failWith = 'connect ECONNREFUSED 10.0.0.9:514';

      const result = await worker().drain();

      expect(result.failed).toBe(1);
      expect(result.delivered).toBe(0);
      expect(await prisma.auditDeliveryJob.count()).toBe(1);
    });

    it('records why, for the operator', async () => {
      await emit('nodegroup.create');
      transport.failWith = 'connect ECONNREFUSED 10.0.0.9:514';

      await worker().drain();

      const job = await prisma.auditDeliveryJob.findFirstOrThrow();
      expect(job.attempts).toBe(1);
      expect(job.lastError).toContain('ECONNREFUSED');
    });

    /**
     * Backoff doubles per attempt, so a SIEM that is down for maintenance is not
     * hammered — but recovery stays unattended because the cap is an hour.
     */
    it('backs off exponentially', async () => {
      await emit('nodegroup.create');
      transport.failWith = 'down';

      const before = Date.now();
      await worker(transport, { backoffMs: 10_000 }).drain();
      const first = await prisma.auditDeliveryJob.findFirstOrThrow();
      // attempts 0 -> 1: 10s
      expect(first.nextAttemptAt.getTime() - before).toBeGreaterThan(5_000);

      await prisma.auditDeliveryJob.updateMany({ data: { nextAttemptAt: new Date() } });
      const second = Date.now();
      await worker(transport, { backoffMs: 10_000 }).drain();
      const job = await prisma.auditDeliveryJob.findFirstOrThrow();
      // attempts 1 -> 2: 20s
      expect(job.attempts).toBe(2);
      expect(job.nextAttemptAt.getTime() - second).toBeGreaterThan(15_000);
    });

    it('caps the backoff', async () => {
      await emit('nodegroup.create');
      transport.failWith = 'down';
      await prisma.auditDeliveryJob.updateMany({ data: { attempts: 40 } });

      const before = Date.now();
      await worker(transport, { backoffMs: 1_000, maxBackoffMs: 60_000 }).drain();

      const job = await prisma.auditDeliveryJob.findFirstOrThrow();
      // 1000 * 2^40 would be centuries; the cap is what keeps it recoverable.
      expect(job.nextAttemptAt.getTime() - before).toBeLessThanOrEqual(61_000);
    });

    it('delivers successfully once the transport recovers', async () => {
      await emit('nodegroup.create');
      transport.failWith = 'down';
      await worker().drain();

      transport.failWith = null;
      await prisma.auditDeliveryJob.updateMany({ data: { nextAttemptAt: new Date() } });
      const result = await worker().drain();

      expect(result.delivered).toBe(1);
      expect(await prisma.auditDeliveryJob.count()).toBe(0);
    });

    /**
     * The whole batch goes back, not just part of it. Partial success is not
     * detectable through the transport interface, and re-sending a record the
     * SIEM already has is harmless — dropping one is not.
     */
    it('returns the entire batch', async () => {
      for (const n of ['a', 'b', 'c']) await emit(`action.${n}`);
      transport.failWith = 'down';

      await worker().drain();

      expect(await prisma.auditDeliveryJob.count()).toBe(3);
      const jobs = await prisma.auditDeliveryJob.findMany();
      expect(jobs.every((j) => j.attempts === 1)).toBe(true);
    });
  });

  describe('with no transport configured', () => {
    /**
     * The failure mode that would be worst: a worker that drains records into
     * nothing and deletes them. Core's default forwards nowhere, so it must
     * leave the queue completely alone.
     */
    it('never touches the queue', async () => {
      await emit('nodegroup.create');

      const result = await worker(new NoopAuditTransport()).drain();

      expect(result).toEqual({ delivered: 0, failed: 0, ranHere: false });
      expect(await prisma.auditDeliveryJob.count()).toBe(1);
      const job = await prisma.auditDeliveryJob.findFirstOrThrow();
      // Not even an attempt recorded: nothing was tried.
      expect(job.attempts).toBe(0);
    });

    it('reports a backlog once rather than every tick', async () => {
      await emit('nodegroup.create');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const w = worker(new NoopAuditTransport());

      try {
        await w.drain();
        await w.drain();
        await w.drain();

        const backlog = warn.mock.calls.filter((c) => String(c[0]).includes('queued for delivery'));
        expect(backlog).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the advisory lock', () => {
    /**
     * One replica drains at a time, the same arrangement the ENC materializer
     * uses. Without it, two workers would send the same batch to the SIEM.
     */
    it('yields when another holder has it, without losing work', async () => {
      await emit('nodegroup.create');

      const { ADVISORY_LOCKS } = await import('../src/prisma/prisma.service');
      let result: Awaited<ReturnType<AuditDeliveryWorker['drain']>> | undefined;
      await prisma.withAdvisoryLock(ADVISORY_LOCKS.AUDIT_DELIVERY, async () => {
        result = await worker().drain();
      });

      expect(result?.ranHere).toBe(false);
      expect(transport.batches).toHaveLength(0);
      expect(await prisma.auditDeliveryJob.count()).toBe(1);
    });

    it('is available again after a drain', async () => {
      await emit('nodegroup.create');
      await worker().drain();

      const { ADVISORY_LOCKS } = await import('../src/prisma/prisma.service');
      const acquired = await prisma.withAdvisoryLock(
        ADVISORY_LOCKS.AUDIT_DELIVERY,
        async () => 'acquired',
      );
      expect(acquired).toBe('acquired');
    });
  });
});
