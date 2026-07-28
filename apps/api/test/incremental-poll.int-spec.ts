import type {
  FactRow,
  IPuppetDbClient,
  NodeFilter,
  Page,
  PageRequest,
  PuppetNode,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { NodeProjectionService } from '../src/puppetdb/node-projection.service';
import { MaterializationService } from '../src/materialization/materialization.service';

/**
 * Incremental fact polling.
 *
 * A fact change alters group membership with no classification edit to trigger
 * it, so without this a node stays misclassified until the next full sweep —
 * five minutes by default. The poll closes that window without asking PuppetDB
 * for the whole estate, and without exposing anything for puppetserver to call.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(120_000);

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

function node(certname: string, factsTimestamp: string, isActive = true): PuppetNode {
  return {
    certname,
    environment: 'production',
    reportEnvironment: 'production',
    factsEnvironment: 'production',
    catalogEnvironment: 'production',
    reportTimestamp: factsTimestamp,
    factsTimestamp,
    catalogTimestamp: factsTimestamp,
    latestReportStatus: 'unchanged',
    latestReportHash: null,
    latestReportNoop: false,
    deactivated: isActive ? null : factsTimestamp,
    expired: null,
    isActive,
  };
}

/** Records what was asked for, so the tests can assert the queries themselves. */
class StubPuppetDb implements Partial<IPuppetDbClient> {
  nodes: PuppetNode[] = [];
  facts = new Map<string, Record<string, unknown>>();

  nodeFilters: NodeFilter[] = [];
  factsFetchedFor: string[] = [];
  listFactsCalls = 0;

  async listNodes(filter: NodeFilter, page: PageRequest): Promise<Page<PuppetNode>> {
    this.nodeFilters.push(filter);

    // Honour the filter the way PuppetDB would, so a test that asserts fewer
    // nodes were touched is asserting the QUERY and not the stub.
    let matched = this.nodes;
    if (filter.factsChangedSince !== undefined) {
      const since = filter.factsChangedSince;
      matched = matched.filter((n) => n.factsTimestamp !== null && n.factsTimestamp > since);
    }
    if (filter.includeInactive !== true) matched = matched.filter((n) => n.isActive);

    const items = matched.slice(page.offset, page.offset + page.limit);
    return { items, total: matched.length, limit: page.limit, offset: page.offset };
  }

  async getFacts(certname: string): Promise<Record<string, unknown>> {
    this.factsFetchedFor.push(certname);
    return this.facts.get(certname) ?? {};
  }

  async listFacts(factNames: readonly string[], page: PageRequest): Promise<Page<FactRow>> {
    this.listFactsCalls += 1;
    const rows: FactRow[] = [];
    for (const [certname, facts] of this.facts) {
      for (const name of factNames) {
        if (Object.prototype.hasOwnProperty.call(facts, name)) {
          rows.push({ certname, name, value: facts[name] });
        }
      }
    }
    const items = rows.slice(page.offset, page.offset + page.limit);
    return { items, total: rows.length, limit: page.limit, offset: page.offset };
  }
}

describe('incremental fact poll (integration)', () => {
  let prisma: PrismaService;
  let puppetdb: StubPuppetDb;
  let projector: NodeProjectionService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.managedNode.deleteMany();

    puppetdb = new StubPuppetDb();
    projector = new NodeProjectionService(
      prisma,
      puppetdb as unknown as IPuppetDbClient,
      new MaterializationService(),
      ['role'],
      0, // no timers: the tests drive the methods directly
      0,
      120_000,
    );
  });

  const seedProjected = (certname: string, factsTimestamp: Date, facts: object = {}) =>
    prisma.managedNode.create({
      data: { certname, facts, environment: 'production', factsTimestamp },
    });

  describe('the query it makes', () => {
    it('asks only for nodes whose facts changed since the watermark', async () => {
      await seedProjected('known.example.com', new Date(Date.now() - 600_000));

      await projector.pollChangedFacts();

      const filter = puppetdb.nodeFilters.at(-1);
      expect(filter?.factsChangedSince).toBeDefined();
      // Facts, not reports: a node can report repeatedly without any fact the
      // rules read having changed.
      expect(Object.keys(filter ?? {})).toContain('factsChangedSince');
    });

    it('does nothing at all before anything has been projected', async () => {
      // No watermark exists, and asking for everything here would duplicate the
      // full sweep at poll frequency.
      const result = await projector.pollChangedFacts();

      expect(result.since).toBeNull();
      expect(puppetdb.nodeFilters).toHaveLength(0);
    });

    it('excludes inactive nodes', async () => {
      await seedProjected('known.example.com', new Date(Date.now() - 600_000));
      await projector.pollChangedFacts();

      expect(puppetdb.nodeFilters.at(-1)?.includeInactive).toBe(false);
    });

    it('never uses the estate-wide fact query', async () => {
      // The entire saving is not reading facts for nodes that did not change.
      await seedProjected('known.example.com', new Date(Date.now() - 600_000));
      puppetdb.nodes = [node('changed.example.com', iso(0))];
      puppetdb.facts.set('changed.example.com', { role: 'web' });

      await projector.pollChangedFacts();

      expect(puppetdb.listFactsCalls).toBe(0);
      expect(puppetdb.factsFetchedFor).toEqual(['changed.example.com']);
    });
  });

  describe('what it refreshes', () => {
    it('projects a node whose facts changed and queues it for materialization', async () => {
      await seedProjected('web01.example.com', new Date(Date.now() - 600_000), { role: 'old' });
      puppetdb.nodes = [node('web01.example.com', iso(0))];
      puppetdb.facts.set('web01.example.com', { role: 'new' });

      const result = await projector.pollChangedFacts();

      expect(result.refreshed).toBe(1);
      const row = await prisma.managedNode.findUniqueOrThrow({
        where: { certname: 'web01.example.com' },
      });
      expect(row.facts).toEqual({ role: 'new' });

      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'node:web01.example.com' },
      });
      expect(job).not.toBeNull();
    });

    /**
     * Requeuing on an unchanged fact set would rematerialize the estate every
     * poll — thirty seconds instead of five minutes, which is worse than not
     * polling at all.
     */
    it('queues nothing when the projected facts are identical', async () => {
      await seedProjected('web01.example.com', new Date(Date.now() - 600_000), { role: 'web' });
      puppetdb.nodes = [node('web01.example.com', iso(0))];
      puppetdb.facts.set('web01.example.com', { role: 'web' });

      const result = await projector.pollChangedFacts();

      expect(result.refreshed).toBe(0);
      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });

    it('fetches facts only for the nodes that came back', async () => {
      await seedProjected('a.example.com', new Date(Date.now() - 600_000));
      await seedProjected('b.example.com', new Date(Date.now() - 600_000));
      puppetdb.nodes = [
        node('a.example.com', iso(0)),
        node('b.example.com', iso(-900_000)), // older than the watermark
      ];
      puppetdb.facts.set('a.example.com', { role: 'web' });
      puppetdb.facts.set('b.example.com', { role: 'db' });

      await projector.pollChangedFacts();

      expect(puppetdb.factsFetchedFor).toEqual(['a.example.com']);
    });
  });

  describe('what it must never do', () => {
    /**
     * The structural guarantee. An incremental result is a PARTIAL view, so
     * absence from it says nothing about absence from PuppetDB. Pruning here
     * would read every quiet poll as an estate that had vanished.
     */
    it('never prunes a node missing from the incremental result', async () => {
      await seedProjected('ghost.example.com', new Date(Date.now() - 600_000));
      // PuppetDB returns nothing: no facts changed.
      puppetdb.nodes = [];

      await projector.pollChangedFacts();

      expect(
        await prisma.managedNode.findUnique({ where: { certname: 'ghost.example.com' } }),
      ).not.toBeNull();
      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });

    it('never queues a deletion', async () => {
      await seedProjected('a.example.com', new Date(Date.now() - 600_000));
      await seedProjected('b.example.com', new Date(Date.now() - 600_000));
      puppetdb.nodes = [node('a.example.com', iso(0))];
      puppetdb.facts.set('a.example.com', { role: 'web' });

      await projector.pollChangedFacts();

      const deletes = await prisma.encMaterializationJob.count({ where: { kind: 'DELETE' } });
      expect(deletes).toBe(0);
      expect(await prisma.managedNode.count()).toBe(2);
    });

    it('never marks a node deactivated', async () => {
      await seedProjected('a.example.com', new Date(Date.now() - 600_000));
      puppetdb.nodes = [];

      await projector.pollChangedFacts();

      const row = await prisma.managedNode.findUniqueOrThrow({
        where: { certname: 'a.example.com' },
      });
      expect(row.deactivated).toBe(false);
    });
  });

  describe('the watermark', () => {
    it('looks back beyond the newest timestamp, so boundary ties are not dropped', async () => {
      const newest = new Date(Date.now() - 600_000);
      await seedProjected('known.example.com', newest);

      const result = await projector.pollChangedFacts();

      // Overlap of 120s: the window starts before the newest fact we hold.
      expect(new Date(result.since!).getTime()).toBeLessThan(newest.getTime());
      expect(new Date(result.since!).getTime()).toBe(newest.getTime() - 120_000);
    });

    /**
     * One agent with a clock set a year fast would otherwise push the watermark
     * into the future and starve every other node from ever being polled again.
     */
    it('is capped at now, so a future-dated node cannot starve the poll', async () => {
      await seedProjected('timetraveller.example.com', new Date(Date.now() + 365 * 86_400_000));

      const result = await projector.pollChangedFacts();

      expect(new Date(result.since!).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('failure', () => {
    it('leaves existing facts intact when PuppetDB is unreachable', async () => {
      await seedProjected('web01.example.com', new Date(Date.now() - 600_000), { role: 'web' });
      puppetdb.listNodes = async () => {
        throw new Error('ECONNREFUSED');
      };

      await expect(projector.pollChangedFacts()).rejects.toThrow('ECONNREFUSED');

      const row = await prisma.managedNode.findUniqueOrThrow({
        where: { certname: 'web01.example.com' },
      });
      expect(row.facts).toEqual({ role: 'web' });
    });
  });
});
