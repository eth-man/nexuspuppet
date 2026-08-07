import type { Prisma } from '../generated/prisma';
import { Injectable, Logger } from '@nestjs/common';
import type { ClassificationConflict, PuppetValue } from '@nexuspuppet/contracts';
import { PrismaService, ADVISORY_LOCKS } from '../prisma/prisma.service';
import type { TransactionClient } from './materialization.service';
import type { IEncFileWriter } from '@nexuspuppet/contracts';
import { explainMatch, matchGroups, type EvaluableGroup } from './pure/rule-evaluator';
import { mergeGroups, type MergeableGroup } from './pure/class-merger';
import { renderEncDocument, renderDefaultDocument } from './pure/enc-yaml-renderer';

/**
 * The outbox drain that makes ADR-0003 work.
 *
 * A classification change is written to Postgres together with an
 * EncMaterializationJob row, in one transaction. This service turns those jobs
 * into YAML files on the shared volume. Until it does, the change is durable
 * but not yet effective — the UI must never imply otherwise.
 *
 * CLAIM-BY-DELETE
 * ---------------
 * Jobs are claimed by DELETING the row, not by flipping it to IN_PROGRESS.
 * That is deliberate, and it is what makes concurrent edits safe.
 *
 * `dedupeKey` is unique, so many edits to one group collapse into one job. But
 * if a claimed job stayed in the table while being processed, this could
 * happen:
 *
 *   1. worker claims job for node X and starts computing
 *   2. an operator changes X's classification; enqueue upserts the SAME
 *      dedupeKey, resetting it to PENDING
 *   3. worker finishes and marks the row DONE
 *   -> the edit from step 2 is silently swallowed, and X keeps the old
 *      classification until something else happens to touch it
 *
 * Deleting at claim time means step 2 inserts a FRESH row that nothing will
 * overwrite. The worst case becomes one redundant pass, because materialization
 * is idempotent and always recomputes from current database state. Losing a
 * committed classification change is not an acceptable failure mode; doing
 * slightly redundant work is.
 *
 * Only one materializer runs at a time, elected by a Postgres advisory lock,
 * so multiple api replicas never write the same file concurrently.
 */

export interface MaterializationOutcome {
  certname: string;
  changed: boolean;
  contentHash: string;
  conflicts: ClassificationConflict[];
  appliedGroupIds: string[];
}

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  filesChanged: number;
  /** False when another replica holds the lock; this tick did nothing. */
  ranHere: boolean;
}

/**
 * How the drain paces itself.
 *
 * Defaults are sized for a large estate rather than a fast one: a rule change
 * across ten thousand nodes should take a visible number of seconds and leave
 * the disk usable, not arrive as one burst that starves Postgres of the IOPS it
 * is sharing.
 */
export interface MaterializerPacing {
  /** Jobs claimed per batch, and so per lock acquisition. */
  batchSize: number;
  /** Nodes rewritten per chunk of a full reconcile. */
  reconcileChunkSize: number;
  /** Pause between batches: yields IOPS, and lets another replica take a turn. */
  batchDelayMs: number;
  /** Ceiling on one drain, so a tick cannot outrun its own interval forever. */
  maxDrainMs: number;
  /** Transaction timeout for a single batch. */
  batchTimeoutMs: number;
}

