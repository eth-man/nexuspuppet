import { Injectable } from '@nestjs/common';
import type {
  ClassificationConflict,
  PlanDiff,
  PlanFieldChange,
  PlanRequest,
  PlanResponse,
  PlanShape,
  PuppetValue,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterializerService, type LoadedGroups } from '../../materialization/materializer.service';
import { matchGroups } from '../../materialization/pure/rule-evaluator';
import { mergeGroups, type MergeableGroup } from '../../materialization/pure/class-merger';
import { renderEncDocument } from '../../materialization/pure/enc-yaml-renderer';
import { applyOperation, changesMembership, type GroupSet } from './apply-operation';

/**
 * What a classification change would do, computed without doing it.
 *
 * Runs the SAME pipeline the materializer runs — matchGroups, mergeGroups,
 * renderEncDocument — twice: once against the classification set as it is, once
 * against a copy with the proposed change applied. The difference is the plan.
 *
 * Reusing that pipeline rather than reimplementing a preview is the entire
 * design. Those three functions are pure and deterministic (ADR-0009), so a
 * plan is not an approximation of what would happen: for the estate as it
 * stands, it is exactly what would happen.
 *
 * A FORECAST, NOT A CONTRACT. The estate moves. A node checking in between plan
 * and apply changes the outcome, and nothing here pretends otherwise — making
 * it a contract needs optimistic locking on the projection, a far larger
 * feature than a preview.
 */

export interface PlannerPacing {
  /**
   * How many nodes a single plan will evaluate.
   *
   * Facts are the projected subset rather than full factsets, so this is
   * kilobytes per node rather than megabytes. The bound exists because a plan
   * that times out is worse than no plan — and because an interactive request
   * should not be able to read the whole of a very large estate. When it bites,
   * the response says so rather than quietly sampling.
   */
  maxNodes: number;
  /** Certnames listed per shape, so a response cannot become a node dump. */
  maxCertnamesPerShape: number;
}

export const DEFAULT_PLANNER_PACING: PlannerPacing = {
  maxNodes: 2_000,
  maxCertnamesPerShape: 50,
};

interface NodeOutcome {
  certname: string;
  beforeHash: string;
  afterHash: string;
  beforeDoc: MergedDocument;
  afterDoc: MergedDocument;
}

interface MergedDocument {
  classes: Record<string, Record<string, PuppetValue>>;
  parameters: Record<string, PuppetValue>;
  environment: string | null;
  conflicts: ClassificationConflict[];
}

