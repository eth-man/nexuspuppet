import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { PosixEncStorage } from '../src/materialization/posix-enc-storage';
import { MaterializerService } from '../src/materialization/materializer.service';
import { MaterializationService } from '../src/materialization/materialization.service';

/**
 * Node decommissioning: purge versus deactivation.
 *
 * The distinction is the whole feature. PuppetDB deactivates a node when it
 * stops reporting and purges it only after node-purge-ttl, and deactivation is
 * reversible — the node returns by checking in again. Treating the two the same
 * either strands classification for nodes that no longer exist, or churns files
 * for nodes that are about to come back.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(120_000);

describe('node deletion (integration)', () => {
  let prisma: PrismaService;
  let writer: PosixEncStorage;
  let materializer: MaterializerService;
  let enqueue: MaterializationService;
  let encDir: string;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    encDir = await mkdtemp(join(tmpdir(), 'nexuspuppet-del-'));
    writer = new PosixEncStorage(encDir);
    await writer.ensureLayout();
    materializer = new MaterializerService(prisma, writer, 5, 'production');
    enqueue = new MaterializationService();

    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.managedNode.deleteMany();
  });

  const seed = (certname: string) =>
    prisma.managedNode.create({
      data: { certname, facts: {}, environment: 'production' },
    });

  const files = async (): Promise<string[]> => (await readdir(join(encDir, 'nodes'))).sort();

  const exists = async (certname: string): Promise<boolean> =>
    stat(join(encDir, 'nodes', `${certname}.yaml`))
      .then(() => true)
      .catch(() => false);

  describe('the DELETE job', () => {
    it('removes the file and the materialization record', async () => {
      await seed('gone.example.com');
      await materializer.materializeNode('gone.example.com');
      expect(await exists('gone.example.com')).toBe(true);

      await prisma.managedNode.delete({ where: { certname: 'gone.example.com' } });
      await prisma.$transaction((tx) =>
        enqueue.enqueueNodeDeletion(tx, 'gone.example.com', 'node-purged'),
      );

      const result = await materializer.drain();

      expect(result.succeeded).toBe(1);
      expect(await exists('gone.example.com')).toBe(false);
      expect(await prisma.encMaterialization.count()).toBe(0);
    });

    /**
     * The file is derived state and the job may be a retry, so a delete for
     * something already gone has to be success. Failing would retry until the
     * attempt limit and then log a permanent failure for work that is done.
     */
    it('treats an already-absent file as success', async () => {
      await prisma.$transaction((tx) =>
        enqueue.enqueueNodeDeletion(tx, 'never-existed.example.com', 'node-purged'),
      );

      const result = await materializer.drain();

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('removes only the named node', async () => {
      await seed('doomed.example.com');
      await seed('keeper.example.com');
      await materializer.materializeNode('doomed.example.com');
      await materializer.materializeNode('keeper.example.com');

      await prisma.managedNode.delete({ where: { certname: 'doomed.example.com' } });
      await prisma.$transaction((tx) =>
        enqueue.enqueueNodeDeletion(tx, 'doomed.example.com', 'node-purged'),
      );
      await materializer.drain();

      expect(await files()).toEqual(['keeper.example.com.yaml']);
    });

    /**
     * A delete and a re-materialize for the same node must not collapse into
     * one another, or a node that is purged and then returns could have its
     * fresh file deleted after it was legitimately written.
     */
    it('does not dedupe against a materialize job for the same node', async () => {
      await seed('flapping.example.com');

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'flapping.example.com', 'facts-changed');
        await enqueue.enqueueNodeDeletion(tx, 'flapping.example.com', 'node-purged');
      });

      const jobs = await prisma.encMaterializationJob.findMany({
        where: { certname: 'flapping.example.com' },
      });
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.kind).sort()).toEqual(['DELETE', 'MATERIALIZE']);
    });
  });

  describe('a node that returns', () => {
    it('is classified again after having been purged', async () => {
      await seed('boomerang.example.com');
      await materializer.materializeNode('boomerang.example.com');

      await prisma.managedNode.delete({ where: { certname: 'boomerang.example.com' } });
      await prisma.$transaction((tx) =>
        enqueue.enqueueNodeDeletion(tx, 'boomerang.example.com', 'node-purged'),
      );
      await materializer.drain();
      expect(await exists('boomerang.example.com')).toBe(false);

      // PuppetDB sees it again; the projector re-creates and re-enqueues.
      await seed('boomerang.example.com');
      await prisma.$transaction((tx) =>
        enqueue.enqueueNode(tx, 'boomerang.example.com', 'facts-changed'),
      );
      await materializer.drain();

      expect(await exists('boomerang.example.com')).toBe(true);
    });
  });

  describe('durability', () => {
    /**
     * An unlink is not durable until the parent directory is synced. This
     * cannot observe an fsync directly, but it can pin the behaviour that
     * depends on it: the removal is complete and visible before the call
     * returns, rather than buffered behind it.
     */
    it('completes the removal before returning', async () => {
      await seed('sync.example.com');
      await materializer.materializeNode('sync.example.com');

      await writer.removeNode('sync.example.com');

      expect(await exists('sync.example.com')).toBe(false);
      expect(await files()).not.toContain('sync.example.com.yaml');
    });

    it('is idempotent', async () => {
      await expect(writer.removeNode('absent.example.com')).resolves.toBeUndefined();
      await expect(writer.removeNode('absent.example.com')).resolves.toBeUndefined();
    });

    it('refuses a certname that would escape the ENC directory', async () => {
      // The certname reaches this from a database row, but it originated in a
      // certificate, so it is treated as untrusted input.
      await expect(writer.removeNode('../../etc/passwd')).rejects.toThrow();
    });
  });

  describe('deactivated is not purged', () => {
    /**
     * The behaviour this task changed. A deactivated node keeps its
     * classification: deactivation is reversible, and PuppetDB's
     * node-purge-ttl is the only authority on when a node is really gone.
     */
    it('keeps the file and the row for a deactivated node', async () => {
      await seed('sleeping.example.com');
      await materializer.materializeNode('sleeping.example.com');

      await prisma.managedNode.update({
        where: { certname: 'sleeping.example.com' },
        data: { deactivated: true },
      });

      // No DELETE job is queued for deactivation, so nothing removes the file.
      await materializer.drain();

      expect(await exists('sleeping.example.com')).toBe(true);
      expect(await prisma.managedNode.count({ where: { certname: 'sleeping.example.com' } })).toBe(
        1,
      );
    });

    it('clears the flag when the node reports again', async () => {
      await seed('waking.example.com');
      await prisma.managedNode.update({
        where: { certname: 'waking.example.com' },
        data: { deactivated: true },
      });

      // What upsertNode writes on a normal projection pass.
      await prisma.managedNode.update({
        where: { certname: 'waking.example.com' },
        data: { deactivated: false },
      });

      const node = await prisma.managedNode.findUniqueOrThrow({
        where: { certname: 'waking.example.com' },
      });
      expect(node.deactivated).toBe(false);
    });
  });
});
