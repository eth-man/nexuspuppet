import { Injectable } from '@nestjs/common';
import type { PropagationFront } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { EncDocumentReader } from '../materialization/enc-document-reader';

/**
 * Where a classification change has actually got to (#147).
 *
 * NexusPuppet is the only thing in the estate that knows both the intent and
 * the outcome — it decides the classification and reads what happened. This
 * assembles that into one chain: written here, replicated to Puppet servers,
 * compiled by nodes.
 *
 * EVERY STAGE IS AN EQUALITY CHECK against the revision the tree currently
 * carries. Nothing here compares timestamps to decide state. That rule is the
 * whole value of the view: it is read during an incident, on hosts whose clocks
 * may disagree, and "it reported after we changed it" is not the same statement
 * as "it has the change".
 *
 * The counts read as PROGRESS, not as failure. A node that has not compiled the
 * current revision has usually just not run yet — agents check in on their own
 * schedule, and a view that calls that broken will be ignored in the routine
 * case and disbelieved in the real one.
 */

/** Names carried in the payload. Enough to act on, not enough to be a dump. */
const MAX_OUTSTANDING = 50;

@Injectable()
export class PropagationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: EncDocumentReader,
    private readonly replicationEnabled: boolean,
  ) {}

  async front(): Promise<PropagationFront> {
    const revision = await this.reader.readRevision().catch(() => null);

    const [newest, pending, failed, totalNodes, peers] = await Promise.all([
      this.prisma.encMaterialization.findFirst({
        orderBy: { writtenAt: 'desc' },
        select: { writtenAt: true },
      }),
      this.prisma.encMaterializationJob.count({ where: { status: 'PENDING' } }),
      this.prisma.encMaterializationJob.count({ where: { status: 'FAILED' } }),
      this.prisma.managedNode.count(),
      this.prisma.encReplicationPeer.findMany({ select: { lastEtag: true, lastChangedAt: true } }),
    ]);

    const base = {
      revision,
      materializedAt: newest?.writtenAt.toISOString() ?? null,
      pending,
      failed,
    };

    /*
     * No revision means the tree has never been stamped — a deployment older
     * than the stamp, or one whose materializer has not run. Every comparison
     * below would be against null and would report a fully un-propagated
     * estate, which is a confident wrong answer rather than an absent one.
     */
    if (revision === null) {
      return {
        ...base,
        replication: { enabled: this.replicationEnabled, current: 0, total: peers.length },
        compiled: { current: 0, reported: 0, total: totalNodes },
        outstanding: [],
        outstandingTotal: 0,
      };
    }

    /*
     * A peer is current when the revision it last fetched IS this one.
     *
     * `lastChangedAt === null` means it has never completed a transfer, so
     * `lastEtag` describes nothing it holds — reachable and empty, which is the
     * worst state and the easiest to miss.
     */
    const peersCurrent = peers.filter((p) => p.lastChangedAt !== null && p.lastEtag === revision);

    const [currentNodes, reportedNodes] = await Promise.all([
      // DISTINCT node, not row: a node compiling against two Puppet servers has
      // a receipt from each, and it is one node either way. Served the current
      // revision by any of them means the change reached it.
      this.prisma.compileReceipt.findMany({
        where: { revision },
        select: { certname: true },
        distinct: ['certname'],
      }),
      this.prisma.compileReceipt.findMany({ select: { certname: true }, distinct: ['certname'] }),
    ]);

    const currentSet = new Set(currentNodes.map((r) => r.certname));

    const [outstandingTotal, outstandingNodes] = await Promise.all([
      this.prisma.managedNode.count({ where: { certname: { notIn: [...currentSet] } } }),
      this.prisma.managedNode.findMany({
        where: { certname: { notIn: [...currentSet] } },
        select: { certname: true },
        orderBy: { certname: 'asc' },
        take: MAX_OUTSTANDING,
      }),
    ]);

    // What each outstanding node last reported, so the list distinguishes "has
    // not run yet" from "ran, and got an older classification". Those lead to
    // different places: the first is waiting, the second is a puller to check.
    const lastReported = new Map(
      (
        await this.prisma.compileReceipt.findMany({
          where: { certname: { in: outstandingNodes.map((n) => n.certname) } },
          select: { certname: true, revision: true, reportedAt: true },
          orderBy: { reportedAt: 'desc' },
        })
      ).map((r) => [r.certname, r.revision] as const),
    );

    return {
      ...base,
      replication: {
        enabled: this.replicationEnabled,
        current: peersCurrent.length,
        total: peers.length,
      },
      compiled: {
        current: currentSet.size,
        reported: reportedNodes.length,
        total: totalNodes,
      },
      outstanding: outstandingNodes.map((n) => ({
        certname: n.certname,
        reportedRevision: lastReported.get(n.certname) ?? null,
      })),
      outstandingTotal,
    };
  }
}