@Injectable()
export class ClassificationPlanner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly materializer: MaterializerService,
    private readonly pacing: PlannerPacing = DEFAULT_PLANNER_PACING,
  ) {}

  async plan(request: PlanRequest): Promise<PlanResponse> {
    // ALL groups, including disabled ones. loadGroups filters them out at the
    // query level, which would make "enable this group" unplannable — the very
    // change whose blast radius an operator most wants to see first.
    const current = await this.loadAllGroups();
    const proposed = applyOperation(current, request);

    const estateSize = await this.prisma.managedNode.count();
    const nodes = await this.candidateNodes(request, current);

    const outcomes: NodeOutcome[] = [];
    for (const node of nodes) {
      const facts = (node.facts ?? {}) as Record<string, unknown>;
      const before = this.documentFor(node.certname, facts, current);
      const after = this.documentFor(node.certname, facts, proposed);
      outcomes.push({
        certname: node.certname,
        beforeHash: before.hash,
        afterHash: after.hash,
        beforeDoc: before.document,
        afterDoc: after.document,
      });
    }

    const changed = outcomes.filter((o) => o.beforeHash !== o.afterHash);

    return {
      counts: this.countsFor(outcomes, changed),
      shapes: this.shapesFor(changed),
      conflictsIntroduced: this.newConflicts(changed),
      warnings: this.warningsFor(request, nodes.length, estateSize),
      truncated: nodes.length < estateSize,
      evaluated: nodes.length,
      estateSize,
    };
  }

  /**
   * The nodes worth evaluating.
   *
   * A change that cannot move the membership boundary can only affect nodes
   * already in the group, so the plan asks the materialization records which
   * those are rather than reading the estate. When membership CAN move, there
   * is no shortcut: a rule change exists precisely to bring in nodes that do
   * not match yet.
   */
  private async candidateNodes(
    request: PlanRequest,
    current: GroupSet,
  ): Promise<Array<{ certname: string; facts: unknown }>> {
    if (!changesMembership(request)) {
      const members = await this.prisma.encMaterialization.findMany({
        where: { appliedGroupIds: { has: request.groupId } },
        select: { certname: true },
        take: this.pacing.maxNodes,
      });
      if (members.length > 0) {
        return this.prisma.managedNode.findMany({
          where: { certname: { in: members.map((m) => m.certname) } },
          select: { certname: true, facts: true },
        });
      }
      // No materialization records yet — a fresh deployment, or a group whose
      // members have never been written. Fall through and scan rather than
      // report "affects nothing", which would be a confident lie.
      void current;
    }

    return this.prisma.managedNode.findMany({
      select: { certname: true, facts: true },
      orderBy: { certname: 'asc' },
      take: this.pacing.maxNodes,
    });
  }

  /** One node's document, through the materializer's own pipeline. */
  private documentFor(
    certname: string,
    facts: Record<string, unknown>,
    groups: GroupSet,
  ): { hash: string; document: MergedDocument } {
    const matched = matchGroups({ certname, facts }, groups.evaluable);
    const mergeable = matched
      .map((g) => groups.mergeableById.get(g.id))
      .filter((g): g is MergeableGroup => g !== undefined);

    const merged = mergeGroups(mergeable);
    const rendered = renderEncDocument(merged.document);

    return {
      // The materializer's own content hash, so "changed" here means exactly
      // what "changed" means when a file is written.
      hash: rendered.contentHash,
      document: {
        classes: merged.document.classes,
        parameters: merged.document.parameters,
        environment: merged.document.environment ?? null,
        conflicts: merged.conflicts,
      },
    };
  }

  private countsFor(all: NodeOutcome[], changed: NodeOutcome[]): PlanResponse['counts'] {
    let added = 0;
    let removed = 0;
    let modified = 0;

    for (const outcome of changed) {
      const hadClasses = Object.keys(outcome.beforeDoc.classes).length > 0;
      const hasClasses = Object.keys(outcome.afterDoc.classes).length > 0;
      // "Added" and "removed" mean gaining or losing classification entirely.
      // They are separated from "changed" because they are the outcomes that
      // surprise people — a node silently inheriting a class, or losing one.
      if (!hadClasses && hasClasses) added += 1;
      else if (hadClasses && !hasClasses) removed += 1;
      else modified += 1;
    }

    return {
      total: changed.length,
      added,
      removed,
      changed: modified,
      unchanged: all.length - changed.length,
    };
  }

  /**
   * Group changed nodes by their resulting document.
   *
   * Four hundred changed nodes usually produce three or four distinct outcomes.
   * Listing four hundred diffs is a wall nobody reads; naming the shapes and
   * how many nodes take each is the difference between a preview that is used
   * and one that is scrolled past.
   */
  private shapesFor(changed: NodeOutcome[]): PlanShape[] {
    const byOutcome = new Map<string, NodeOutcome[]>();
    for (const outcome of changed) {
      // Keyed on BOTH hashes: two nodes ending identically from different
      // starting points did not undergo the same change, and showing them as
      // one shape would misdescribe at least one of them.
      const key = `${outcome.beforeHash}->${outcome.afterHash}`;
      const bucket = byOutcome.get(key);
      if (bucket === undefined) byOutcome.set(key, [outcome]);
      else bucket.push(outcome);
    }

    return [...byOutcome.values()]
      .sort((a, b) => b.length - a.length)
      .map((bucket) => {
        const first = bucket[0] as NodeOutcome;
        const hadClasses = Object.keys(first.beforeDoc.classes).length > 0;
        const hasClasses = Object.keys(first.afterDoc.classes).length > 0;

        return {
          count: bucket.length,
          exemplar: first.certname,
          certnames: bucket.slice(0, this.pacing.maxCertnamesPerShape).map((o) => o.certname),
          kind:
            !hadClasses && hasClasses ? 'added' : hadClasses && !hasClasses ? 'removed' : 'changed',
          diff: diffDocuments(first.beforeDoc, first.afterDoc),
        } satisfies PlanShape;
      });
  }

  /**
   * Conflicts this change introduces, and only those.
   *
   * An estate accumulates conflicts — overriding a base group is a legitimate
   * pattern (ADR-0009). Reporting all of them on every plan would train an
   * operator to scroll past the section that exists to stop them.
   */
  private newConflicts(changed: NodeOutcome[]): ClassificationConflict[] {
    const introduced = new Map<string, ClassificationConflict>();

    for (const outcome of changed) {
      const before = new Set(outcome.beforeDoc.conflicts.map(conflictKey));
      for (const conflict of outcome.afterDoc.conflicts) {
        const key = conflictKey(conflict);
        if (!before.has(key) && !introduced.has(key)) introduced.set(key, conflict);
      }
    }

    return [...introduced.values()];
  }

  private warningsFor(request: PlanRequest, evaluated: number, estateSize: number): string[] {
    const warnings: string[] = [];

    if (evaluated < estateSize) {
      warnings.push(
        `This estate has ${estateSize} nodes and this plan evaluated ${evaluated}. ` +
          'The real change may affect nodes not shown here.',
      );
    }

    if (request.operation === 'replace-rules' && request.rules.length === 0) {
      // groupMatches treats a rule-based group with no rules as matching
      // nothing, which is the safe reading but not the obvious one.
      warnings.push('A rule-based group with no rules matches no nodes.');
    }

    return warnings;
  }

  /** All groups, enabled or not — enablement is itself a plannable change. */
  private async loadAllGroups(): Promise<LoadedGroups> {
    return this.materializer.loadGroups(this.prisma, { includeDisabled: true });
  }
}

