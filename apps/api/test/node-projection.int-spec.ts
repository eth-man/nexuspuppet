import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PuppetDbUnavailableError,
  type FactRow,
  type IPuppetDbClient,
  type NodeFilter,
  type Page,
  type PageRequest,
  type PuppetNode,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterializationService } from '../src/materialization/materialization.service';
import { NodeProjectionService } from '../src/puppetdb/node-projection.service';
import { mapNode, mapFactsetToFacts } from '../src/puppetdb/puppetdb.mapper';

/**
 * Node projection against a REAL PostgreSQL, driven by the synthetic fixtures
 * in /fixtures (generated from the PuppetDB 8 v4 documentation).
 *
 * The PuppetDB client is a stub here on purpose: what is under test is the
 * projection and, above all, the PRUNE SAFETY logic — behaviour that only
 * appears when PuppetDB misbehaves, which a real server will not do on demand.
 * The client itself is covered separately, including a live mTLS handshake.
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

const fixtures = join(__dirname, '../../../fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as T;

const RAW_NODES = load<Record<string, unknown>[]>('nodes-query.sample.json');
const RAW_FACTSET = load<Record<string, unknown>[]>('factset-single-node.sample.json');

const PROJECTED = ['os', 'networking', 'kernel', 'is_virtual'];

jest.setTimeout(60_000);

/** A controllable PuppetDB. Every failure mode the real one can produce. */
class StubPuppetDb implements Partial<IPuppetDbClient> {
  nodes: PuppetNode[] = RAW_NODES.map(mapNode);
  facts = new Map<string, Record<string, unknown>>();

  failNodes: Error | null = null;
  failFacts: Error | null = null;

  constructor() {
    // Give every active fixture node the same fact set, so membership is
    // predictable and the tests are about projection rather than data shape.
    const base = mapFactsetToFacts(RAW_FACTSET[0] as Record<string, unknown>);
    for (const node of this.nodes) {
      this.facts.set(node.certname, base);
    }
  }

  async listNodes(_filter: NodeFilter, page: PageRequest): Promise<Page<PuppetNode>> {
    if (this.failNodes !== null) throw this.failNodes;
    const items = this.nodes.slice(page.offset, page.offset + page.limit);
    return { items, total: this.nodes.length, limit: page.limit, offset: page.offset };
  }

