import { Injectable, Logger } from '@nestjs/common';
import type { ClassificationConflict, PuppetValue } from '@nexuspuppet/contracts';
import { PrismaService, ADVISORY_LOCKS } from '../prisma/prisma.service';
import { EncFileWriter } from './enc-file-writer';
import { matchGroups, type EvaluableGroup } from './pure/rule-evaluator';
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

const MAX_JOBS_PER_TICK = 500;

@Injectable()
export class MaterializerService {
  private readonly logger = new Logger(MaterializerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: EncFileWriter,
    private readonly maxAttempts: number,
    private readonly defaultEnvironment: string,
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
    const empty: DrainResult = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      filesChanged: 0,
      ranHere: false,
    };

    const result = await this.prisma.withAdvisoryLock(ADVISORY_LOCKS.ENC_MATERIALIZER, async () =>
      this.drainLocked(),
    );

    return result ?? empty;
  }

  private async drainLocked(): Promise<DrainResult> {
    const now = new Date();

    const jobs = await this.prisma.encMaterializationJob.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: MAX_JOBS_PER_TICK,
    });

    if (jobs.length === 0) {
      return { claimed: 0, succeeded: 0, failed: 0, filesChanged: 0, ranHere: true };
    }

    // Take ownership. See CLAIM-BY-DELETE above.
    await this.prisma.encMaterializationJob.deleteMany({
      where: { id: { in: jobs.map((j) => j.id) } },
    });

    let succeeded = 0;
    let failed = 0;
    let filesChanged = 0;

    // Load classification once per tick rather than per node: at 1,000 nodes a
    // per-node reload would be 1,000 identical queries.
    const groups = await this.loadGroups();

    for (const job of jobs) {
      try {
        const outcomes =
          job.certname === null
            ? await this.materializeAll(groups)
            : [await this.materializeNode(job.certname, groups)];

        filesChanged += outcomes.filter((o) => o.changed).length;
        succeeded += 1;
      } catch (error) {
        failed += 1;
        await this.recordFailure(job.dedupeKey, job.certname, job.reason, job.attempts, error);
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

    await this.prisma.encMaterializationJob.upsert({
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
  ): Promise<MaterializationOutcome> {
    const groups = preloaded ?? (await this.loadGroups());

    const node = await this.prisma.managedNode.findUnique({ where: { certname } });

    // Facts come from the ManagedNode projection, never a live PuppetDB call —
    // otherwise a PuppetDB outage would block classification (ADR-0003/0004).
    const facts = (node?.facts ?? {}) as Record<string, unknown>;

    const matched = matchGroups({ certname, facts }, groups.evaluable);
    const mergeable = matched.map((g) => groups.mergeableById.get(g.id)).filter(isPresent);

    const merged = mergeGroups(mergeable);
    const rendered = renderEncDocument(merged.document);

    const changed = await this.writer.writeNode(certname, rendered.yaml, rendered.contentHash);

    const existing = await this.prisma.encMaterialization.findUnique({ where: { certname } });

    // Only bump the revision when the content actually changed. Incrementing on
    // every pass would make the revision meaningless as a change signal.
    const revision = existing === null ? 1 : changed ? existing.revision + 1 : existing.revision;

    // Requires a ManagedNode row (foreign key). A node pinned before it has
    // ever checked in has no projection yet; its file is written, but there is
    // nothing to record against until the projector sees it.
    if (node !== null) {
      await this.prisma.encMaterialization.upsert({
        where: { certname },
        create: {
          certname,
          contentHash: rendered.contentHash,
          revision,
          relativePath: `nodes/${certname}.yaml`,
          appliedGroupIds: merged.appliedGroupIds,
          conflicts: merged.conflicts as unknown as PuppetValue[],
        },
        update: {
          contentHash: rendered.contentHash,
          revision,
          appliedGroupIds: merged.appliedGroupIds,
          conflicts: merged.conflicts as unknown as PuppetValue[],
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

  /** Recompute every known node. Used by the full-reconcile job. */
  private async materializeAll(groups: LoadedGroups): Promise<MaterializationOutcome[]> {
    const nodes = await this.prisma.managedNode.findMany({ select: { certname: true } });

    const outcomes: MaterializationOutcome[] = [];
    for (const { certname } of nodes) {
      outcomes.push(await this.materializeNode(certname, groups));
    }
    return outcomes;
  }

  /**
   * Load the full classification set and shape it for the pure evaluator and
   * merger. One query set per tick.
   */
  async loadGroups(): Promise<LoadedGroups> {
    const rows = await this.prisma.nodeGroup.findMany({
      where: { isEnabled: true },
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