export const DEFAULT_PACING: MaterializerPacing = {
  batchSize: 50,
  reconcileChunkSize: 100,
  batchDelayMs: 100,
  maxDrainMs: 30_000,
  batchTimeoutMs: 30_000,
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class MaterializerService {
  private readonly logger = new Logger(MaterializerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: IEncFileWriter,
    private readonly maxAttempts: number,
    private readonly defaultEnvironment: string,
    private readonly pacing: MaterializerPacing = DEFAULT_PACING,
  ) {}

  /**
   * Write default.yaml so an unknown or not-yet-materialized node always gets a
   * defined classification instead of a catalog compilation failure (ADR-0003).
   */
  async ensureDefaultDocument(): Promise<void> {
    await this.writer.ensureLayout();
    const { yaml } = renderDefaultDocument(this.defaultEnvironment);
    await this.writer.writeDefault(yaml);
  }

  /** One drain pass. Safe to call concurrently from several replicas. */
  async drain(): Promise<DrainResult> {
    const deadline = Date.now() + this.pacing.maxDrainMs;
    const totals: DrainResult = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      filesChanged: 0,
      ranHere: false,
    };

    // One lock acquisition PER BATCH, not per drain.
    //
    // pg_try_advisory_xact_lock makes another replica skip rather than block,
    // so this was never a deadlock risk. Releasing between batches is what lets
    // a second replica take the next batch instead of idling, and stops one
    // transaction being held open across hundreds of fsyncs.
    for (;;) {
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Materializer drain hit its ${this.pacing.maxDrainMs}ms budget with work outstanding; ` +
            'the next tick continues where this left off.',
        );
        break;
      }

      const batch = await this.prisma.withAdvisoryLock(
        ADVISORY_LOCKS.ENC_MATERIALIZER,
        (tx) => this.drainLocked(tx),
        { timeoutMs: this.pacing.batchTimeoutMs },
      );

      // null means another replica holds the lock. Yield rather than spin.
      if (batch === null) break;

      totals.ranHere = true;
      totals.claimed += batch.claimed;
      totals.succeeded += batch.succeeded;
      totals.failed += batch.failed;
      totals.filesChanged += batch.filesChanged;

      if (batch.claimed === 0) break;

      // Pace the next batch. A rule change over a large estate is thousands of
      // fsyncs; unpaced they arrive as one burst and the disk — shared with
      // Postgres — is what suffers.
      if (this.pacing.batchDelayMs > 0) await delay(this.pacing.batchDelayMs);
    }

    return totals;
  }

  /**
   * One batch, inside the lock's transaction.
   *
   * Everything here reads and writes through `tx`. Reaching for the top-level
   * client would run on a different connection and commit independently — so a
   * rollback would leave the claim-by-delete applied and those jobs would be
   * lost with their work unfinished, which is precisely what the outbox exists
   * to prevent.
   */
  private async drainLocked(tx: TransactionClient): Promise<DrainResult> {
    const now = new Date();

    const jobs = await tx.encMaterializationJob.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: this.pacing.batchSize,
    });

    if (jobs.length === 0) {
      return { claimed: 0, succeeded: 0, failed: 0, filesChanged: 0, ranHere: true };
    }

    // Take ownership. See CLAIM-BY-DELETE above.
    await tx.encMaterializationJob.deleteMany({
      where: { id: { in: jobs.map((j) => j.id) } },
    });

    let succeeded = 0;
    let failed = 0;
    let filesChanged = 0;

    // Load classification once per batch rather than per node: at 1,000 nodes a
    // per-node reload would be 1,000 identical queries.
    const groups = await this.loadGroups(tx);

    for (const job of jobs) {
      try {
        const outcomes =
          job.kind === 'DELETE' && job.certname !== null
            ? [await this.deleteNode(job.certname, tx)]
            : job.certname === null
              ? await this.materializeChunk(tx, job, groups)
              : [await this.materializeNode(job.certname, groups, tx)];

        filesChanged += outcomes.filter((o) => o.changed).length;
        succeeded += 1;
      } catch (error) {
        failed += 1;
        await this.recordFailure(tx, job.dedupeKey, job.certname, job.reason, job.attempts, error);
      }
    }

    if (filesChanged > 0) {
      this.logger.log(`Materialized ${filesChanged} node file(s) from ${jobs.length} job(s).`);
    }

    return { claimed: jobs.length, succeeded, failed, filesChanged, ranHere: true };
  }

  /**
   * Re-enqueue a failed job with exponential backoff, or park it as FAILED once
   * it has exhausted its attempts.
   *
   * Upsert rather than insert: an operator may have edited the same node while
   * this job was in flight, in which case a fresh PENDING row already exists.
   * The newer request wins — it reflects more recent intent.
   */
  private async recordFailure(
    tx: TransactionClient,
    dedupeKey: string,
    certname: string | null,
    reason: string,
    previousAttempts: number,
    error: unknown,
  ): Promise<void> {
    const attempts = previousAttempts + 1;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const exhausted = attempts >= this.maxAttempts;

    // 2s, 4s, 8s, 16s... capped so a persistent failure does not drift into
    // never retrying at all.
    const backoffMs = Math.min(2000 * 2 ** (attempts - 1), 300_000);

    this.logger[exhausted ? 'error' : 'warn'](
      `Materialization ${exhausted ? 'FAILED permanently' : 'failed'} for ${certname ?? 'full reconcile'} ` +
        `(attempt ${attempts}/${this.maxAttempts}): ${message}`,
    );

    await tx.encMaterializationJob.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        certname,
        reason,
        attempts,
        lastError: message,
        status: exhausted ? 'FAILED' : 'PENDING',
        nextAttemptAt: new Date(Date.now() + backoffMs),
      },
      // A newer PENDING row means a fresh request arrived; do not clobber its
      // schedule with this failure's backoff.
      update: {},
    });
  }

  /** Recompute and write one node. Idempotent. */
  async materializeNode(
    certname: string,
    preloaded?: LoadedGroups,
    /**
     * What to read and write through.
     *
     * Defaults to the top-level client so callers outside a locked batch — the
     * reconciler's targeted repairs, tests — keep working unchanged. Inside a
     * batch the transaction MUST be passed, or the EncMaterialization row
     * commits independently of the job claim and a rollback leaves the two
     * disagreeing about what was written.
     */
    db: TransactionClient = this.prisma,
  ): Promise<MaterializationOutcome> {
    const groups = preloaded ?? (await this.loadGroups(db));

    const node = await db.managedNode.findUnique({ where: { certname } });

    // Facts come from the ManagedNode projection, never a live PuppetDB call —
    // otherwise a PuppetDB outage would block classification (ADR-0003/0004).
    const facts = (node?.facts ?? {}) as Record<string, unknown>;

    const matched = matchGroups({ certname, facts }, groups.evaluable);
    // Why each one matched, captured against the SAME facts that decided it
    // (#142). Explaining it later would judge a projection that has moved on.
    const matchReasons = matched.map((group) => explainMatch({ certname, facts }, group));
    const mergeable = matched.map((g) => groups.mergeableById.get(g.id)).filter(isPresent);

    const merged = mergeGroups(mergeable);
    const rendered = renderEncDocument(merged.document);

    const changed = await this.writer.writeNode(certname, rendered.yaml, rendered.contentHash);

    const existing = await db.encMaterialization.findUnique({ where: { certname } });

    // Only bump the revision when the content actually changed. Incrementing on
    // every pass would make the revision meaningless as a change signal.
    const revision = existing === null ? 1 : changed ? existing.revision + 1 : existing.revision;

    // Requires a ManagedNode row (foreign key). A node pinned before it has
    // ever checked in has no projection yet; its file is written, but there is
    // nothing to record against until the projector sees it.
    if (node !== null) {
      await db.encMaterialization.upsert({
        where: { certname },
        create: {
          certname,
          contentHash: rendered.contentHash,
          revision,
          relativePath: `nodes/${certname}.yaml`,
          appliedGroupIds: merged.appliedGroupIds,
          conflicts: merged.conflicts as unknown as PuppetValue[],
          attribution: merged.attribution as unknown as Prisma.InputJsonObject,
          matchReasons: matchReasons as unknown as Prisma.InputJsonArray,
        },
        update: {
          contentHash: rendered.contentHash,
          revision,
          appliedGroupIds: merged.appliedGroupIds,
          conflicts: merged.conflicts as unknown as PuppetValue[],
          attribution: merged.attribution as unknown as Prisma.InputJsonObject,
          matchReasons: matchReasons as unknown as Prisma.InputJsonArray,
          writtenAt: new Date(),
        },
      });
    }

    return {
      certname,
      changed,
      contentHash: rendered.contentHash,
      conflicts: merged.conflicts,
      appliedGroupIds: merged.appliedGroupIds,
    };
  }

  /**
   * Remove a purged node's ENC file and its materialization record.
   *
   * Hard deletion, not a tombstone. The ENC script treats a missing node file
   * as "fall back to default.yaml", which is a defined, safe classification —
   * whereas a tombstone is indistinguishable to that script from a real
   * classification, so it would silently override the default and then diverge
   * from it, while accumulating a file per node that no longer exists.
   *
   * Safe to get wrong in one direction only, and it is the harmless one: the
   * file is derived state, so a node that returns is simply rewritten.
   */
  private async deleteNode(
    certname: string,
    tx: TransactionClient,
  ): Promise<MaterializationOutcome> {
    await this.writer.removeNode(certname);

    // May already be gone via cascade when the ManagedNode row was deleted.
    await tx.encMaterialization.deleteMany({ where: { certname } });

    this.logger.log(`Removed ENC file for purged node ${certname}.`);

    return {
      certname,
      // A removal IS a change to what puppetserver will serve, and counting it
      // is what makes the drain's "files changed" figure honest.
      changed: true,
      contentHash: '',
      conflicts: [],
      appliedGroupIds: [],
    };
  }

  /**
   * Advance a full reconcile by one bounded chunk.
   *
   * A full reconcile touches every node, which at ten thousand nodes is ten
   * thousand file writes inside a single job — far longer than any lock or
   * transaction should be held. Instead it walks the estate in certname order,
   * writes at most `reconcileChunkSize` nodes, and re-enqueues itself carrying
   * a cursor when more remain.
   *
   * Ordering by certname is what makes the cursor a cursor: a total order that
   * is stable across chunks, so nothing is skipped or written twice even if
   * nodes appear or disappear between them.
   */
  private async materializeChunk(
    tx: TransactionClient,
    job: { dedupeKey: string; reason: string; cursor: string | null },
    groups: LoadedGroups,
  ): Promise<MaterializationOutcome[]> {
    const nodes = await tx.managedNode.findMany({
      where: job.cursor === null ? {} : { certname: { gt: job.cursor } },
      select: { certname: true },
      orderBy: { certname: 'asc' },
      take: this.pacing.reconcileChunkSize,
    });

    const outcomes: MaterializationOutcome[] = [];
    for (const { certname } of nodes) {
      outcomes.push(await this.materializeNode(certname, groups, tx));
    }

    const last = nodes.at(-1)?.certname;
    const mightHaveMore = nodes.length === this.pacing.reconcileChunkSize && last !== undefined;

    if (mightHaveMore) {
      // Re-enqueue from where this chunk stopped. Upsert with an empty update
      // so a NEWER full reconcile queued while this one ran is left alone —
      // that request starts from the beginning, which is what a fresh request
      // means.
      await tx.encMaterializationJob.upsert({
        where: { dedupeKey: job.dedupeKey },
        create: {
          dedupeKey: job.dedupeKey,
          certname: null,
          reason: job.reason,
          cursor: last,
          // Immediately eligible: pacing between batches is the drain loop's
          // job, and a backoff here would stall a reconcile that is working.
          nextAttemptAt: new Date(),
        },
        update: {},
      });

      this.logger.log(`Full reconcile advanced through ${last}; re-queued to continue.`);
    }

    return outcomes;
  }

  /**
   * Load the full classification set and shape it for the pure evaluator and
   * merger. One query set per tick.
   */
  /**
   * @param options.includeDisabled load disabled groups too.
   *
   * Materialization never wants them — a disabled group classifies nothing, and
   * excluding them at the query level is cheaper than filtering later. The
   * PLANNER does: "what would enabling this group do?" is a change whose blast
   * radius an operator most wants to see before making it, and it cannot be
   * previewed against a set the group was excluded from. `groupMatches` checks
   * `isEnabled` independently, so including them here never changes what
   * materialization produces.
   */
  async loadGroups(
    db: TransactionClient = this.prisma,
    options: { includeDisabled?: boolean } = {},
  ): Promise<LoadedGroups> {
    const rows = await db.nodeGroup.findMany({
      where: options.includeDisabled === true ? {} : { isEnabled: true },
      include: { rules: true, classes: true, parameters: true, pins: true },
    });

    const evaluable: EvaluableGroup[] = [];
    const mergeableById = new Map<string, MergeableGroup>();

    for (const row of rows) {
      evaluable.push({
        id: row.id,
        name: row.name,
        rank: row.rank,
        strategy: row.strategy,
        isEnabled: row.isEnabled,
        rules: row.rules.map((r) => ({
          factPath: r.factPath,
          operator: r.operator,
          ...(r.value === null ? {} : { value: r.value as unknown }),
        })),
        pinnedCertnames: row.pins.map((p) => p.certname),
      });

      mergeableById.set(row.id, {
        id: row.id,
        name: row.name,
        environment: row.environment,
        classes: Object.fromEntries(
          row.classes.map((c) => [c.className, (c.params ?? {}) as Record<string, PuppetValue>]),
        ),
        parameters: Object.fromEntries(row.parameters.map((p) => [p.key, p.value as PuppetValue])),
      });
    }

    return { evaluable, mergeableById };
  }
}

export interface LoadedGroups {
  evaluable: EvaluableGroup[];
  mergeableById: Map<string, MergeableGroup>;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
