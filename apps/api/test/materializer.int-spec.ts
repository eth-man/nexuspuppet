import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PrismaService, ADVISORY_LOCKS } from '../src/prisma/prisma.service';
import { PosixEncStorage } from '../src/materialization/posix-enc-storage';
import { MaterializerService } from '../src/materialization/materializer.service';
import { MaterializationService } from '../src/materialization/materialization.service';
import { ReconcilerService } from '../src/materialization/reconciler.service';

/**
 * Integration tests against a REAL PostgreSQL.
 *
 * The transactional outbox and the advisory lock are the two mechanisms ADR-0003
 * depends on, and neither can be verified against a mock: a mock will happily
 * confirm whatever the code already believes. These run against the database in
 * docker-compose.dev.yml.
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   npm run test:int --workspace @nexuspuppet/api
 */

/**
 * These tests TRUNCATE tables. They must never point at a database anyone is
 * using: a leftover fixture row once blocked admin bootstrap on the dev stack
 * and made login impossible. `npm run test:int` supplies TEST_DATABASE_URL;
 * the fallback is the dedicated test database, never the dev one.
 */
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(30_000);

describe('ENC materialization (integration)', () => {
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
    encDir = await mkdtemp(join(tmpdir(), 'nexuspuppet-int-'));
    writer = new PosixEncStorage(encDir);
    await writer.ensureLayout();

    materializer = new MaterializerService(prisma, writer, 5, 'production');
    enqueue = new MaterializationService();

    // Order matters: children before parents.
    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.nodeGroupPin.deleteMany();
    await prisma.nodeGroupClass.deleteMany();
    await prisma.nodeGroupParameter.deleteMany();
    await prisma.nodeGroupRule.deleteMany();
    await prisma.nodeGroup.deleteMany();
    await prisma.managedNode.deleteMany();
  });

  const seedNode = (certname: string, facts: Record<string, unknown> = {}) =>
    prisma.managedNode.create({
      data: { certname, facts: facts as object, environment: 'production' },
    });

  const seedGroup = async (opts: {
    name: string;
    rank?: number;
    strategy?: 'ALL_RULES' | 'ANY_RULE' | 'PINNED';
    environment?: string | null;
    rules?: Array<{ factPath: string; operator: 'EQUALS'; value: unknown }>;
    classes?: Array<{ className: string; params?: Record<string, unknown> }>;
    parameters?: Array<{ key: string; value: unknown }>;
    pins?: string[];
  }) =>
    prisma.nodeGroup.create({
      data: {
        name: opts.name,
        rank: opts.rank ?? 100,
        strategy: opts.strategy ?? 'ALL_RULES',
        environment: opts.environment ?? null,
        rules: { create: (opts.rules ?? []).map((r) => ({ ...r, value: r.value as object })) },
        classes: {
          create: (opts.classes ?? []).map((c) => ({
            className: c.className,
            params: (c.params ?? {}) as object,
          })),
        },
        parameters: {
          create: (opts.parameters ?? []).map((p) => ({ key: p.key, value: p.value as object })),
        },
        pins: { create: (opts.pins ?? []).map((certname) => ({ certname })) },
      },
    });

  const readNodeYaml = async (certname: string): Promise<Record<string, unknown>> =>
    parse(await readFile(join(encDir, 'nodes', `${certname}.yaml`), 'utf8')) as Record<
      string,
      unknown
    >;

  // -------------------------------------------------------------------------

  describe('end to end', () => {
    it('turns a queued change into a YAML file Puppet can read', async () => {
      await seedNode('web01.example.com', { os: { family: 'RedHat' } });
      await seedGroup({
        name: 'redhat-base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base', params: { ntp: 'a.pool' } }],
        parameters: [{ key: 'datacenter', value: 'dc1' }],
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01.example.com', 'test');
      });

      const result = await materializer.drain();
      expect(result.ranHere).toBe(true);
      expect(result.succeeded).toBe(1);
      expect(result.filesChanged).toBe(1);

      expect(await readNodeYaml('web01.example.com')).toEqual({
        classes: { 'profile::base': { ntp: 'a.pool' } },
        parameters: { datacenter: 'dc1' },
      });
    });

    it('records materialization state with applied groups', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      const group = await seedGroup({
        name: 'base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base' }],
      });

      await materializer.materializeNode('web01');

      const state = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });
      expect(state?.appliedGroupIds).toEqual([group.id]);
      expect(state?.revision).toBe(1);
      expect(state?.relativePath).toBe('nodes/web01.yaml');
    });

    /*
     * REGRESSION. `writtenAt` used to advance on every pass, which made it mean
     * "when we last looked" rather than "when this last changed" — and the
     * replication status then reported a peer as permanently behind while it was
     * demonstrably current, because the peer's last transfer only advances when
     * the tree actually changes.
     *
     * Found by looking at the console on staging: the System card said "1 behind"
     * while the conditions panel said nothing was open, and the peer was being
     * answered 304, which means it already had the tree.
     */
    it('does not advance writtenAt when nothing changed', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      await seedGroup({
        name: 'base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base' }],
      });

      await materializer.materializeNode('web01');
      const first = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });

      // Long enough that an advancing timestamp is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await materializer.materializeNode('web01');
      const second = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });

      expect(second?.contentHash).toBe(first?.contentHash);
      expect(second?.writtenAt).toEqual(first?.writtenAt);
    });

    it('advances writtenAt when the document really changes', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      const group = await seedGroup({
        name: 'base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base' }],
      });

      await materializer.materializeNode('web01');
      const first = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });

      await new Promise((resolve) => setTimeout(resolve, 1100));
      await prisma.nodeGroupClass.create({
        data: { groupId: group.id, className: 'profile::db' },
      });
      await materializer.materializeNode('web01');
      const second = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });

      expect(second?.contentHash).not.toBe(first?.contentHash);
      expect(second?.writtenAt.getTime()).toBeGreaterThan(first?.writtenAt.getTime() ?? 0);
    });

    it('a node matching nothing still gets a valid file, not a missing one', async () => {
      await seedNode('orphan01');
      await materializer.materializeNode('orphan01');

      expect(await readNodeYaml('orphan01')).toEqual({ classes: {}, parameters: {} });
    });

    it('writes default.yaml so an unknown node never fails compilation', async () => {
      await materializer.ensureDefaultDocument();
      const parsed = parse(await readFile(join(encDir, 'default.yaml'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(parsed['environment']).toBe('production');
    });
  });

  describe('revision and change detection', () => {
    it('does not bump the revision when nothing changed', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      await seedGroup({
        name: 'base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base' }],
      });

      const first = await materializer.materializeNode('web01');
      const second = await materializer.materializeNode('web01');

      expect(first.changed).toBe(true);
      // Rewriting identical content would churn every file in the estate on
      // every reconcile (ADR-0003).
      expect(second.changed).toBe(false);
      expect(second.contentHash).toBe(first.contentHash);

      const state = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });
      expect(state?.revision).toBe(1);
    });

    it('bumps the revision when the classification actually changes', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      const group = await seedGroup({
        name: 'base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base' }],
      });

      await materializer.materializeNode('web01');
      await prisma.nodeGroupClass.updateMany({
        where: { groupId: group.id },
        data: { params: { ntp: 'changed' } },
      });
      const second = await materializer.materializeNode('web01');

      expect(second.changed).toBe(true);
      const state = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });
      expect(state?.revision).toBe(2);
    });

    it('repairs a hand-edited file', async () => {
      await seedNode('web01');
      await materializer.materializeNode('web01');
      await writeFile(join(encDir, 'nodes', 'web01.yaml'), 'tampered: true\n', 'utf8');

      const repaired = await materializer.materializeNode('web01');
      expect(repaired.changed).toBe(true);
      expect(await readNodeYaml('web01')).toEqual({ classes: {}, parameters: {} });
    });
  });

  describe('merge order and conflicts (ADR-0009)', () => {
    it('applies higher rank last and records the conflict', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      const rule = { factPath: 'os.family', operator: 'EQUALS' as const, value: 'RedHat' };

      await seedGroup({
        name: 'base',
        rank: 100,
        rules: [rule],
        classes: [{ className: 'profile::base', params: { ntp: 'base.pool' } }],
      });
      await seedGroup({
        name: 'override',
        rank: 200,
        rules: [rule],
        classes: [{ className: 'profile::base', params: { ntp: 'override.pool' } }],
      });

      const outcome = await materializer.materializeNode('web01');

      const yaml = await readNodeYaml('web01');
      expect((yaml['classes'] as Record<string, Record<string, unknown>>)['profile::base']).toEqual(
        {
          ntp: 'override.pool',
        },
      );

      expect(outcome.conflicts).toHaveLength(1);
      expect(outcome.conflicts[0]).toMatchObject({
        key: 'profile::base.ntp',
        winningGroupName: 'override',
        losingGroupName: 'base',
      });

      // Conflicts are persisted so the UI can surface them (ADR-0009).
      const state = await prisma.encMaterialization.findUnique({ where: { certname: 'web01' } });
      expect(state?.conflicts).toHaveLength(1);
    });

    it('a disabled group does not classify', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      const group = await seedGroup({
        name: 'base',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::base' }],
      });
      await prisma.nodeGroup.update({ where: { id: group.id }, data: { isEnabled: false } });

      await materializer.materializeNode('web01');
      expect(await readNodeYaml('web01')).toEqual({ classes: {}, parameters: {} });
    });

    it('classifies a pinned node regardless of its facts', async () => {
      await seedNode('special01', { os: { family: 'Debian' } });
      await seedGroup({
        name: 'pinned',
        strategy: 'PINNED',
        pins: ['special01'],
        classes: [{ className: 'profile::special' }],
      });

      await materializer.materializeNode('special01');
      expect(Object.keys((await readNodeYaml('special01'))['classes'] as object)).toEqual([
        'profile::special',
      ]);
    });
  });

  describe('the outbox', () => {
    it('collapses repeated requests for one node into a single job', async () => {
      await seedNode('web01');

      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < 20; i += 1) {
          await enqueue.enqueueNode(tx, 'web01', `edit-${i}`);
        }
      });

      expect(await prisma.encMaterializationJob.count()).toBe(1);
      const result = await materializer.drain();
      expect(result.claimed).toBe(1);
    });

    // Claim-by-delete: a change arriving mid-processing must produce a fresh
    // job rather than being swallowed when the in-flight one completes.
    it('does not swallow a change that arrives while a job is in flight', async () => {
      await seedNode('web01');
      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01', 'first');
      });

      // Simulate the claim, then a concurrent enqueue before completion.
      const claimed = await prisma.encMaterializationJob.findMany();
      await prisma.encMaterializationJob.deleteMany({
        where: { id: { in: claimed.map((j) => j.id) } },
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01', 'second-arrives-mid-flight');
      });

      const remaining = await prisma.encMaterializationJob.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.reason).toBe('second-arrives-mid-flight');
      expect(remaining[0]?.status).toBe('PENDING');
    });

    it('removes the job once it succeeds', async () => {
      await seedNode('web01');
      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01', 'test');
      });

      await materializer.drain();
      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });

    it('leaves nothing to do on an empty queue', async () => {
      const result = await materializer.drain();
      expect(result).toMatchObject({ claimed: 0, succeeded: 0, ranHere: true });
    });

    it('does not claim a job whose backoff has not elapsed', async () => {
      await prisma.encMaterializationJob.create({
        data: {
          dedupeKey: 'node:later',
          certname: 'later',
          reason: 'backoff',
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });

      expect((await materializer.drain()).claimed).toBe(0);
    });

    // The commit-then-crash case the outbox exists for.
    it('still materializes after a crash between commit and drain', async () => {
      await seedNode('web01');
      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01', 'committed-then-crash');
      });

      // No drain ran — the process "died" here. A new instance picks it up.
      const fresh = new MaterializerService(prisma, writer, 5, 'production');
      const result = await fresh.drain();

      expect(result.succeeded).toBe(1);
      expect(await readNodeYaml('web01')).toEqual({ classes: {}, parameters: {} });
    });
  });

  describe('failure handling', () => {
    it('retries with backoff and does not lose the job', async () => {
      // An invalid class name fails at render time (ADR-0009 safety rails).
      await seedNode('web01', { os: { family: 'RedHat' } });
      await seedGroup({
        name: 'bad',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'Invalid::ClassName' }],
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01', 'test');
      });

      const result = await materializer.drain();
      expect(result.failed).toBe(1);

      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'node:web01' },
      });
      expect(job?.attempts).toBe(1);
      expect(job?.lastError).toContain('not a valid Puppet class name');
      expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('parks a job as FAILED once attempts are exhausted', async () => {
      await seedNode('web01', { os: { family: 'RedHat' } });
      await seedGroup({
        name: 'bad',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'Invalid::Name' }],
      });

      const oneAttempt = new MaterializerService(prisma, writer, 1, 'production');
      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'web01', 'test');
      });

      await oneAttempt.drain();

      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'node:web01' },
      });
      expect(job?.status).toBe('FAILED');
    });

    // One bad node must not stop the rest of the estate from materializing.
    it('isolates a failing node from healthy ones', async () => {
      await seedNode('good01');
      await seedNode('bad01', { broken: true });
      await seedGroup({
        name: 'bad',
        rules: [{ factPath: 'broken', operator: 'EQUALS', value: true }],
        classes: [{ className: 'Not::Valid' }],
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueNode(tx, 'good01', 'test');
        await enqueue.enqueueNode(tx, 'bad01', 'test');
      });

      const result = await materializer.drain();
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(await readNodeYaml('good01')).toEqual({ classes: {}, parameters: {} });
    });
  });

  describe('full reconcile', () => {
    it('materializes every node from a single job', async () => {
      await seedNode('a01', { os: { family: 'RedHat' } });
      await seedNode('b01', { os: { family: 'RedHat' } });
      await seedNode('c01', { os: { family: 'Debian' } });
      await seedGroup({
        name: 'redhat',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
        classes: [{ className: 'profile::redhat' }],
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueFullReconcile(tx, 'test');
      });

      const result = await materializer.drain();
      expect(result.claimed).toBe(1);
      expect(result.filesChanged).toBe(3);

      expect(Object.keys((await readNodeYaml('a01'))['classes'] as object)).toEqual([
        'profile::redhat',
      ]);
      expect((await readNodeYaml('c01'))['classes']).toEqual({});
    });

    it('editing a rule-based group triggers a full reconcile, not just current members', async () => {
      const group = await seedGroup({
        name: 'rules',
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }],
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueForGroup(tx, group.id, 'rule-changed');
      });

      // A rule edit can pull in nodes that never matched before, which current
      // membership cannot tell us about.
      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'full-reconcile' },
      });
      expect(job).not.toBeNull();
      expect(job?.certname).toBeNull();
    });

    it('a pinned group enqueues only its pinned nodes', async () => {
      await seedNode('pinned01');
      const group = await seedGroup({
        name: 'pinned',
        strategy: 'PINNED',
        pins: ['pinned01'],
      });

      await prisma.$transaction(async (tx) => {
        await enqueue.enqueueForGroup(tx, group.id, 'pin-changed');
      });

      const jobs = await prisma.encMaterializationJob.findMany();
      expect(jobs.map((j) => j.certname)).toEqual(['pinned01']);
    });
  });

  describe('orphan removal', () => {
    // An orphaned file keeps classifying a node forever — puppetserver has no
    // idea the database no longer describes it.
    it('deletes ENC files for nodes the database no longer knows', async () => {
      await seedNode('alive01');
      await materializer.materializeNode('alive01');

      // A node removed from the estate, its file left behind.
      await writer.writeNode('ghost01', 'classes: {}\n', 'deadbeef');
      expect((await readdir(join(encDir, 'nodes'))).sort()).toEqual([
        'alive01.yaml',
        'ghost01.yaml',
      ]);

      const reconciler = new ReconcilerService(prisma, materializer, writer, 60_000, 60_000);
      const removed = await reconciler.reconcile('test');

      expect(removed).toBe(1);
      expect(await readdir(join(encDir, 'nodes'))).toEqual(['alive01.yaml']);
    });

    it('leaves default.yaml alone', async () => {
      await materializer.ensureDefaultDocument();
      const reconciler = new ReconcilerService(prisma, materializer, writer, 60_000, 60_000);
      await reconciler.reconcile('test');

      await expect(readFile(join(encDir, 'default.yaml'), 'utf8')).resolves.toContain('classes');
    });

    it('queues a full recompute as part of reconciling', async () => {
      const reconciler = new ReconcilerService(prisma, materializer, writer, 60_000, 60_000);
      await reconciler.reconcile('test');

      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'full-reconcile' },
      });
      expect(job?.reason).toBe('reconcile:test');
    });
  });

  describe('advisory lock', () => {
    // Two api replicas must never write the same file concurrently (ADR-0003).
    it('is exclusive: a second holder is refused rather than queued', async () => {
      const other = new PrismaService(DATABASE_URL);
      await other.onModuleInit();

      try {
        let innerResult: string | null = null;

        const outer = await prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, async () => {
          innerResult = await other.withAdvisoryLock(
            ADVISORY_LOCKS.ENC_MATERIALIZER,
            async () => 'acquired',
          );
          return 'outer-held';
        });

        expect(outer).toBe('outer-held');
        // Non-blocking by design: a tick that cannot get the lock returns
        // immediately and lets the holder proceed.
        expect(innerResult).toBeNull();
      } finally {
        await other.onModuleDestroy();
      }
    });

    it('releases the lock after the work completes', async () => {
      await prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, async () => 'first');
      const second = await prisma.withAdvisoryLock(
        ADVISORY_LOCKS.ENC_MATERIALIZER,
        async () => 'second',
      );
      expect(second).toBe('second');
    });

    // A session-level lock outlives the transaction and would wedge
    // materialization until the connection recycled.
    it('releases the lock even when the work throws', async () => {
      await expect(
        prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const after = await prisma.withAdvisoryLock(
        ADVISORY_LOCKS.ENC_MATERIALIZER,
        async () => 'reacquired',
      );
      expect(after).toBe('reacquired');
    });
  });
});