  async listFacts(factNames: readonly string[], page: PageRequest): Promise<Page<FactRow>> {
    if (this.failFacts !== null) throw this.failFacts;

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

describe('node projection (integration)', () => {
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
    await prisma.nodeGroupPin.deleteMany();
    await prisma.nodeGroup.deleteMany();
    await prisma.managedNode.deleteMany();

    puppetdb = new StubPuppetDb();
    projector = new NodeProjectionService(
      prisma,
      puppetdb as unknown as IPuppetDbClient,
      new MaterializationService(),
      PROJECTED,
      0, // no timer; tests drive project() directly
    );
  });

  const activeFixtureCount = () => RAW_NODES.map(mapNode).filter((n) => n.isActive).length;

  // -------------------------------------------------------------------------

  describe('projecting the fixture estate', () => {
    it('projects the active nodes', async () => {
      const result = await projector.project();

      expect(result.ranHere).toBe(true);
      expect(result.nodesSeen).toBe(50);
      expect(result.nodesUpserted).toBe(activeFixtureCount());
      expect(await prisma.managedNode.count()).toBe(activeFixtureCount());
    });

    /**
     * A node already deactivated the first time PuppetDB shows it to us has no
     * classification to retain. Creating one would classify a machine that is
     * not reporting — churn for no value. Retention applies to nodes we knew.
     */
    it('does not invent rows for nodes that were deactivated before we saw them', async () => {
      await projector.project();

      expect(await prisma.managedNode.count({ where: { deactivated: true } })).toBe(0);
      expect(await prisma.managedNode.count()).toBe(activeFixtureCount());
    });

    // Deactivated and expired nodes must not be classified at all.
    it('does not project deactivated or expired nodes', async () => {
      await projector.project();

      const inactive = RAW_NODES.map(mapNode).filter((n) => !n.isActive);
      expect(inactive.length).toBeGreaterThan(0);

      for (const node of inactive) {
        expect(
          await prisma.managedNode.findUnique({ where: { certname: node.certname } }),
        ).toBeNull();
      }
    });

    // Full facts are unbounded; mirroring them for 1,000 nodes would be a large
    // and useless table (ADR-0004).
    it('stores ONLY the allow-listed facts', async () => {
      await projector.project();

      const row = await prisma.managedNode.findFirst();
      const facts = row?.facts as Record<string, unknown>;

      expect(Object.keys(facts).sort()).toEqual(['is_virtual', 'kernel', 'networking', 'os']);
      // Present in the fixture, deliberately not projected.
      expect('memory' in facts).toBe(false);
      expect('processors' in facts).toBe(false);
    });

    it('preserves structured fact values that rules match on', async () => {
      await projector.project();

      const row = await prisma.managedNode.findFirst();
      const facts = row?.facts as Record<string, Record<string, unknown>>;

      expect(facts['os']?.['family']).toBe('Debian');
      expect(facts['networking']?.['domain']).toBe('nexuspuppet.test');
    });

    it('records environment, status, and the projection timestamp', async () => {
      await projector.project();

      const row = await prisma.managedNode.findFirst();
      expect(row?.environment).not.toBeNull();
      expect(row?.latestReportStatus).not.toBeNull();
      // Surfaced in the UI as "facts as of <t>" so staleness is visible.
      expect(row?.projectedAt).toBeInstanceOf(Date);
    });

    it('pages through the whole estate rather than stopping at one page', async () => {
      // PAGE_SIZE is 500 and the fixture has 50, so force multiple pages by
      // shrinking what the stub returns per call.
      const original = puppetdb.listNodes.bind(puppetdb);
      puppetdb.listNodes = (filter, page) => original(filter, { ...page, limit: 7 });

      await projector.project();
      expect(await prisma.managedNode.count()).toBe(activeFixtureCount());
    });
  });

  describe('change detection', () => {
    // A fact change can alter group membership with NO classification edit to
    // trigger it, so the projector must requeue the node itself.
    it('enqueues a node whose projected facts changed', async () => {
      await projector.project();
      await prisma.encMaterializationJob.deleteMany();

      const target = puppetdb.nodes.find((n) => n.isActive)!.certname;
      puppetdb.facts.set(target, {
        ...puppetdb.facts.get(target),
        os: { family: 'Debian' },
      });

      const result = await projector.project();

      expect(result.nodesChanged).toBe(1);
      expect(
        await prisma.encMaterializationJob.findUnique({ where: { dedupeKey: `node:${target}` } }),
      ).not.toBeNull();
    });

    // Requeuing unchanged nodes would rematerialize the whole estate on every
    // projection cycle, forever.
    it('enqueues NOTHING when nothing changed', async () => {
      await projector.project();
      await prisma.encMaterializationJob.deleteMany();

      const result = await projector.project();

      expect(result.nodesChanged).toBe(0);
      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });

    // PuppetDB does not guarantee key order; a naive JSON.stringify comparison
    // would report a change on every cycle.
    it('is insensitive to fact key ordering', async () => {
      await projector.project();
      await prisma.encMaterializationJob.deleteMany();

      const target = puppetdb.nodes.find((n) => n.isActive)!.certname;
      const facts = puppetdb.facts.get(target)!;
      puppetdb.facts.set(
        target,
        Object.fromEntries(Object.entries(facts).reverse()) as Record<string, unknown>,
      );

      expect((await projector.project()).nodesChanged).toBe(0);
    });

    // Timestamps move on every run; requeuing on them would be constant churn.
    it('ignores timestamp changes that rules never read', async () => {
      await projector.project();
      await prisma.encMaterializationJob.deleteMany();

      for (const node of puppetdb.nodes) {
        node.reportTimestamp = new Date().toISOString();
      }

      expect((await projector.project()).nodesChanged).toBe(0);
    });

    it('enqueues when the environment changes', async () => {
      await projector.project();
      await prisma.encMaterializationJob.deleteMany();

      const node = puppetdb.nodes.find((n) => n.isActive)!;
      node.environment = 'a-different-environment';

      expect((await projector.project()).nodesChanged).toBe(1);
    });
  });

  /**
   * The catastrophic failure this service is designed around. A partial fetch
   * mistaken for a shrunken estate would delete the projection, cascade to
   * EncMaterialization, and let the reconciler remove the YAML — unclassifying
   * the fleet because of a network blip.
   */
  describe('prune safety', () => {
    it('prunes a node PuppetDB genuinely no longer reports', async () => {
      await projector.project();
      const before = await prisma.managedNode.count();

      const removed = puppetdb.nodes.find((n) => n.isActive)!.certname;
      puppetdb.nodes = puppetdb.nodes.filter((n) => n.certname !== removed);

      const result = await projector.project();

      expect(result.nodesPruned).toBe(1);
      expect(await prisma.managedNode.count()).toBe(before - 1);
      expect(await prisma.managedNode.findUnique({ where: { certname: removed } })).toBeNull();
    });

    // The blip case. An empty response is far more likely to be a broken query
    // than an emptied estate.
    it('REFUSES to prune when PuppetDB reports zero nodes', async () => {
      await projector.project();
      const before = await prisma.managedNode.count();
      expect(before).toBeGreaterThan(0);

      puppetdb.nodes = [];
      const result = await projector.project();

      expect(result.nodesPruned).toBe(0);
      expect(result.pruneSkippedReason).toContain('0 active nodes');
      expect(await prisma.managedNode.count()).toBe(before);
    });

    it('REFUSES to prune when the estate appears to have more than halved', async () => {
      await projector.project();
      const before = await prisma.managedNode.count();

      // A partial fetch: only a handful of nodes came back.
      puppetdb.nodes = puppetdb.nodes.filter((n) => n.isActive).slice(0, 5);

      const result = await projector.project();

      expect(result.nodesPruned).toBe(0);
      expect(result.pruneSkippedReason).toContain('Refusing to prune');
      expect(await prisma.managedNode.count()).toBe(before);
    });

    it('still prunes a decommission below the safety threshold', async () => {
      await projector.project();
      const before = await prisma.managedNode.count();

      // Remove ~20%: plausible as a real decommission.
      const keep = puppetdb.nodes.filter((n) => n.isActive);
      puppetdb.nodes = keep.slice(0, Math.floor(keep.length * 0.8));

      const result = await projector.project();

      expect(result.nodesPruned).toBeGreaterThan(0);
      expect(await prisma.managedNode.count()).toBeLessThan(before);
    });

    /**
     * Deactivation is NOT purging, and this is the behaviour that changed.
     *
     * PuppetDB deactivates a node when it stops reporting and purges it only
     * after node-purge-ttl. A node can return by checking in again, so deleting
     * its classification on deactivation would churn a file that is about to be
     * needed and invent a second, competing notion of "gone".
     */
    it('retains a node that becomes deactivated, flagging it instead', async () => {
      await projector.project();

      const node = puppetdb.nodes.find((n) => n.isActive)!;
      node.deactivated = new Date().toISOString();
      node.isActive = false;

      await projector.project();

      const row = await prisma.managedNode.findUnique({ where: { certname: node.certname } });
      expect(row).not.toBeNull();
      expect(row?.deactivated).toBe(true);
    });

    it('clears the flag when a deactivated node reports again', async () => {
      const node = puppetdb.nodes.find((n) => n.isActive)!;
      node.deactivated = new Date().toISOString();
      node.isActive = false;
      await projector.project();

      node.deactivated = null;
      node.isActive = true;
      await projector.project();

      const row = await prisma.managedNode.findUniqueOrThrow({
        where: { certname: node.certname },
      });
      expect(row.deactivated).toBe(false);
    });

    /**
     * Purging IS removal, and it must queue the file for deletion in the same
     * transaction — otherwise the file keeps classifying a node that no longer
     * exists until the next periodic reconcile.
     */
    it('prunes a node absent from PuppetDB and queues its file for deletion', async () => {
      await projector.project();

      const victim = puppetdb.nodes[0]!.certname;
      puppetdb.nodes = puppetdb.nodes.filter((n) => n.certname !== victim);

      await projector.project();

      expect(await prisma.managedNode.findUnique({ where: { certname: victim } })).toBeNull();

      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: `delete:${victim}` },
      });
      expect(job?.kind).toBe('DELETE');
      expect(job?.certname).toBe(victim);
    });

