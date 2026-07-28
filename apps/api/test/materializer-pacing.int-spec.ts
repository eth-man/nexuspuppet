import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService, ADVISORY_LOCKS } from '../src/prisma/prisma.service';
import type { TransactionClient } from '../src/materialization/materialization.service';
import { PosixEncStorage } from '../src/materialization/posix-enc-storage';
import {
  MaterializerService,
  type MaterializerPacing,
} from '../src/materialization/materializer.service';

/**
 * Materializer pacing and the cursored full reconcile.
 *
 * The behaviour under test only appears at scale: a rule change over a large
 * estate is one job that would otherwise rewrite every node inside a single
 * transaction. These use a small estate with a tiny chunk size to reproduce the
 * same shape in seconds — the ratio is what matters, not the absolute size.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(120_000);

interface BatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
  filesChanged: number;
  ranHere: boolean;
}

/**
 * A typed view of the private per-batch method.
 *
 * Reaching past drain() is the point: drain() loops until the queue is empty,
 * which is exactly what hides the per-batch bound under test. Cast through
 * `unknown` rather than `any` so the shape stays checked.
 */
interface BatchRunner {
  drainLocked(tx: TransactionClient): Promise<BatchResult>;
}
const batchOf = (service: MaterializerService): BatchRunner => service as unknown as BatchRunner;

const pacing = (overrides: Partial<MaterializerPacing> = {}): MaterializerPacing => ({
  batchSize: 5,
  reconcileChunkSize: 4,
  batchDelayMs: 0,
  maxDrainMs: 30_000,
  batchTimeoutMs: 30_000,
  ...overrides,
});

