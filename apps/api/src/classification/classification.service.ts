import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AUDIT_SINK } from '@nexuspuppet/contracts';
import type {
  AssignClass,
  AuthenticatedPrincipal,
  ClassificationWriteResult,
  CreateNodeGroup,
  NodeGroupDetail,
  ReplaceRules,
  SetParameter,
  UpdateNodeGroup,
  NodeClassificationExplanation,
  ClassificationConflict,
  GroupMatchExplanation,
  MergeAttribution,
  FactPathIndex,
  IAuditSink,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { strategyWarnings, type GroupShape } from './pure/strategy-warnings';
import {
  MaterializationService,
  type TransactionClient,
} from '../materialization/materialization.service';

/**
 * All classification writes (ADR-0003, ADR-0005, ADR-0009).
 *
 * THE ONE-TRANSACTION RULE
 * ------------------------
 * Every method here performs exactly one `$transaction` containing:
 *
 *   1. the domain change
 *   2. the AuditLog row
 *   3. the EncMaterializationJob outbox row
 *
 * Splitting them lets a committed change silently never reach disk: the
 * operator sees "saved", and a thousand machines keep running the old
 * configuration with nothing in the system to indicate a divergence.
 *
 * WHICH NODES NEED REMATERIALIZING
 * --------------------------------
 * This differs per operation and is the easiest thing here to get quietly
 * wrong. Getting it wrong strands nodes on stale configuration indefinitely,
 * because nothing else will touch them until the periodic reconcile.
 *
 *   Creating or editing RULES  -> full reconcile. A rule change can pull in
 *                                 nodes that have never matched this group,
 *                                 and current membership cannot tell us which.
 *
 *   Editing classes/params on  -> only the nodes matching NOW. Membership is
 *   an existing group             unchanged, so the affected set is knowable.
 *
 *   DELETING a group           -> only the nodes that matched BEFORE the
 *                                 delete. A deletion cannot cause a node to
 *                                 start matching, so a full reconcile is
 *                                 unnecessary — but the affected set must be
 *                                 captured BEFORE the rows are gone.
 *
 *   Pin changes                -> the pinned certnames, plus any that were
 *                                 pinned before the change.
 */
@Injectable()
export class ClassificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly materialization: MaterializationService,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    /**
     * The SAME list the projector uses, from validated config.
     *
     * Required rather than defaulted, so every construction site has to state
     * it. A default would silently restore the bug this replaced: the check
     * used to read process.env directly, which is empty whenever an operator
     * relies on the config default — so the safety net switched itself off in
     * precisely the default deployment.
     */
    private readonly projectedFacts: readonly string[],
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(): Promise<NodeGroupDetail[]> {
    const rows = await this.prisma.nodeGroup.findMany({
      include: { rules: true, classes: true, parameters: true, pins: true },
      orderBy: [{ rank: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDetail);
  }

  async get(id: string): Promise<NodeGroupDetail> {
    const row = await this.prisma.nodeGroup.findUnique({
      where: { id },
      include: { rules: true, classes: true, parameters: true, pins: true },
    });
    if (row === null) throw new NotFoundException(`No such node group: ${id}`);
    return toDetail(row);
  }

  /**
   * Why a node is classified the way it is.
   *
   * "Find why a node is getting this class, in one screen" is a primary product
   * requirement. Everything needed is already recorded at materialization time:
   * the applied groups in merge order, the conflicts, and when it was written.
   *
   * `pending` matters as much as the rest — a node with a queued job is showing
   * the PREVIOUS classification, and the UI must say so rather than present
   * stale data as current (ADR-0003).
   */
  async explain(certname: string): Promise<NodeClassificationExplanation> {
    const [materialization, node, queued] = await Promise.all([
      this.prisma.encMaterialization.findUnique({ where: { certname } }),
      this.prisma.managedNode.findUnique({ where: { certname } }),
      this.prisma.encMaterializationJob.count({
        where: { OR: [{ certname }, { certname: null }], status: 'PENDING' },
      }),
    ]);

    const appliedGroupIds = materialization?.appliedGroupIds ?? [];
    const groups =
      appliedGroupIds.length === 0
        ? []
        : await this.prisma.nodeGroup.findMany({
            where: { id: { in: appliedGroupIds } },
            select: { id: true, name: true, rank: true },
          });

    // Preserve MERGE order, not database order. The sequence is the explanation
    // — it is what tells an operator which group won.
    const byId = new Map(groups.map((g) => [g.id, g]));
    const applied = appliedGroupIds
      .map((id) => byId.get(id))
      .filter((g): g is { id: string; name: string; rank: number } => g !== undefined);

    return {
      certname,
      appliedGroups: applied,
      conflicts: (materialization?.conflicts ?? []) as unknown as ClassificationConflict[],
      /*
       * Omitted rather than defaulted when the node was materialized before
       * attribution existed. An empty object would read as "no group
       * contributed anything", which is a different and wrong statement — the
       * truth is that nobody recorded it.
       *
       * The next materialization fills it in.
       */
      ...(hasAttribution(materialization?.attribution)
        ? { attribution: materialization.attribution as unknown as MergeAttribution }
        : {}),
      // Same reasoning: an empty array means "not recorded", which is not the
      // same as "matched for no reason", so it is omitted rather than sent.
      ...(Array.isArray(materialization?.matchReasons) && materialization.matchReasons.length > 0
        ? { matchReasons: materialization.matchReasons as unknown as GroupMatchExplanation[] }
        : {}),
      materialization:
        materialization === null
          ? null
          : {
              contentHash: materialization.contentHash,
              revision: materialization.revision,
              relativePath: materialization.relativePath,
              writtenAt: materialization.writtenAt.toISOString(),
            },
      factsAsOf: node?.projectedAt.toISOString() ?? null,
      pending: queued > 0,
    };
  }

  /**
   * Fact paths a rule can match on, with coverage and low-cardinality values.
   *
   * Built from the ManagedNode PROJECTION rather than PuppetDB, because the
   * projection is the only thing rule evaluation reads. Suggesting a path that
   * is not projected would offer the author a rule guaranteed never to match
   * (ADR-0004).
   */
  async listFactPaths(): Promise<FactPathIndex> {
    // The projected subset is small by construction (an allow-list), so
    // scanning it is cheap. Bounded anyway so an unexpectedly large estate
    // cannot turn a type-ahead into a table scan.
    const nodes = await this.prisma.managedNode.findMany({
      select: { facts: true },
      take: MAX_NODES_FOR_FACT_INDEX,
    });

    const index = new Map<string, { count: number; values: Set<string>; sample: unknown }>();

    for (const node of nodes) {
      for (const [path, value] of flattenFacts(node.facts as Record<string, unknown>)) {
        const entry = index.get(path) ?? { count: 0, values: new Set<string>(), sample: value };
        entry.count += 1;

        // Value suggestions are for LEAVES only. A container's value is a whole
        // object, and RuleEvaluator's comparison never equates an object with a
        // scalar — offering `os` = {…} would suggest a rule that cannot match.
        //
        // Collection also stops once a path is clearly high-cardinality: an IP
        // or a hostname is not a useful picker, and the set would grow unbounded.
        const isContainer = value !== null && typeof value === 'object' && !Array.isArray(value);
        if (!isContainer && entry.values.size <= MAX_DISTINCT_VALUES) {
          entry.values.add(JSON.stringify(value));
        }
        index.set(path, entry);
      }
    }

    const paths = [...index.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, entry]) => ({
        path,
        nodeCount: entry.count,
        sampleValue: entry.sample,
        ...(entry.values.size > 0 && entry.values.size <= MAX_DISTINCT_VALUES
          ? {
              values: [...entry.values]
                .map((raw) => JSON.parse(raw) as unknown)
                .sort((a, b) => String(a).localeCompare(String(b))),
            }
          : {}),
      }));

    return { paths, nodesScanned: nodes.length };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(
    input: CreateNodeGroup,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameAvailable(tx, input.name, null);
      if (input.parentId !== null) await this.assertParentExists(tx, input.parentId);

      const created = await tx.nodeGroup.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          rank: input.rank,
          strategy: input.strategy,
          environment: input.environment,
          isEnabled: input.isEnabled,
          parentId: input.parentId,
        },
        include: { rules: true, classes: true, parameters: true, pins: true },
      });

      await this.recordAudit(tx, actor, context, 'node-group.create', created.id, null, created);

      // A new group has no rules yet, so it matches nothing and nothing needs
      // rewriting. The reconcile comes when rules or pins are added.
      return this.result(toDetail(created), { scope: 'nodes', certnames: [] }, []);
    });
  }

  async update(
    id: string,
    input: UpdateNodeGroup,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      if (input.name !== undefined) await this.assertNameAvailable(tx, input.name, id);
      if (input.parentId !== undefined && input.parentId !== null) {
        await this.assertParentExists(tx, input.parentId);
        await this.assertNoCycle(tx, id, input.parentId);
      }

      const updated = await tx.nodeGroup.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.rank === undefined ? {} : { rank: input.rank }),
          ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
          ...(input.environment === undefined ? {} : { environment: input.environment }),
          ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        },
        include: { rules: true, classes: true, parameters: true, pins: true },
      });

      await this.recordAudit(tx, actor, context, 'node-group.update', id, before, updated);

      // Rank, strategy, enablement, and hierarchy all change merge ORDER or
      // membership, so the safe answer is a full reconcile. Renaming or
      // re-describing changes neither.
      const affectsMatching =
        input.rank !== undefined ||
        input.strategy !== undefined ||
        input.isEnabled !== undefined ||
        input.parentId !== undefined ||
        input.environment !== undefined;

      // A strategy change is the sharpest form of this: flipping PINNED to
      // ALL_RULES orphans every pin at once, and nothing else in the product
      // would mention it.
      const warnings = input.strategy === undefined ? [] : strategyWarnings(shapeOf(updated));

      if (affectsMatching) {
        await this.materialization.enqueueFullReconcile(tx, `node-group.update:${id}`);
        return this.result(toDetail(updated), { scope: 'full-reconcile', certnames: [] }, warnings);
      }

      return this.result(toDetail(updated), { scope: 'nodes', certnames: [] }, warnings);
    });
  }

  async remove(
    id: string,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<{ materializationQueued: { scope: 'nodes'; certnames: string[] } }> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      const children = await tx.nodeGroup.count({ where: { parentId: id } });
      if (children > 0) {
        // Cascading would silently reclassify every descendant's nodes in one
        // unreviewable step. Make the operator remove them deliberately.
        throw new ConflictException(
          `Node group has ${children} child group(s). Remove or re-parent them first.`,
        );
      }

      // CAPTURE BEFORE DELETING. Once the rows are gone there is no way to
      // learn which nodes this group was classifying, and their files would
      // keep the old classification until the periodic reconcile noticed.
      const affected = await this.affectedCertnames(tx, id);

      await tx.nodeGroup.delete({ where: { id } });
      await this.recordAudit(tx, actor, context, 'node-group.delete', id, before, null);

      // A deletion cannot make a node START matching, so the previously
      // matching set is exactly the set to rewrite. No full reconcile needed.
      await this.materialization.enqueueNodes(tx, affected, `node-group.delete:${id}`);

      return { materializationQueued: { scope: 'nodes' as const, certnames: affected } };
    });
  }

  async replaceRules(
    id: string,
    input: ReplaceRules,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      await tx.nodeGroupRule.deleteMany({ where: { groupId: id } });
      for (const rule of input.rules) {
        await tx.nodeGroupRule.create({
          data: {
            groupId: id,
            factPath: rule.factPath,
            operator: rule.operator,
            ...(rule.value === undefined ? {} : { value: rule.value as object }),
          },
        });
      }

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.rules.replace', id, before, after);

      // A rule change can pull in nodes that have never matched this group.
      // Current membership cannot tell us which, so everything is recomputed.
      await this.materialization.enqueueFullReconcile(tx, `node-group.rules:${id}`);

      return this.result(toDetail(after), { scope: 'full-reconcile', certnames: [] }, [
        ...this.warnUnprojectedFacts(input),
        ...strategyWarnings(shapeOf(after)),
      ]);
    });
  }

  async assignClass(
    id: string,
    input: AssignClass,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      await tx.nodeGroupClass.upsert({
        where: { groupId_className: { groupId: id, className: input.className } },
        create: { groupId: id, className: input.className, params: input.params as object },
        update: { params: input.params as object },
      });

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.class.assign', id, before, after);

      // Membership is unchanged, so only the nodes matching now are affected.
      const affected = await this.affectedCertnames(tx, id);
      await this.materialization.enqueueNodes(tx, affected, `node-group.class:${id}`);

      return this.result(toDetail(after), { scope: 'nodes', certnames: affected }, []);
    });
  }

  async removeClass(
    id: string,
    className: string,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      const { count } = await tx.nodeGroupClass.deleteMany({ where: { groupId: id, className } });
      if (count === 0) throw new NotFoundException(`Group does not assign class ${className}.`);

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.class.remove', id, before, after);

      const affected = await this.affectedCertnames(tx, id);
      await this.materialization.enqueueNodes(tx, affected, `node-group.class.remove:${id}`);

      return this.result(toDetail(after), { scope: 'nodes', certnames: affected }, []);
    });
  }

  async setParameter(
    id: string,
    input: SetParameter,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      await tx.nodeGroupParameter.upsert({
        where: { groupId_key: { groupId: id, key: input.key } },
        create: { groupId: id, key: input.key, value: input.value as object },
        update: { value: input.value as object },
      });

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.parameter.set', id, before, after);

      const affected = await this.affectedCertnames(tx, id);
      await this.materialization.enqueueNodes(tx, affected, `node-group.parameter:${id}`);

      return this.result(toDetail(after), { scope: 'nodes', certnames: affected }, []);
    });
  }

  async removeParameter(
    id: string,
    key: string,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      const { count } = await tx.nodeGroupParameter.deleteMany({ where: { groupId: id, key } });
      if (count === 0) throw new NotFoundException(`Group does not set parameter ${key}.`);

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.parameter.remove', id, before, after);

      const affected = await this.affectedCertnames(tx, id);
      await this.materialization.enqueueNodes(tx, affected, `node-group.parameter.remove:${id}`);

      return this.result(toDetail(after), { scope: 'nodes', certnames: affected }, []);
    });
  }

  async addPins(
    id: string,
    certnames: readonly string[],
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      for (const certname of certnames) {
        await tx.nodeGroupPin.upsert({
          where: { groupId_certname: { groupId: id, certname } },
          create: { groupId: id, certname },
          update: {},
        });
      }

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.pin.add', id, before, after);

      const affected = unique([...certnames, ...(await this.affectedCertnames(tx, id))]);
      await this.materialization.enqueueNodes(tx, affected, `node-group.pin:${id}`);

      // Pinning a node that has never checked in is legitimate — it may be
      // provisioned tomorrow — but it will not materialize until it appears.
      const warnings = await this.warnUnknownNodes(tx, certnames);

      return this.result(toDetail(after), { scope: 'nodes', certnames: affected }, [
        ...warnings,
        ...strategyWarnings(shapeOf(after)),
      ]);
    });
  }

  async removePin(
    id: string,
    certname: string,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
  ): Promise<ClassificationWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadOrThrow(tx, id);

      const { count } = await tx.nodeGroupPin.deleteMany({ where: { groupId: id, certname } });
      if (count === 0) throw new NotFoundException(`${certname} is not pinned to this group.`);

      const after = await this.loadOrThrow(tx, id);
      await this.recordAudit(tx, actor, context, 'node-group.pin.remove', id, before, after);

      // The unpinned node must be rewritten too — it is no longer a member.
      const affected = unique([certname, ...(await this.affectedCertnames(tx, id))]);
      await this.materialization.enqueueNodes(tx, affected, `node-group.pin.remove:${id}`);

      return this.result(toDetail(after), { scope: 'nodes', certnames: affected }, []);
    });
  }

  /** Operator-triggered full recompute. */
  async forceReconcile(actor: AuthenticatedPrincipal, context: AuditContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.recordAudit(tx, actor, context, 'materialization.reconcile', null, null, null);
      await this.materialization.enqueueFullReconcile(tx, `manual:${actor.email}`);
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Nodes this group is currently classifying: everything materialized with it
   * applied, plus its pins (which may not have materialized yet).
   */
  private async affectedCertnames(tx: TransactionClient, groupId: string): Promise<string[]> {
    const [materialized, pins] = await Promise.all([
      tx.encMaterialization.findMany({
        where: { appliedGroupIds: { has: groupId } },
        select: { certname: true },
      }),
      tx.nodeGroupPin.findMany({ where: { groupId }, select: { certname: true } }),
    ]);

    return unique([...materialized.map((m) => m.certname), ...pins.map((p) => p.certname)]);
  }

  private async loadOrThrow(tx: TransactionClient, id: string): Promise<GroupWithRelations> {
    const row = await tx.nodeGroup.findUnique({
      where: { id },
      include: { rules: true, classes: true, parameters: true, pins: true },
    });
    if (row === null) throw new NotFoundException(`No such node group: ${id}`);
    return row as GroupWithRelations;
  }

  private async assertNameAvailable(
    tx: TransactionClient,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const existing = await tx.nodeGroup.findUnique({ where: { name }, select: { id: true } });
    if (existing !== null && existing.id !== exceptId) {
      throw new ConflictException(`A node group named "${name}" already exists.`);
    }
  }

  private async assertParentExists(tx: TransactionClient, parentId: string): Promise<void> {
    const parent = await tx.nodeGroup.findUnique({ where: { id: parentId }, select: { id: true } });
    if (parent === null) throw new BadRequestException(`Parent group ${parentId} does not exist.`);
  }

  /**
   * Reject a hierarchy cycle.
   *
   * A cycle would make the evaluation order undefined and hang any traversal
   * of the tree. The database cannot express this constraint, so it is checked
   * here — inside the transaction, so a concurrent re-parent cannot slip a
   * cycle past the check.
   */
  private async assertNoCycle(
    tx: TransactionClient,
    groupId: string,
    proposedParentId: string,
  ): Promise<void> {
    if (groupId === proposedParentId) {
      throw new BadRequestException('A node group cannot be its own parent.');
    }

    const seen = new Set<string>([groupId]);
    let cursor: string | null = proposedParentId;

    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new BadRequestException(
          'That parent would create a cycle in the node group hierarchy.',
        );
      }
      seen.add(cursor);

      const parent: { parentId: string | null } | null = await tx.nodeGroup.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }

  /**
   * A rule referencing a fact outside the projected allow-list can NEVER match
   * (ADR-0004). Silently never matching is the worst outcome, so it is surfaced
   * as a warning rather than left to be discovered.
   */
  private warnUnprojectedFacts(input: ReplaceRules): string[] {
    // An empty list now means what it says — projection is disabled — rather
    // than "the environment variable was not set explicitly".
    const projected = this.projectedFacts;
    if (projected.length === 0) return [];

    const warnings: string[] = [];
    for (const rule of input.rules) {
      const root = rule.factPath.split('.')[0] ?? '';
      if (root !== '' && !projected.includes(root)) {
        warnings.push(
          `Fact "${rule.factPath}" is not in PUPPETDB_PROJECTED_FACTS, so this rule can never match. ` +
            `Add "${root}" to the projected facts and re-run the projection.`,
        );
      }
    }
    return warnings;
  }

  private async warnUnknownNodes(
    tx: TransactionClient,
    certnames: readonly string[],
  ): Promise<string[]> {
    const known = await tx.managedNode.findMany({
      where: { certname: { in: [...certnames] } },
      select: { certname: true },
    });
    const knownSet = new Set(known.map((n) => n.certname));

    const unknown = certnames.filter((c) => !knownSet.has(c));
    return unknown.length === 0
      ? []
      : [
          `${unknown.length} pinned node(s) have not reported to PuppetDB yet and will not be ` +
            `materialized until they do: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`,
        ];
  }

  private async recordAudit(
    tx: TransactionClient,
    actor: AuthenticatedPrincipal,
    context: AuditContext,
    action: string,
    entityId: string | null,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.audit.record(
      {
        actorUserId: actor.userId,
        actorEmail: actor.email,
        action,
        entityType: 'NodeGroup',
        entityId,
        before,
        after,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );
  }

  private result(
    group: NodeGroupDetail,
    queued: { scope: 'nodes' | 'full-reconcile'; certnames: string[] },
    warnings: string[],
  ): ClassificationWriteResult {
    return { group, materializationQueued: queued, warnings };
  }
}

