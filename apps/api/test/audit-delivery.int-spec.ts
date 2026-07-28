import type { AuthenticatedPrincipal } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { AuditDeliveryOutbox } from '../src/auth/audit-delivery.outbox';

/**
 * The audit delivery outbox, against a REAL PostgreSQL.
 *
 * The whole reason this exists is what survives a rollback, and that cannot be
 * verified against a mock — a mock confirms whatever the code already believes.
 *
 * The property under test: **there is no committed audit record without a
 * queued delivery, and no queued delivery for a change that did not commit.**
 * An external system that is told about changes that never happened is worse
 * than one that is merely behind.
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

describe('audit delivery outbox (integration)', () => {
  let prisma: PrismaService;
  let outbox: AuditDeliveryOutbox;
  let sink: PrismaAuditSink;

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

    await prisma.auditDeliveryJob.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.create({
      data: {
        id: ACTOR.userId,
        email: ACTOR.email,
        displayName: ACTOR.displayName,
        role: 'ADMIN',
        passwordHash: 'x',
        isActive: true,
      },
    });
  });

  const record = (action: string) => ({
    actorUserId: ACTOR.userId,
    actorEmail: ACTOR.email,
    action,
    entityType: 'NodeGroup',
    entityId: '11111111-1111-1111-1111-111111111111',
    before: null,
    after: { name: 'web-tier' },
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
  });

  /** What a composing enterprise sink does: delegate the write, then enqueue. */
  const writeAndEnqueue = (action: string) =>
    prisma.$transaction(async (tx) => {
      await sink.record(record(action), tx);
      const row = await tx.auditLog.findFirstOrThrow({
        where: { action },
        orderBy: { createdAt: 'desc' },
      });
      await outbox.enqueue(tx, row.id);
      return row.id;
    });

  describe('the transactional guarantee', () => {
    it('commits the delivery job with the audit record', async () => {
      const id = await writeAndEnqueue('nodegroup.create');

      expect(await prisma.auditLog.count()).toBe(1);
      const job = await prisma.auditDeliveryJob.findUniqueOrThrow({ where: { auditLogId: id } });
      expect(job.attempts).toBe(0);
    });

    /**
     * The failure the outbox exists to prevent, in reverse: if the job could
     * commit while the change rolled back, the SIEM would be told about
     * something that never happened.
     */
    it('leaves NOTHING behind when the transaction fails', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await sink.record(record('nodegroup.delete'), tx);
          const row = await tx.auditLog.findFirstOrThrow({ where: { action: 'nodegroup.delete' } });
          await outbox.enqueue(tx, row.id);
          throw new Error('change aborted');
        }),
      ).rejects.toThrow('change aborted');

      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.auditDeliveryJob.count()).toBe(0);
    });

    /**
     * A retried operation must not queue the same record twice. The SIEM would
     * survive a duplicate, but a counter that drifts upward on every retry makes
     * the queue depth useless as a health signal.
     */
    it('queues a record at most once', async () => {
      const id = await writeAndEnqueue('nodegroup.update');
      await prisma.$transaction((tx) => outbox.enqueue(tx, id));
      await prisma.$transaction((tx) => outbox.enqueue(tx, id));

      expect(await prisma.auditDeliveryJob.count()).toBe(1);
    });

    /**
     * A second enqueue must not reset a backoff that is mid-retry, or a sink
     * failing every attempt would be retried immediately and forever.
     */
    it('does not reset the schedule of a job already backing off', async () => {
      const id = await writeAndEnqueue('nodegroup.rank');
      const future = new Date(Date.now() + 600_000);
      await prisma.auditDeliveryJob.update({
        where: { auditLogId: id },
        data: { attempts: 3, nextAttemptAt: future },
      });

      await prisma.$transaction((tx) => outbox.enqueue(tx, id));

      const job = await prisma.auditDeliveryJob.findUniqueOrThrow({ where: { auditLogId: id } });
      expect(job.attempts).toBe(3);
      expect(job.nextAttemptAt.getTime()).toBe(future.getTime());
    });
  });

  describe('claiming work', () => {
    it('returns the audit record alongside the job', async () => {
      await writeAndEnqueue('nodegroup.create');

      const claimed = await prisma.$transaction((tx) => outbox.claim(tx, 10));

      expect(claimed).toHaveLength(1);
      // The enterprise layer has no database access, so everything it needs to
      // build a payload has to arrive here.
      expect(claimed[0]?.entry.action).toBe('nodegroup.create');
      expect(claimed[0]?.entry.actorEmail).toBe(ACTOR.email);
      expect(claimed[0]?.entry.after).toEqual({ name: 'web-tier' });
      expect(claimed[0]?.entry.ipAddress).toBe('10.0.0.1');
    });

    it('respects the batch size', async () => {
      for (const n of ['a', 'b', 'c', 'd', 'e']) await writeAndEnqueue(`action.${n}`);

      const claimed = await prisma.$transaction((tx) => outbox.claim(tx, 2));

      expect(claimed).toHaveLength(2);
      expect(await prisma.auditDeliveryJob.count()).toBe(3);
    });

    it('does not claim a job whose backoff has not elapsed', async () => {
      const id = await writeAndEnqueue('nodegroup.create');
      await prisma.auditDeliveryJob.update({
        where: { auditLogId: id },
        data: { nextAttemptAt: new Date(Date.now() + 600_000) },
      });

      const claimed = await prisma.$transaction((tx) => outbox.claim(tx, 10));

      expect(claimed).toHaveLength(0);
      expect(await prisma.auditDeliveryJob.count()).toBe(1);
    });

    /**
     * Claim-by-DELETE, so a batch that fails mid-flight must put its work back
     * rather than lose it. This is the same discipline the ENC outbox uses and
     * the reason claiming runs on the caller's transaction.
     */
    it('restores claimed jobs when the batch rolls back', async () => {
      await writeAndEnqueue('nodegroup.create');

      await expect(
        prisma.$transaction(async (tx) => {
          await outbox.claim(tx, 10);
          throw new Error('delivery batch aborted');
        }),
      ).rejects.toThrow('delivery batch aborted');

      expect(await prisma.auditDeliveryJob.count()).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('reschedules a failed delivery with a backoff and the reason', async () => {
      await writeAndEnqueue('nodegroup.create');
      const claimed = await prisma.$transaction((tx) => outbox.claim(tx, 10));
      expect(await prisma.auditDeliveryJob.count()).toBe(0);

      await outbox.reschedule(claimed[0]!, 'connect ECONNREFUSED 10.0.0.9:514', 30_000);

      const job = await prisma.auditDeliveryJob.findUniqueOrThrow({
        where: { auditLogId: claimed[0]!.auditLogId },
      });
      expect(job.attempts).toBe(1);
      expect(job.lastError).toContain('ECONNREFUSED');
      expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    /**
     * No attempt limit, deliberately. A dropped audit record is a compliance
     * gap, and an operator would rather find a backlog on Monday than discover
     * that events were discarded quietly while the SIEM was down.
     */
    it('keeps retrying rather than giving up', async () => {
      await writeAndEnqueue('nodegroup.create');

      for (let i = 0; i < 25; i += 1) {
        await prisma.auditDeliveryJob.updateMany({ data: { nextAttemptAt: new Date() } });
        const claimed = await prisma.$transaction((tx) => outbox.claim(tx, 10));
        expect(claimed).toHaveLength(1);
        await outbox.reschedule(claimed[0]!, 'still down', 0);
      }

      const job = await prisma.auditDeliveryJob.findFirstOrThrow();
      expect(job.attempts).toBe(25);
    });

    /**
     * Retention can remove the record while its delivery is in flight. There is
     * then nothing to reschedule against, and the worker must not crash over it.
     */
    it('survives the audit record being pruned mid-flight', async () => {
      const id = await writeAndEnqueue('nodegroup.create');
      const claimed = await prisma.$transaction((tx) => outbox.claim(tx, 10));
      await prisma.auditLog.delete({ where: { id } });

      await expect(outbox.reschedule(claimed[0]!, 'gone', 1000)).resolves.toBeUndefined();
      expect(await prisma.auditDeliveryJob.count()).toBe(0);
    });

    /** Deleting an audit record takes its undelivered job with it. */
    it('cascades when the audit record is removed', async () => {
      const id = await writeAndEnqueue('nodegroup.create');
      expect(await prisma.auditDeliveryJob.count()).toBe(1);

      await prisma.auditLog.delete({ where: { id } });

      expect(await prisma.auditDeliveryJob.count()).toBe(0);
    });
  });

  describe('observability', () => {
    it('reports how many records are waiting', async () => {
      expect(await outbox.depth()).toBe(0);
      await writeAndEnqueue('a');
      await writeAndEnqueue('b');
      // A stalled SIEM shows up as a rising depth rather than as silence.
      expect(await outbox.depth()).toBe(2);
    });
  });
});