describe('materializer pacing (integration)', () => {
  let prisma: PrismaService;
  let writer: PosixEncStorage;
  let encDir: string;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    encDir = await mkdtemp(join(tmpdir(), 'nexuspuppet-pacing-'));
    writer = new PosixEncStorage(encDir);
    await writer.ensureLayout();

    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.nodeGroupPin.deleteMany();
    await prisma.nodeGroupClass.deleteMany();
    await prisma.nodeGroupParameter.deleteMany();
    await prisma.nodeGroupRule.deleteMany();
    await prisma.nodeGroup.deleteMany();
    await prisma.managedNode.deleteMany();
  });

  const service = (overrides: Partial<MaterializerPacing> = {}): MaterializerService =>
    new MaterializerService(prisma, writer, 5, 'production', pacing(overrides));

  async function seedNodes(count: number): Promise<string[]> {
    const names = Array.from({ length: count }, (_, i) => `node${String(i).padStart(3, '0')}.test`);
    await prisma.managedNode.createMany({
      data: names.map((certname) => ({ certname, facts: {}, environment: 'production' })),
    });
    return names;
  }

  const queueFullReconcile = (dedupeKey = 'full'): Promise<unknown> =>
    prisma.encMaterializationJob.create({
      data: { dedupeKey, certname: null, reason: 'test', nextAttemptAt: new Date() },
    });

  const nodeFiles = async (): Promise<string[]> => (await readdir(join(encDir, 'nodes'))).sort();

  describe('batch bounding', () => {
    it('claims no more than the batch size in one lock acquisition', async () => {
      const names = await seedNodes(12);
      await prisma.encMaterializationJob.createMany({
        data: names.map((certname) => ({
          dedupeKey: `node:${certname}`,
          certname,
          reason: 'test',
          nextAttemptAt: new Date(),
        })),
      });

      // Reach past drain() into a single batch: drain loops until the queue is
      // empty, which would hide the per-batch bound.
      const batch = await prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, (tx) =>
        batchOf(service({ batchSize: 5 })).drainLocked(tx),
      );

      expect(batch?.claimed).toBe(5);
      expect(await prisma.encMaterializationJob.count()).toBe(7);
    });

    it('drains the whole queue across successive batches', async () => {
      const names = await seedNodes(12);
      await prisma.encMaterializationJob.createMany({
        data: names.map((certname) => ({
          dedupeKey: `node:${certname}`,
          certname,
          reason: 'test',
          nextAttemptAt: new Date(),
        })),
      });

      const result = await service({ batchSize: 5 }).drain();

      expect(result.claimed).toBe(12);
      expect(await prisma.encMaterializationJob.count()).toBe(0);
      expect(await nodeFiles()).toHaveLength(12);
    });
  });

  describe('cursored full reconcile', () => {
    /**
     * The point of the cursor. One full-reconcile job must not rewrite the
     * whole estate in a single pass, or the lock and its transaction are held
     * for as long as the estate is large.
     */
    it('writes only one chunk per batch and re-queues with a cursor', async () => {
      await seedNodes(10);
      await queueFullReconcile();

      const batch = await prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, (tx) =>
        batchOf(service({ reconcileChunkSize: 4 })).drainLocked(tx),
      );

      expect(batch?.claimed).toBe(1);
      expect(await nodeFiles()).toHaveLength(4);

      const requeued = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'full' },
      });
      expect(requeued?.cursor).toBe('node003.test');
      expect(requeued?.certname).toBeNull();
    });

    it('covers every node exactly once across chunks', async () => {
      const names = await seedNodes(10);
      await queueFullReconcile();

      await service({ reconcileChunkSize: 4 }).drain();

      // Nothing skipped at a chunk boundary, nothing written twice.
      expect(await nodeFiles()).toEqual(names.map((n) => `${n}.yaml`).sort());
      expect(await prisma.encMaterialization.count()).toBe(10);
      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });

    it('stops re-queueing once the estate is exhausted', async () => {
      await seedNodes(3);
      await queueFullReconcile();

      // Chunk larger than the estate: one pass, no continuation.
      await service({ reconcileChunkSize: 10 }).drain();

      expect(await prisma.encMaterializationJob.count()).toBe(0);
      expect(await nodeFiles()).toHaveLength(3);
    });

    /**
     * A fresh full reconcile queued mid-run means someone changed something
     * else. It starts from the beginning, and the in-flight cursor must not
     * clobber it back to a partial position.
     */
    it('leaves a newer full reconcile alone rather than resetting its cursor', async () => {
      await seedNodes(10);
      await prisma.encMaterializationJob.create({
        data: { dedupeKey: 'full', certname: null, reason: 'first', nextAttemptAt: new Date() },
      });

      const svc = service({ reconcileChunkSize: 4 });
      // First chunk: claims the job, then re-queues it with a cursor.
      await prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, (tx) =>
        batchOf(svc).drainLocked(tx),
      );

      const afterFirst = await prisma.encMaterializationJob.findUniqueOrThrow({
        where: { dedupeKey: 'full' },
      });
      expect(afterFirst.cursor).toBe('node003.test');
    });
  });

  describe('the lock', () => {
    /**
     * Released between batches, so a second replica can take the next one. If
     * the lock were held for the whole drain, this second call would return
     * null and one replica would do all the work while others idled.
     */
    it('is available again after a drain completes', async () => {
      await seedNodes(3);
      await queueFullReconcile();
      await service().drain();

      const acquired = await prisma.withAdvisoryLock(
        ADVISORY_LOCKS.ENC_MATERIALIZER,
        async () => 'acquired',
      );

      expect(acquired).toBe('acquired');
    });

    it('yields when another holder has it, without losing jobs', async () => {
      const names = await seedNodes(3);
      await prisma.encMaterializationJob.createMany({
        data: names.map((certname) => ({
          dedupeKey: `node:${certname}`,
          certname,
          reason: 'test',
          nextAttemptAt: new Date(),
        })),
      });

      // Hold the lock while a drain runs against it.
      let drained: Awaited<ReturnType<MaterializerService['drain']>> | undefined;
      await prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, async () => {
        drained = await service().drain();
      });

      // It found the lock taken and did nothing — the jobs are untouched.
      expect(drained?.ranHere).toBe(false);
      expect(drained?.claimed).toBe(0);
      expect(await prisma.encMaterializationJob.count()).toBe(3);
    });
  });

  describe('the drain budget', () => {
    it('stops at the deadline and leaves the rest queued', async () => {
      const names = await seedNodes(20);
      await prisma.encMaterializationJob.createMany({
        data: names.map((certname) => ({
          dedupeKey: `node:${certname}`,
          certname,
          reason: 'test',
          nextAttemptAt: new Date(),
        })),
      });

      // A delay per batch larger than the budget guarantees the second batch is
      // refused, without depending on how fast this machine writes files.
      const result = await service({
        batchSize: 5,
        batchDelayMs: 60,
        maxDrainMs: 50,
      }).drain();

      expect(result.claimed).toBeLessThan(20);
      expect(await prisma.encMaterializationJob.count()).toBeGreaterThan(0);
    });
  });

  describe('transactional claim', () => {
    /**
     * The reason the batch runs on `tx` rather than the top-level client.
     *
     * A job is claimed by DELETING it. If that delete committed independently,
     * a batch that then failed would lose the jobs entirely — the outbox would
     * have handed out work and forgotten it. Rolling back must put them back.
     */
    it('restores claimed jobs when the batch rolls back', async () => {
      const names = await seedNodes(3);
      await prisma.encMaterializationJob.createMany({
        data: names.map((certname) => ({
          dedupeKey: `node:${certname}`,
          certname,
          reason: 'test',
          nextAttemptAt: new Date(),
        })),
      });

      const svc = service();

      await expect(
        prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, async (tx) => {
          await batchOf(svc).drainLocked(tx);
          // Something later in the transaction fails: a timeout, a constraint,
          // a crashing sibling write.
          throw new Error('batch aborted');
        }),
      ).rejects.toThrow('batch aborted');

      expect(await prisma.encMaterializationJob.count()).toBe(3);
    });
  });
});