const conflictKey = (conflict: ClassificationConflict): string =>
  `${conflict.kind}:${conflict.key}:${conflict.winningGroupId}:${conflict.losingGroupId}`;

/**
 * A SEMANTIC diff, not a text diff of the rendered YAML.
 *
 * The renderer sorts keys and emits deterministically, so a text diff would be
 * accurate and unreadable — an operator wants "this class was added" and "this
 * parameter changed", not a hunk. It also means the diff survives a change to
 * the renderer's formatting.
 */
export function diffDocuments(before: MergedDocument, after: MergedDocument): PlanDiff {
  const beforeClasses = new Set(Object.keys(before.classes));
  const afterClasses = new Set(Object.keys(after.classes));

  const classParameters: PlanFieldChange[] = [];
  for (const className of afterClasses) {
    if (!beforeClasses.has(className)) continue;
    const b = before.classes[className] ?? {};
    const a = after.classes[className] ?? {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!same(b[key], a[key])) {
        classParameters.push({ className, key, before: b[key] ?? null, after: a[key] ?? null });
      }
    }
  }

  const parameters: PlanFieldChange[] = [];
  for (const key of new Set([
    ...Object.keys(before.parameters),
    ...Object.keys(after.parameters),
  ])) {
    if (!same(before.parameters[key], after.parameters[key])) {
      parameters.push({
        key,
        before: before.parameters[key] ?? null,
        after: after.parameters[key] ?? null,
      });
    }
  }

  return {
    classesAdded: [...afterClasses].filter((c) => !beforeClasses.has(c)).sort(),
    classesRemoved: [...beforeClasses].filter((c) => !afterClasses.has(c)).sort(),
    classParameters,
    parameters,
    environmentBefore: before.environment,
    environmentAfter: after.environment,
  };
}

/**
 * Structural equality, order-insensitive for object keys.
 *
 * JSON.stringify would report a difference for two identical maps whose keys
 * were inserted in a different order, and a plan that reports phantom changes
 * is worse than none.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    return [...keys].every((k) => same(ao[k], bo[k]));
  }
  return false;
}
