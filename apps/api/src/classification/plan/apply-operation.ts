import type { PlanRequest } from '@nexuspuppet/contracts';
import type { EvaluableGroup } from '../../materialization/pure/rule-evaluator';
import type { MergeableGroup } from '../../materialization/pure/class-merger';
import type { PuppetValue } from '@nexuspuppet/contracts';

/**
 * Apply a proposed change to an in-memory copy of the classification set.
 *
 * THE WHOLE PLANNER RESTS ON THIS. Every write this product supports — rules,
 * classes, parameters, pins, rank, environment, enablement, deletion — is a
 * transformation of the same two structures the materializer already evaluates
 * against. Expressing each as such means the plan and the real write cannot
 * diverge in how they interpret an operation, because the plan reuses the
 * evaluator and merger unchanged.
 *
 * PURE. Nothing here touches the database or mutates its input; a plan must be
 * incapable of changing anything, and the cheapest way to guarantee that is for
 * the function that models the change to have no way to.
 */

export interface GroupSet {
  evaluable: EvaluableGroup[];
  mergeableById: Map<string, MergeableGroup>;
}

/** Deep-enough copy: every field the operations below can touch. */
function copy(groups: GroupSet): GroupSet {
  return {
    evaluable: groups.evaluable.map((g) => ({
      ...g,
      rules: [...g.rules],
      pinnedCertnames: [...g.pinnedCertnames],
    })),
    mergeableById: new Map(
      [...groups.mergeableById].map(([id, g]) => [
        id,
        {
          ...g,
          classes: Object.fromEntries(
            Object.entries(g.classes).map(([name, params]) => [name, { ...params }]),
          ),
          parameters: { ...g.parameters },
        },
      ]),
    ),
  };
}

export class UnknownGroupError extends Error {}

export function applyOperation(groups: GroupSet, request: PlanRequest): GroupSet {
  const next = copy(groups);
  const evaluable = next.evaluable.find((g) => g.id === request.groupId);
  const mergeable = next.mergeableById.get(request.groupId);

  // Every operation names an existing group. A plan for one that vanished is a
  // stale browser tab, and answering with an empty diff would read as "this
  // change does nothing" rather than "this group is gone".
  if (evaluable === undefined || mergeable === undefined) {
    throw new UnknownGroupError(`No node group ${request.groupId}`);
  }

  switch (request.operation) {
    case 'replace-rules':
      evaluable.rules = request.rules.map((rule) => ({
        factPath: rule.factPath,
        operator: rule.operator as EvaluableGroup['rules'][number]['operator'],
        ...(rule.value === undefined ? {} : { value: rule.value }),
      }));
      return next;

    case 'assign-class':
      mergeable.classes[request.className] = request.params as Record<string, PuppetValue>;
      return next;

    case 'remove-class':
      delete mergeable.classes[request.className];
      return next;

    case 'set-parameter':
      mergeable.parameters[request.key] = request.value as PuppetValue;
      return next;

    case 'remove-parameter':
      delete mergeable.parameters[request.key];
      return next;

    case 'update-group':
      if (request.rank !== undefined) evaluable.rank = request.rank;
      if (request.isEnabled !== undefined) evaluable.isEnabled = request.isEnabled;
      if (request.environment !== undefined) mergeable.environment = request.environment;
      return next;

    case 'delete-group':
      next.evaluable = next.evaluable.filter((g) => g.id !== request.groupId);
      next.mergeableById.delete(request.groupId);
      return next;

    case 'pin': {
      // A set, because pinning a certname twice is not two pins and the diff
      // would otherwise depend on how many times someone clicked.
      const pinned = new Set([...evaluable.pinnedCertnames, ...request.certnames]);
      evaluable.pinnedCertnames = [...pinned];
      return next;
    }

    case 'unpin': {
      const removing = new Set(request.certnames);
      evaluable.pinnedCertnames = evaluable.pinnedCertnames.filter((c) => !removing.has(c));
      return next;
    }

    default: {
      // Exhaustive: a new operation added to the contract fails to compile here
      // rather than silently planning as a no-op, which would show an operator
      // "no changes" for a change that does something.
      const never: never = request;
      return never;
    }
  }
}

/**
 * Whether an operation can change WHICH nodes match.
 *
 * A class or parameter edit changes what a group gives its members, never who
 * they are — so only nodes already matching that group can be affected, and the
 * plan can skip the rest of the estate. Rules, pins, enablement and deletion all
 * move the membership boundary and need the whole estate considered.
 *
 * Getting this wrong in the permissive direction is slow; getting it wrong in
 * the restrictive direction silently omits affected nodes from a preview whose
 * entire purpose is to show them. When unsure, scan.
 */
export function changesMembership(request: PlanRequest): boolean {
  switch (request.operation) {
    case 'assign-class':
    case 'remove-class':
    case 'set-parameter':
    case 'remove-parameter':
      return false;
    case 'update-group':
      // Rank changes merge ORDER, which changes documents for existing members
      // only — but enablement changes membership outright.
      return request.isEnabled !== undefined;
    default:
      return true;
  }
}