const MAX_NODES_FOR_FACT_INDEX = 2000;

/**
 * Above this, a path is treated as high-cardinality and no value list is
 * offered — a dropdown of 1,000 IP addresses is noise, not help.
 */
const MAX_DISTINCT_VALUES = 25;

/**
 * Flatten facts to dotted paths, matching how RuleEvaluator resolves them.
 *
 * Arrays are leaves, exactly as in the evaluator: `processors.models` is
 * matched as a whole value, never by index.
 */
function flattenFacts(
  value: unknown,
  prefix = '',
  out: Array<[string, unknown]> = [],
): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') out.push([prefix, value]);
    return out;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const isContainer = nested !== null && typeof nested === 'object' && !Array.isArray(nested);

    flattenFacts(nested, path, out);

    // A container is matchable in its own right — EXISTS on `os` is a valid
    // rule. Only containers are pushed here: the recursive call has already
    // emitted leaves, and pushing them again would double their node count.
    if (isContainer) out.push([path, nested]);
  }
  return out;
}

export interface AuditContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface GroupWithRelations {
  id: string;
  name: string;
  description: string | null;
  rank: number;
  strategy: 'ALL_RULES' | 'ANY_RULE' | 'PINNED';
  environment: string | null;
  isEnabled: boolean;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  rules: Array<{ factPath: string; operator: string; value: unknown }>;
  classes: Array<{ className: string; params: unknown }>;
  parameters: Array<{ key: string; value: unknown }>;
  pins: Array<{ certname: string }>;
}

