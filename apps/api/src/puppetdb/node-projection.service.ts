import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  PUPPETDB_CLIENT,
  PuppetDbUnavailableError,
  type FactRow,
  type IPuppetDbClient,
  type PuppetNode,
} from '@nexuspuppet/contracts';
import { PrismaService, ADVISORY_LOCKS } from '../prisma/prisma.service';
import { MaterializationService } from '../materialization/materialization.service';

/**
 * Projects PuppetDB into the ManagedNode cache (ADR-0004).
 *
 * WHY THIS EXISTS
 * ---------------
 * Rule matching runs against `ManagedNode.facts`, never against a live
 * PuppetDB query. If materialization called PuppetDB, a PuppetDB outage would
 * block classification changes — reintroducing exactly the coupling ADR-0003
 * exists to remove. This service is the seam that keeps those two systems
 * independent.
 *
 * A fact change can change group membership with no classification edit to
 * trigger it, so a node whose projected facts changed is enqueued for
 * rematerialization IN THE SAME TRANSACTION as the projection write.
 *
 * PRUNING IS THE DANGEROUS PART
 * -----------------------------
 * The obvious implementation — "delete every ManagedNode not in the response"
 * — is catastrophic under partial failure. A transient error midway through
 * pagination yields a short list, and the naive rule then deletes most of the
 * estate's projection. Deleting ManagedNode cascades to EncMaterialization,
 * the reconciler subsequently sees the files as orphans and removes them, and
 * every affected node silently falls back to default.yaml. A momentary network
 * blip would unclassify the fleet.
 *
 * So pruning happens ONLY when the fetch completed in full, and even then only
 * when the result is plausible — see `shouldPrune`.
 */

export interface ProjectionResult {
  /** False when another replica holds the lock; this run did nothing. */
  ranHere: boolean;
  nodesSeen: number;
  nodesUpserted: number;
  /** Nodes whose projected facts or environment changed, and were requeued. */
  nodesChanged: number;
  nodesPruned: number;
  pruneSkippedReason: string | null;
  error: string | null;
}

const PAGE_SIZE = 500;

/**
 * Refuse to prune when the estate appears to have shrunk by more than this.
 * A genuine decommission of >50% in one interval is possible but rare enough
 * that a human should confirm it; a partial fetch is far more likely.
 */
const MAX_SAFE_SHRINK_RATIO = 0.5;

