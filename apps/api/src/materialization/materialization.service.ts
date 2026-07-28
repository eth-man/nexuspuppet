import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/**
 * Enqueues materialization work (ADR-0003, ADR-0005).
 *
 * THE ONLY CORRECT WAY TO USE THIS is inside the same transaction as the
 * classification change that caused it:
 *
 *   await prisma.$transaction(async (tx) => {
 *     await tx.nodeGroupClass.create({ ... });
 *     await tx.auditLog.create({ ... });
 *     await materialization.enqueueForGroup(tx, groupId, 'class-added');
 *   });
 *
 * Every method takes a transaction client for exactly that reason. Enqueuing
 * outside the transaction reintroduces the failure the outbox exists to
 * prevent: the change commits, the process dies before the job is written, and
 * a thousand machines keep running the old configuration while the UI shows
 * the new one. There is no "saved" state that is not also "queued".
 */
@Injectable()
export class MaterializationService {
  /**
   * Queue one node.
   *
   * `dedupeKey` collapses repeated requests: twenty edits to a node before the
   * worker runs produce one materialization, not twenty. `update: {}` keeps the
   * existing row's schedule rather than resetting a backoff that is mid-retry.
   */
  async enqueueNode(tx: TransactionClient, certname: string, reason: string): Promise<void> {
    await tx.encMaterializationJob.upsert({
      where: { dedupeKey: `node:${certname}` },
      create: { dedupeKey: `node:${certname}`, certname, reason },
      update: { status: 'PENDING', nextAttemptAt: new Date(), reason },
    });
  }

  /**
   * Queue removal of a purged node's ENC file.
   *
   * A SEPARATE dedupe namespace from enqueueNode. Sharing one would let a
   * delete and a re-materialize for the same certname collapse into whichever
   * arrived second — so a node that is purged and then returns could end up
   * with its file deleted after it was legitimately rewritten.
   *
   * Both jobs coexisting is correct and ordered by createdAt: the delete runs,
   * then the rewrite, and the node ends up classified.
   */
  async enqueueNodeDeletion(
    tx: TransactionClient,
    certname: string,
    reason: string,
  ): Promise<void> {
    await tx.encMaterializationJob.upsert({
      where: { dedupeKey: `delete:${certname}` },
      create: { dedupeKey: `delete:${certname}`, certname, reason, kind: 'DELETE' },
      update: { status: 'PENDING', nextAttemptAt: new Date(), reason },
    });
  }

  async enqueueNodeDeletions(
    tx: TransactionClient,
    certnames: readonly string[],
    reason: string,
  ): Promise<void> {
    for (const certname of certnames) {
      await this.enqueueNodeDeletion(tx, certname, reason);
    }
  }

  async enqueueNodes(
    tx: TransactionClient,
    certnames: readonly string[],
    reason: string,
  ): Promise<void> {
    for (const certname of certnames) {
      await this.enqueueNode(tx, certname, reason);
    }
  }

  /**
   * Queue every node a group currently affects.
   *
   * Deliberately resolves membership at enqueue time rather than queueing "the
   * group": a node that MATCHED before an edit may not match after it, and it
   * still needs rewriting. Callers deleting or narrowing a group must capture
   * the affected certnames BEFORE the change — see enqueueFullReconcile for the
   * cases where that is impractical.
   */
  async enqueueForGroup(tx: TransactionClient, groupId: string, reason: string): Promise<void> {
    const pins = await tx.nodeGroupPin.findMany({
      where: { groupId },
      select: { certname: true },
    });

    const materialized = await tx.encMaterialization.findMany({
      where: { appliedGroupIds: { has: groupId } },
      select: { certname: true },
    });

    const affected = new Set([
      ...pins.map((p) => p.certname),
      ...materialized.map((m) => m.certname),
    ]);

    // A rule-based group's membership is a function of facts, so an edit can
    // pull in nodes that have never matched it before. Those are not knowable
    // from the group's current membership, and a full reconcile is the only
    // correct answer.
    const group = await tx.nodeGroup.findUnique({
      where: { id: groupId },
      select: { strategy: true },
    });

    if (group !== null && group.strategy !== 'PINNED') {
      await this.enqueueFullReconcile(tx, reason);
      return;
    }

    await this.enqueueNodes(tx, [...affected], reason);
  }

  /**
   * Queue a full sweep: every node recomputed, orphaned files removed.
   *
   * One job, not N. The worker expands it, so a burst of group edits does not
   * insert a row per node per edit.
   */
  async enqueueFullReconcile(tx: TransactionClient, reason: string): Promise<void> {
    await tx.encMaterializationJob.upsert({
      where: { dedupeKey: 'full-reconcile' },
      create: { dedupeKey: 'full-reconcile', certname: null, reason },
      update: { status: 'PENDING', nextAttemptAt: new Date(), reason },
    });
  }
}

/**
 * Accepts either the PrismaClient or a transaction client, so callers are
 * pushed toward passing `tx` without needing a second set of methods.
 */
export type TransactionClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