function toDetail(row: GroupWithRelations): NodeGroupDetail {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rank: row.rank,
    strategy: row.strategy,
    environment: row.environment,
    isEnabled: row.isEnabled,
    parentId: row.parentId,
    ruleCount: row.rules.length,
    classCount: row.classes.length,
    pinCount: row.pins.length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rules: row.rules.map((r) => ({
      factPath: r.factPath,
      operator: r.operator as NodeGroupDetail['rules'][number]['operator'],
      ...(r.value === null || r.value === undefined ? {} : { value: r.value }),
    })),
    classes: row.classes.map((c) => ({
      className: c.className,
      params: (c.params ?? {}) as Record<string, unknown>,
    })),
    parameters: row.parameters.map((p) => ({ key: p.key, value: p.value })),
    pinnedCertnames: row.pins.map((p) => p.certname).sort(),
  };
}

/**
 * The three fields strategyWarnings needs, taken from a loaded row.
 *
 * Read from the group AFTER the write, not from the request: the warning is
 * about the state the operator has just created, and a pin added to a group
 * whose strategy someone else changed a minute ago is just as inert.
 */
function shapeOf(group: GroupWithRelations): GroupShape {
  return {
    strategy: group.strategy,
    ruleCount: group.rules.length,
    pinCount: group.pins.length,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * True when a materialization actually carries attribution.
 *
 * Prisma defaults the column to `{}`, so "materialized before #141" and
 * "matched no groups" both arrive as an empty object. Only the presence of a
 * key distinguishes them, and the console has to be able to tell — one is
 * missing information, the other is information.
 */
function hasAttribution(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}
