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

const POLL_MAX_NODES = 500;

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
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastResult: ProjectionResult | null = null;
  private stopping = false;
  /**
   * Warn once per process about projected facts no node reports.
   *
   * Once, not every pass: the projector runs every five minutes, and a
   * five-minutely warning becomes something operators filter out — which is how
   * a condition like this stays invisible in the first place.
   */
  private warnedAbsentFacts = false;
  /**
   * The last computed set of projected facts no node reports.
   *
   * Retained rather than only logged. The warning fires once per process, so a
   * console started after it would show nothing — and the condition is exactly
   * the kind that is discovered months later when someone asks why a group
   * classifies nobody.
   */
  private absentFacts: readonly string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient,
    private readonly materialization: MaterializationService,
    private readonly projectedFacts: readonly string[],
    private readonly intervalMs: number = 300_000,
    /**
     * How often to ask PuppetDB for nodes whose facts changed.
     *
     * Far more frequent than the full sweep and far cheaper: typically zero
     * rows, and facts are fetched only for what came back. 0 disables it and
     * leaves behaviour exactly as it was.
     */
    private readonly pollIntervalMs: number = 30_000,
    /**
     * How far back to look beyond the watermark.
     *
     * PuppetDB's facts_timestamp comes from the agent, so clocks differ and
     * several nodes can share a boundary second. A strict `>` on the exact
     * high-water mark silently drops whatever sat on that boundary. Rewriting a
     * handful of unchanged nodes costs one content hash each and changes
     * nothing, because materialization is idempotent and hash-gated.
     */
    private readonly pollOverlapMs: number = 120_000,
  ) {}

  onModuleInit(): void {
    if (this.intervalMs <= 0) return;

    // Deliberately NOT awaited: a PuppetDB that is slow or unreachable at boot
    // must not delay or prevent startup. Classification does not depend on it
    // (ADR-0003), so the API must come up and serve regardless.
    void this.tick();

    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();

    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.pollTick(), this.pollIntervalMs);
      this.pollTimer.unref();
      this.logger.log(
        `Incremental fact poll running every ${this.pollIntervalMs}ms ` +
          `(${this.pollOverlapMs}ms overlap).`,
      );
    }

    this.logger.log(
      `Node projection running every ${this.intervalMs}ms for facts: ${this.projectedFacts.join(', ') || '(none)'}`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
  }

  private async pollTick(): Promise<void> {
    if (this.running || this.stopping) return;
    try {
      await this.pollChangedFacts();
    } catch (error) {
      // Never fatal. A failed poll costs latency until the next one; the full
      // sweep remains the backstop.
      this.logger.warn(
        `Incremental fact poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Refresh only the nodes whose facts changed since the last one we saw.
   *
   * The point is latency: a fact change alters group membership with no
   * classification edit to trigger it, and waiting for the full sweep leaves a
   * node misclassified for as long as that interval.
   *
   * THIS NEVER PRUNES AND NEVER MARKS DEACTIVATION, and that is structural
   * rather than an oversight. An incremental result is a partial view by
   * construction, so treating absence from it as absence from PuppetDB would
   * read every quiet poll as an estate that had vanished. Only the full sweep,
   * which asks for everything, is entitled to draw conclusions from absence.
   */
  async pollChangedFacts(): Promise<{ scanned: number; refreshed: number; since: string | null }> {
    if (this.running || this.projectedFacts.length === 0) {
      return { scanned: 0, refreshed: 0, since: null };
    }

    const since = await this.watermark();
    if (since === null) {
      // Nothing projected yet: there is no "since", and asking for everything
      // here would duplicate the full sweep at poll frequency.
      return { scanned: 0, refreshed: 0, since: null };
    }

    const changed = await this.puppetdb.listNodes(
      // Active only. A deactivated node is not reporting new facts, and the
      // full sweep owns its lifecycle.
      { factsChangedSince: since, includeInactive: false },
      { limit: POLL_MAX_NODES, offset: 0, order: 'asc', orderBy: 'facts_timestamp' },
    );

    if (changed.items.length === 0) return { scanned: 0, refreshed: 0, since };

    // A burst larger than this is a mass agent run, and fetching facts one node
    // at a time would be slower than the sweep that is about to happen anyway.
    if (changed.total > POLL_MAX_NODES) {
      this.logger.log(
        `Incremental poll saw ${changed.total} changed nodes, more than the ${POLL_MAX_NODES} ` +
          'it will handle; the full sweep will cover the remainder.',
      );
    }

    let refreshed = 0;
    for (const node of changed.items) {
      if (this.stopping) break;

      // Per-node fetch, not the estate-wide fact query the sweep uses: the
      // whole saving here is not reading facts for nodes that did not change.
      const facts = pick(await this.puppetdb.getFacts(node.certname), this.projectedFacts);
      if (await this.upsertNode(node, facts)) refreshed += 1;
    }

    if (refreshed > 0) {
      this.logger.log(
        `Incremental poll: ${refreshed} of ${changed.items.length} node(s) had changed facts and were requeued.`,
      );
    }

    return { scanned: changed.items.length, refreshed, since };
  }

  /**
   * Where to resume from: the newest facts timestamp already projected, less an
   * overlap.
   *
   * Derived rather than stored. No extra table, correct after a restart, and
   * consistent across replicas because it comes from the shared row set the
   * projection already maintains.
   *
   * Capped at now(): a single agent with a clock set a year fast would
   * otherwise push the watermark into the future and starve every other node
   * from ever being polled again.
   */
  private async watermark(): Promise<string | null> {
    const newest = await this.prisma.managedNode.aggregate({
      _max: { factsTimestamp: true },
    });

    const latest = newest._max.factsTimestamp;
    if (latest === null || latest === undefined) return null;

    const capped = Math.min(latest.getTime(), Date.now());
    return new Date(capped - this.pollOverlapMs).toISOString();
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

    /*
     * Retained ONLY when this replica actually ran it.
     *
     * A run another replica won returns ranHere: false with zeroed counts, and
     * storing that would erase a real result — including a pruneSkippedReason
     * that something is watching for. Losing the reason is how the
     * implausibly-small-response guard goes back to being invisible.
     */
    if (result !== null && result.ranHere) this.lastResult = result;

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

  /**
   * The last projection THIS replica ran, or null if it has not run one.
   *
   * Read by anything that needs to notice a state the projector only logs —
   * a refused prune, in particular, which means the estate looked
   * implausibly small and we deliberately did nothing.
   */
  lastProjection(): ProjectionResult | null {
    return this.lastResult;
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
    /** Top-level fact names actually seen, to compare against the allow-list. */
    const observed = new Set<string>();

    for (const node of nodes) {
      // Deactivated nodes ARE retained, contrary to how this once worked.
      //
      // Deactivation is reversible — a node returns by checking in again — and
      // PuppetDB purges for real on node-purge-ttl. Deleting a deactivated
      // node's classification would invent a second, competing notion of
      // "gone", and churn a file that is about to be needed again. Its facts
      // are left as they were: the node is not reporting, so there is nothing
      // newer to record.
      if (!node.isActive) {
        // Only nodes we already knew. A node that was ALREADY deactivated the
        // first time PuppetDB showed it to us has no classification to retain,
        // and inventing one would classify a machine that is not reporting —
        // the churn this design exists to avoid. It is counted only if a row
        // was actually touched, so the figure means what it says.
        if (await this.markDeactivated(node.certname)) upserted += 1;
        continue;
      }

      const projected = pick(facts.get(node.certname) ?? {}, this.projectedFacts);
      for (const name of Object.keys(projected)) observed.add(name);

      const didChange = await this.upsertNode(node, projected);
      upserted += 1;
      if (didChange) changed += 1;
    }

    this.warnAbsentFacts(observed, nodes.length);

    // Everything PuppetDB still knows about, active or not. Pruning is about
    // ABSENCE, not about state: a node listed here has not been purged.
    const known = nodes.map((n) => n.certname);
    const pruneDecision = await this.shouldPrune(nodes.length);

    let pruned = 0;
    if (pruneDecision.prune) {
      pruned = await this.prune(known);
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
          // A node reporting again is no longer deactivated. Without clearing
          // this, a returned node would stay flagged forever.
          deactivated: false,
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
  /**
   * Remove nodes PuppetDB no longer knows about at all, and queue removal of
   * their ENC files.
   *
   * One transaction, because the domain change and its outbox row must not be
   * separable: a prune committing without its jobs leaves files classifying
   * nodes that no longer exist, repaired only by the periodic reconcile up to
   * fifteen minutes later.
   *
   * The certnames are read BEFORE the delete — afterwards there is nothing left
   * to read, and the jobs have to name the nodes whose files they remove.
   */
  private async prune(knownCertnames: readonly string[]): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const doomed = await tx.managedNode.findMany({
        where: { certname: { notIn: [...knownCertnames] } },
        select: { certname: true },
      });

      if (doomed.length === 0) return 0;

      const certnames = doomed.map((n) => n.certname);

      await tx.managedNode.deleteMany({ where: { certname: { in: certnames } } });
      await this.materialization.enqueueNodeDeletions(tx, certnames, 'node-purged');

      this.logger.log(
        `Purged ${certnames.length} node(s) absent from PuppetDB; ` +
          'queued their ENC files for removal.',
      );

      return certnames.length;
    });
  }

  /**
   * Record that a node is deactivated, retaining its facts and its file.
   *
   * No materialization is queued: nothing about its classification changed, and
   * re-materializing every deactivated node on every cycle is exactly the churn
   * this design exists to avoid.
   */
  /**
   * Name the projected facts NO node reports.
   *
   * A fact in the allow-list that nothing reports is not merely wasteful: a
   * classification rule written against it can never match, and nothing
   * anywhere reports an error. The group just silently classifies nothing.
   *
   * This is how that becomes visible. It found three in our own default —
   * `fqdn`, `domain` and `role` — after Facter 4 dropped the legacy flat facts,
   * which is why the default no longer contains them.
   *
   * Absence is only meaningful against a non-empty estate: with no nodes, every
   * fact is trivially absent and the warning would be noise during bootstrap.
   */
  /** For the status surface: what the last projection pass observed. */
  factsNoNodeReports(): readonly string[] {
    return this.absentFacts;
  }

  private warnAbsentFacts(observed: ReadonlySet<string>, nodeCount: number): void {
    if (nodeCount === 0 || this.projectedFacts.length === 0) return;

    const absent = this.projectedFacts.filter((name) => !observed.has(name));
    // Recorded on every pass, including when it becomes empty — otherwise a
    // fixed configuration would keep reporting a problem that no longer exists.
    this.absentFacts = absent;
    if (absent.length === 0) return;

    // The RECORD above updates every pass; the LOG below happens once. A
    // five-minutely warning is one operators filter out, but a status surface
    // that goes stale is worse than one that repeats.
    if (this.warnedAbsentFacts) return;
    this.warnedAbsentFacts = true;
    this.logger.warn(
      `PUPPETDB_PROJECTED_FACTS names ${absent.length} fact(s) that NO node reports: ` +
        `${absent.join(', ')}. A classification rule on any of them can never match. ` +
        'Facter 4 nests the old flat facts — fqdn and domain live under `networking` — ' +
        'so check the path before removing the rule.',
    );
  }

  private async markDeactivated(certname: string): Promise<boolean> {
    const { count } = await this.prisma.managedNode.updateMany({
      where: { certname },
      data: { deactivated: true, projectedAt: new Date() },
    });
    return count > 0;
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
