import { PropagationService } from './propagation.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { EncDocumentReader } from '../materialization/enc-document-reader';

/**
 * The propagation front (#147).
 *
 * The governing rule is that every stage is an equality check against the
 * current revision and nothing infers from a timestamp. These are written to
 * catch a future change that quietly reintroduces clock comparison — which is
 * the one thing that would make this view untrustworthy at the moment it is
 * read.
 */
describe('PropagationService', () => {
  const REV = 'current-revision';

  function build(options: {
    revision?: string | null;
    peers?: Array<{ lastEtag: string; lastChangedAt: Date | null }>;
    receipts?: Array<{ certname: string; revision: string }>;
    nodes?: string[];
    replicationEnabled?: boolean;
    pending?: number;
    failed?: number;
  }) {
    const nodes = options.nodes ?? [];
    const receipts = options.receipts ?? [];

    const prisma = {
      encMaterialization: {
        findFirst: async () => ({ writtenAt: new Date('2026-08-11T00:00:00Z') }),
      },
      encMaterializationJob: {
        count: async ({ where }: { where: { status: string } }) =>
          where.status === 'PENDING' ? (options.pending ?? 0) : (options.failed ?? 0),
      },
      managedNode: {
        count: async (args?: { where?: { certname: { notIn: string[] } } }) => {
          if (args?.where === undefined) return nodes.length;
          const excluded = new Set(args.where.certname.notIn);
          return nodes.filter((n) => !excluded.has(n)).length;
        },
        findMany: async (args: { where: { certname: { notIn: string[] } }; take: number }) => {
          const excluded = new Set(args.where.certname.notIn);
          return nodes
            .filter((n) => !excluded.has(n))
            .sort()
            .slice(0, args.take)
            .map((certname) => ({ certname }));
        },
      },
      encReplicationPeer: { findMany: async () => options.peers ?? [] },
      compileReceipt: {
        findMany: async (args: {
          where?: { revision?: string; certname?: { in: string[] } };
          distinct?: string[];
        }) => {
          let rows = receipts;
          if (args.where?.revision !== undefined) {
            rows = rows.filter((r) => r.revision === args.where?.revision);
          }
          if (args.where?.certname !== undefined) {
            const wanted = new Set(args.where.certname.in);
            rows = rows.filter((r) => wanted.has(r.certname));
          }
          if (args.distinct !== undefined) {
            const seen = new Set<string>();
            rows = rows.filter((r) =>
              seen.has(r.certname) ? false : (seen.add(r.certname), true),
            );
          }
          return rows.map((r) => ({ ...r, reportedAt: new Date() }));
        },
      },
    } as unknown as PrismaService;

    const reader = {
      readRevision: async () => (options.revision === undefined ? REV : options.revision),
    } as unknown as EncDocumentReader;

    return new PropagationService(prisma, reader, options.replicationEnabled ?? true);
  }

  it('counts a node as current when it reported this revision', async () => {
    const front = await build({
      nodes: ['a', 'b'],
      receipts: [
        { certname: 'a', revision: REV },
        { certname: 'b', revision: 'older' },
      ],
    }).front();

    expect(front.compiled).toEqual({ current: 1, reported: 2, total: 2 });
  });

  /*
   * A node compiling against two Puppet servers has a receipt from each. It is
   * one node either way, and served the current revision by any of them means
   * the change reached it.
   */
  it('counts a node once when several servers reported it', async () => {
    const front = await build({
      nodes: ['a'],
      receipts: [
        { certname: 'a', revision: REV },
        { certname: 'a', revision: REV },
      ],
    }).front();

    expect(front.compiled.current).toBe(1);
  });

  /*
   * EQUALITY, NOT RECENCY. A peer holding a different revision is behind
   * regardless of when it last fetched — the whole point of the rule.
   */
  it('counts a peer as current only when its revision matches exactly', async () => {
    const front = await build({
      peers: [
        { lastEtag: REV, lastChangedAt: new Date() },
        { lastEtag: 'older', lastChangedAt: new Date() },
      ],
    }).front();

    expect(front.replication).toEqual({ enabled: true, current: 1, total: 2 });
  });

  /*
   * A peer that never completed a transfer holds nothing, so its recorded etag
   * describes nothing — reachable and empty is the worst state and the easiest
   * to miss.
   */
  it('does not count a peer that has never received a tree', async () => {
    const front = await build({
      peers: [{ lastEtag: REV, lastChangedAt: null }],
    }).front();

    expect(front.replication.current).toBe(0);
  });

  it('reports replication as disabled rather than as zero peers', async () => {
    const front = await build({ replicationEnabled: false, peers: [] }).front();

    expect(front.replication.enabled).toBe(false);
  });

  /*
   * An unstamped tree makes every comparison impossible rather than false.
   * Reporting 0% propagated would be a confident wrong answer.
   */
  it('refuses to measure when the tree carries no revision', async () => {
    const front = await build({
      revision: null,
      nodes: ['a', 'b'],
      receipts: [{ certname: 'a', revision: REV }],
    }).front();

    expect(front.revision).toBeNull();
    expect(front.compiled.current).toBe(0);
    expect(front.outstanding).toEqual([]);
  });

  it('names outstanding nodes and says what they last reported', async () => {
    const front = await build({
      nodes: ['a', 'b', 'c'],
      receipts: [
        { certname: 'a', revision: REV },
        { certname: 'b', revision: 'older' },
      ],
    }).front();

    expect(front.outstandingTotal).toBe(2);
    expect(front.outstanding).toEqual([
      { certname: 'b', reportedRevision: 'older' },
      // Never reported at all — waiting for an agent run, not behind a puller.
      { certname: 'c', reportedRevision: null },
    ]);
  });

  it('is fully propagated when every node reported this revision', async () => {
    const front = await build({
      nodes: ['a'],
      receipts: [{ certname: 'a', revision: REV }],
    }).front();

    expect(front.outstandingTotal).toBe(0);
    expect(front.outstanding).toEqual([]);
  });

  it('carries the materialization backlog through', async () => {
    const front = await build({ pending: 3, failed: 2 }).front();

    expect(front.pending).toBe(3);
    expect(front.failed).toBe(2);
  });
});