@Injectable()
export class NodeProjectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NodeProjectionService.name);

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient,
    private readonly materialization: MaterializationService,
    private readonly projectedFacts: readonly string[],
    private readonly intervalMs: number = 300_000,
  ) {}

  onModuleInit(): void {
    if (this.intervalMs <= 0) return;

    // Deliberately NOT awaited: a PuppetDB that is slow or unreachable at boot
    // must not delay or prevent startup. Classification does not depend on it
    // (ADR-0003), so the API must come up and serve regardless.
    void this.tick();

    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();

    this.logger.log(
      `Node projection running every ${this.intervalMs}ms for facts: ${this.projectedFacts.join(', ') || '(none)'}`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** One projection pass, guarded against overlapping with itself. */
  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;

    try {
      await this.project();
    } catch (error) {
      // A throw must never kill the timer; the next tick retries.
      this.logger.error(
        `Projection tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async project(): Promise<ProjectionResult> {
    const result = await this.prisma.withAdvisoryLock(ADVISORY_LOCKS.NODE_PROJECTION, async () =>
      this.projectLocked(),
    );

    return (
      result ?? {
        ranHere: false,
        nodesSeen: 0,
        nodesUpserted: 0,
        nodesChanged: 0,
        nodesPruned: 0,
        pruneSkippedReason: null,
        error: null,
      }
    );
  }

  private async projectLocked(): Promise<ProjectionResult> {
    const base: ProjectionResult = {
      ranHere: true,
      nodesSeen: 0,
      nodesUpserted: 0,
      nodesChanged: 0,
      nodesPruned: 0,
      pruneSkippedReason: null,
      error: null,
    };

    let nodes: PuppetNode[];
    let facts: Map<string, Record<string, unknown>>;

    try {
      nodes = await this.fetchAllNodes();
      facts = await this.fetchAllFacts();
    } catch (error) {
      // Keep the existing projection. Classification continues against
      // slightly stale facts, which is the whole point of caching them
      // (ADR-0003). Wiping on failure would be far worse than being stale.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Projection skipped — PuppetDB unavailable: ${message}. ` +
          'Existing facts are retained; classification is unaffected.',
      );
      return { ...base, error: message };
    }

    let upserted = 0;
    let changed = 0;

    for (const node of nodes) {
      // A deactivated or expired node must not be classified. It is pruned
      // below rather than projected.
      if (!node.isActive) continue;

      const projected = pick(facts.get(node.certname) ?? {}, this.projectedFacts);

      const didChange = await this.upsertNode(node, projected);
      upserted += 1;
      if (didChange) changed += 1;
    }

    const active = nodes.filter((n) => n.isActive);
    const pruneDecision = await this.shouldPrune(active.length);

    let pruned = 0;
    if (pruneDecision.prune) {
      pruned = await this.prune(active.map((n) => n.certname));
    } else if (pruneDecision.reason !== null) {
      this.logger.warn(`Prune skipped: ${pruneDecision.reason}`);
    }

    if (changed > 0 || pruned > 0) {
      this.logger.log(
        `Projection: ${upserted} node(s) refreshed, ${changed} with changed facts requeued, ${pruned} pruned.`,
      );
    }

    return {
      ...base,
      nodesSeen: nodes.length,
      nodesUpserted: upserted,
      nodesChanged: changed,
      nodesPruned: pruned,
      pruneSkippedReason: pruneDecision.reason,
    };
  }

  /**
   * Write one node's projection and, if its facts changed, enqueue it — both in
   * one transaction, so a change can never be recorded without the work to act
   * on it (ADR-0005).
   *
   * @returns true when the projected facts or environment actually changed.
   */
  private async upsertNode(node: PuppetNode, projected: Record<string, unknown>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.managedNode.findUnique({
        where: { certname: node.certname },
        select: { facts: true, environment: true },
      });

      // Compare only what rule evaluation actually reads. Timestamps change on
      // every run; requeuing on those would rematerialize the whole estate
      // every projection cycle for no reason.
      const changed =
        existing === null ||
        existing.environment !== node.environment ||
        !stableEquals(existing.facts, projected);

      await tx.managedNode.upsert({
        where: { certname: node.certname },
        create: {
          certname: node.certname,
          environment: node.environment,
          facts: projected as object,
          latestReportStatus: node.latestReportStatus,
          reportTimestamp: toDate(node.reportTimestamp),
          factsTimestamp: toDate(node.factsTimestamp),
          expired: node.expired !== null,
          projectedAt: new Date(),
        },
        update: {
          environment: node.environment,
          facts: projected as object,
          latestReportStatus: node.latestReportStatus,
          reportTimestamp: toDate(node.reportTimestamp),
          factsTimestamp: toDate(node.factsTimestamp),
          expired: node.expired !== null,
          projectedAt: new Date(),
        },
      });

      if (changed) {
        // A fact change can alter group membership with no classification edit
        // to trigger it.
        await this.materialization.enqueueNode(tx, node.certname, 'facts-changed');
      }

      return changed;
    });
  }

  /**
   * Decide whether pruning is safe.
   *
   * The failure this guards against is a partial fetch being mistaken for a
   * shrunken estate. Being stale is recoverable; unclassifying the fleet
   * because of a network blip is not.
   */
  private async shouldPrune(
    activeCount: number,
  ): Promise<{ prune: boolean; reason: string | null }> {
    const known = await this.prisma.managedNode.count();

    if (known === 0) return { prune: false, reason: null };

    if (activeCount === 0) {
      return {
        prune: false,
        reason:
          `PuppetDB reported 0 active nodes while ${known} are cached. ` +
          'Treating this as a failed query rather than an emptied estate.',
      };
    }

    const shrink = (known - activeCount) / known;
    if (shrink > MAX_SAFE_SHRINK_RATIO) {
      return {
        prune: false,
        reason:
          `PuppetDB reported ${activeCount} active nodes, down from ${known} cached ` +
          `(${Math.round(shrink * 100)}% drop). Refusing to prune automatically — ` +
          'run a manual reconcile if the decommission is genuine.',
      };
    }

    return { prune: true, reason: null };
  }

  /**
   * Remove nodes PuppetDB no longer reports as active.
   *
   * Deleting ManagedNode cascades to EncMaterialization; the reconciler then
   * removes the orphaned YAML, so a decommissioned node stops being classified
   * rather than keeping its last configuration forever.
   */
  private async prune(activeCertnames: readonly string[]): Promise<number> {
    const { count } = await this.prisma.managedNode.deleteMany({
      where: { certname: { notIn: [...activeCertnames] } },
    });
    return count;
  }

  /** Page through the whole node list. Throws if any page fails. */
  private async fetchAllNodes(): Promise<PuppetNode[]> {
    const all: PuppetNode[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.puppetdb.listNodes(
        // Inactive nodes are fetched so they can be pruned, not projected.
        { includeInactive: true },
        { limit: PAGE_SIZE, offset, order: 'asc', orderBy: 'certname' },
      );

      all.push(...page.items);
      offset += page.items.length;

      // Guard against a server that ignores paging and would loop forever.
      if (page.items.length === 0 || all.length >= page.total) break;
    }

    return all;
  }

  /** Page through the projected facts for the whole estate, keyed by certname. */
  private async fetchAllFacts(): Promise<Map<string, Record<string, unknown>>> {
    const byNode = new Map<string, Record<string, unknown>>();
    if (this.projectedFacts.length === 0) return byNode;

    let offset = 0;

    for (;;) {
      const page = await this.puppetdb.listFacts(this.projectedFacts, {
        limit: PAGE_SIZE,
        offset,
        order: 'asc',
      });

      for (const row of page.items as FactRow[]) {
        const existing = byNode.get(row.certname) ?? {};
        existing[row.name] = row.value;
        byNode.set(row.certname, existing);
      }

      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }

    return byNode;
  }
}

function pick(
  facts: Record<string, unknown>,
  allowList: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowList) {
    if (Object.prototype.hasOwnProperty.call(facts, key)) out[key] = facts[key];
  }
  return out;
}

/**
 * Order-insensitive structural comparison.
 *
 * PuppetDB does not guarantee key order, and a plain JSON.stringify comparison
 * would report a change whenever ordering shifted — requeuing the entire estate
 * for materialization on every cycle.
 */
function stableEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function toDate(iso: string | null): Date | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

export { PuppetDbUnavailableError };