    it('does not prune on a first run against an empty cache', async () => {
      puppetdb.nodes = [];
      const result = await projector.project();

      expect(result.nodesPruned).toBe(0);
      expect(result.pruneSkippedReason).toBeNull();
    });
  });

  /**
   * Being stale is recoverable. Wiping the projection is not — and
   * classification must keep working through a PuppetDB outage (ADR-0003).
   */
  describe('PuppetDB unavailable', () => {
    it('retains the existing projection when the node query fails', async () => {
      await projector.project();
      const before = await prisma.managedNode.count();

      puppetdb.failNodes = new PuppetDbUnavailableError('connection refused');
      const result = await projector.project();

      expect(result.error).toContain('connection refused');
      expect(result.nodesPruned).toBe(0);
      expect(await prisma.managedNode.count()).toBe(before);
    });

    it('retains the projection when the FACTS query fails midway', async () => {
      await projector.project();
      const before = await prisma.managedNode.count();

      puppetdb.failFacts = new PuppetDbUnavailableError('read timeout');
      const result = await projector.project();

      expect(result.error).toContain('read timeout');
      expect(await prisma.managedNode.count()).toBe(before);
    });

    // A failed projection must not look like a fact change to the estate.
    it('enqueues nothing when the fetch fails', async () => {
      await projector.project();
      await prisma.encMaterializationJob.deleteMany();

      puppetdb.failNodes = new PuppetDbUnavailableError('down');
      await projector.project();

      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });

    it('does not throw out of tick(), so the timer survives', async () => {
      puppetdb.failNodes = new Error('catastrophic');
      await expect(projector.tick()).resolves.toBeUndefined();
    });
  });

  describe('configuration', () => {
    it('projects no facts when the allow-list is empty, but still tracks nodes', async () => {
      const noFacts = new NodeProjectionService(
        prisma,
        puppetdb as unknown as IPuppetDbClient,
        new MaterializationService(),
        [],
        0,
      );

      await noFacts.project();

      expect(await prisma.managedNode.count()).toBe(activeFixtureCount());
      expect(await prisma.managedNode.findFirst().then((r) => r?.facts)).toEqual({});
    });

    // A rule on an unprojected fact can never match; the projection is the
    // reason why (ADR-0004).
    it('omits a fact outside the allow-list even when PuppetDB returns it', async () => {
      await projector.project();

      const facts = (await prisma.managedNode.findFirst())?.facts as Record<string, unknown>;
      expect('puppetversion' in facts).toBe(false);
    });
  });

  /**
   * Naming a fact nothing reports.
   *
   * The allow-list is written by hand and drifts against Facter. A name no node
   * reports makes every rule on it silently unmatchable, and the only signal is
   * a group that classifies nothing — indistinguishable from a group whose
   * rules genuinely match nothing. Our own default carried three such names
   * (`fqdn`, `domain`, `role`) until they were checked against a real estate.
   *
   * Note which names these tests use. `role`, `fqdn` and `domain` would NOT
   * work: the captured factset contains all three. `fqdn` and `domain` because
   * puppet-agent 7.20 still emits the legacy flat facts (the Puppet 8 and
   * OpenVox agents do not, which is why they are out of the shipped default),
   * and `role` because this estate now supplies it as an external fact.
   *
   * `ec2_metadata` and `solaris_zones` are real Facter facts that appear only
   * on platforms this node is not — an EC2 instance and a Solaris host — so
   * they are genuinely absent, which is the condition under test.
   */
  describe('facts no node reports', () => {
    const warnings = (spy: jest.SpyInstance): string =>
      spy.mock.calls.map((c) => String(c[0])).join(' | ');

    it('names the projected facts absent from every node', async () => {
      const withGhost = new NodeProjectionService(
        prisma,
        puppetdb as unknown as IPuppetDbClient,
        new MaterializationService(),
        [...PROJECTED, 'ec2_metadata', 'solaris_zones'],
        0,
      );
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await withGhost.project();

        const text = warnings(spy);
        expect(text).toContain('ec2_metadata');
        expect(text).toContain('solaris_zones');
        // The facts that ARE reported must not be named, or the warning becomes
        // a list of everything and tells the operator nothing.
        expect(text).not.toContain('kernel');
      } finally {
        spy.mockRestore();
      }
    });

    it('stays silent when every projected fact is reported', async () => {
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await projector.project();
        expect(warnings(spy)).not.toContain('NO node reports');
      } finally {
        spy.mockRestore();
      }
    });

    /**
     * Every fact is trivially absent from an empty estate. Warning there would
     * fire on every fresh install, before a single agent has checked in, and
     * teach operators to ignore it.
     */
    it('stays silent when the estate is empty', async () => {
      puppetdb.nodes = [];
      const withGhost = new NodeProjectionService(
        prisma,
        puppetdb as unknown as IPuppetDbClient,
        new MaterializationService(),
        ['definitely_not_a_fact'],
        0,
      );
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await withGhost.project();
        expect(warnings(spy)).not.toContain('definitely_not_a_fact');
      } finally {
        spy.mockRestore();
      }
    });

    /**
     * Once per process. The projector runs every five minutes; a warning that
     * repeats at that rate becomes something operators filter, which is how the
     * condition stays invisible.
     */
    it('warns once, not on every pass', async () => {
      const withGhost = new NodeProjectionService(
        prisma,
        puppetdb as unknown as IPuppetDbClient,
        new MaterializationService(),
        [...PROJECTED, 'ec2_metadata'],
        0,
      );
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await withGhost.project();
        await withGhost.project();
        await withGhost.project();

        const named = spy.mock.calls.filter((c) => String(c[0]).includes('NO node reports'));
        expect(named).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('end to end with classification', () => {
    // The whole point: rules evaluate against the projection, so a projected
    // estate makes classification work without any live PuppetDB call.
    it('makes fixture nodes matchable by a fact rule', async () => {
      await projector.project();

      const group = await prisma.nodeGroup.create({
        data: {
          name: 'redhat',
          strategy: 'ALL_RULES',
          rules: { create: [{ factPath: 'os.family', operator: 'EQUALS', value: 'Debian' }] },
        },
        include: { rules: true },
      });

      const { matchGroups } = await import('../src/materialization/pure/rule-evaluator');
      const nodes = await prisma.managedNode.findMany();

      const matched = nodes.filter(
        (n) =>
          matchGroups({ certname: n.certname, facts: n.facts as Record<string, unknown> }, [
            {
              id: group.id,
              name: group.name,
              rank: group.rank,
              strategy: 'ALL_RULES',
              isEnabled: true,
              rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'Debian' }],
              pinnedCertnames: [],
            },
          ]).length > 0,
      );

      expect(matched.length).toBe(activeFixtureCount());
    });
  });
});
