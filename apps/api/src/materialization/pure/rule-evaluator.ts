import type {
  GroupMatchExplanation,
  MatchStrategy,
  NodeRule,
  RuleOperator,
} from '@nexuspuppet/contracts';

/**
 * Pure rule evaluation: (facts, groups) -> matched groups, in merge order.
 *
 * No I/O, no clock, no randomness (enforced by ESLint). Facts come from the
 * ManagedNode projection in Postgres, never from a live PuppetDB call — see
 * ADR-0003 and ADR-0004.
 *
 * This file and class-merger.ts decide what a thousand machines are configured
 * to run. Bugs here are silent and expensive, which is why the logic is pure
 * and exhaustively table-tested.
 */

export interface EvaluableGroup {
  id: string;
  name: string;
  /** Higher rank is applied later and therefore wins (ADR-0009). */
  rank: number;
  strategy: MatchStrategy;
  isEnabled: boolean;
  rules: NodeRule[];
  pinnedCertnames: string[];
}

export interface EvaluableNode {
  certname: string;
  /** The PROJECTED fact subset, not the full fact blob (ADR-0004). */
  facts: Record<string, unknown>;
}

/**
 * Resolve a dotted fact path such as `os.family` or `networking.interfaces.eth0.ip`.
 *
 * Returns `undefined` for a missing path. Note that a fact outside the projected
 * allow-list is indistinguishable here from a genuinely absent fact — the UI is
 * responsible for warning when a rule references an unprojected path, otherwise
 * the rule would silently never match.
 */
export function resolveFactPath(facts: Record<string, unknown>, path: string): unknown {
  if (path.length === 0) return undefined;

  let current: unknown = facts;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

/** Total, non-throwing comparison. An operator can never crash materialization. */
export function evaluateRule(facts: Record<string, unknown>, rule: NodeRule): boolean {
  const actual = resolveFactPath(facts, rule.factPath);
  return applyOperator(rule.operator, actual, rule.value);
}

function applyOperator(operator: RuleOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'EXISTS':
      return actual !== undefined;
    case 'NOT_EXISTS':
      return actual === undefined;

    case 'EQUALS':
      return looseScalarEquals(actual, expected);
    case 'NOT_EQUALS':
      return actual !== undefined && !looseScalarEquals(actual, expected);

    case 'MATCHES_REGEX':
      return matchesRegex(actual, expected);
    case 'NOT_MATCHES_REGEX':
      return actual !== undefined && !matchesRegex(actual, expected);

    case 'IN':
      return Array.isArray(expected) && expected.some((e) => looseScalarEquals(actual, e));
    case 'NOT_IN':
      return (
        actual !== undefined &&
        Array.isArray(expected) &&
        !expected.some((e) => looseScalarEquals(actual, e))
      );

    case 'GREATER_THAN':
      return compareNumeric(actual, expected, (a, b) => a > b);
    case 'LESS_THAN':
      return compareNumeric(actual, expected, (a, b) => a < b);

    default: {
      // Exhaustiveness: adding an operator to the contract without handling it
      // here is a compile error rather than a silent non-match.
      const _never: never = operator;
      return _never;
    }
  }
}

/**
 * Facts arrive as JSON, so a fact may be the string "8" where the rule holds the
 * number 8. Scalars are compared by string form to avoid that class of
 * false negative. Objects and arrays are never equal to a scalar.
 */
function looseScalarEquals(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || expected === undefined) return false;
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual === 'object' || typeof expected === 'object') return false;
  return String(actual) === String(expected);
}

function matchesRegex(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  if (typeof expected !== 'string') return false;
  if (typeof actual === 'object') return false;
  try {
    return new RegExp(expected).test(String(actual));
  } catch {
    // An invalid regex must not abort materialization for the whole estate.
    // The rule simply does not match; validation happens at the API boundary.
    return false;
  }
}

function compareNumeric(
  actual: unknown,
  expected: unknown,
  compare: (a: number, b: number) => boolean,
): boolean {
  const a = toNumber(actual);
  const b = toNumber(expected);
  if (a === null || b === null) return false;
  return compare(a, b);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Does this single group match this node? */
export function groupMatches(node: EvaluableNode, group: EvaluableGroup): boolean {
  if (!group.isEnabled) return false;

  switch (group.strategy) {
    case 'PINNED':
      return group.pinnedCertnames.includes(node.certname);

    case 'ALL_RULES':
      // A rule-based group with no rules matches nothing. Matching everything
      // would let an empty draft group silently classify the entire estate.
      return group.rules.length > 0 && group.rules.every((r) => evaluateRule(node.facts, r));

    case 'ANY_RULE':
      return group.rules.length > 0 && group.rules.some((r) => evaluateRule(node.facts, r));

    default: {
      const _never: never = group.strategy;
      return _never;
    }
  }
}

/**
 * All groups matching a node, sorted into merge order: rank ascending, then id
 * ascending. Later entries override earlier ones.
 *
 * Ties are broken by id so the result never depends on database row order —
 * determinism here is what makes content-hash change detection correct.
 */
export function matchGroups(
  node: EvaluableNode,
  groups: readonly EvaluableGroup[],
): EvaluableGroup[] {
  return groups
    .filter((group) => groupMatches(node, group))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id.localeCompare(b.id)));
}

/**
 * WHY a group applied, rather than whether (#142).
 *
 * A companion to `groupMatches` that reports the reasoning instead of the
 * verdict. Deliberately does NOT re-decide the match: it re-evaluates each
 * rule to describe it, and the caller only asks about groups that already
 * matched. Two functions computing "did this match" would be two answers
 * waiting to disagree, and the one on disk would win silently.
 *
 * Reports EVERY rule, not only the satisfied ones. Under ANY_RULE a group
 * applies on one rule out of five, and knowing which four did not is most of
 * the explanation — it is the difference between "this is why" and "one of
 * these is why".
 */
export function explainMatch(node: EvaluableNode, group: EvaluableGroup): GroupMatchExplanation {
  if (group.strategy === 'PINNED') {
    // Pinned is the whole answer. There is no rule to inspect, and saying so
    // plainly beats an empty rule list the reader has to interpret.
    return { groupId: group.id, strategy: group.strategy, rules: [] };
  }

  return {
    groupId: group.id,
    strategy: group.strategy,
    rules: group.rules.map((rule) => {
      const actual = resolveFactPath(node.facts, rule.factPath);

      return {
        factPath: rule.factPath,
        operator: rule.operator,
        ...(rule.value === undefined ? {} : { expected: rule.value }),
        ...(actual === undefined ? {} : { actual }),
        factMissing: actual === undefined,
        matched: evaluateRule(node.facts, rule),
      };
    }),
  };
}
