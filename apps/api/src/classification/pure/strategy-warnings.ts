import type { MatchStrategy } from '@nexuspuppet/contracts';

/**
 * Which parts of a group its match strategy ignores.
 *
 * `groupMatches` reads pins for a `PINNED` group and rules for a rule-based one,
 * and never the other way round. So a group can hold a rule or a pin that has no
 * effect on anything, with nothing in the product saying so — the change saves,
 * the audit row records it, and the node set does not move.
 *
 * That is the same failure as a rule on an unprojected fact: not an error, not a
 * refusal, just a configuration that quietly means nothing. It is worth a
 * sentence at the moment it is created rather than an afternoon later.
 *
 * PURE, and shared between the write path and the planner deliberately. A plan
 * that failed to predict a warning the subsequent write emits would undermine
 * the point of previewing at all.
 */

export interface GroupShape {
  strategy: MatchStrategy;
  ruleCount: number;
  pinCount: number;
}

export function strategyWarnings(group: GroupShape): string[] {
  const warnings: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (group.strategy === 'PINNED') {
    if (group.ruleCount > 0) {
      warnings.push(
        `This group matches by pinned node, so its ${plural(group.ruleCount, 'rule')} ` +
          'currently decide nothing. Switch the strategy to ALL_RULES or ANY_RULE to use them.',
      );
    }
    return warnings;
  }

  // Rule-based from here: ALL_RULES or ANY_RULE.
  if (group.pinCount > 0) {
    warnings.push(
      `This group matches by rule, so its ${plural(group.pinCount, 'pinned node')} ` +
        'currently decide nothing. Switch the strategy to PINNED to use them.',
    );
  }

  if (group.ruleCount === 0) {
    // Matching nothing is the safe reading — the alternative, an empty draft
    // group classifying the whole estate, is a catastrophe — but it is not the
    // obvious one, and someone who has just saved an empty group is entitled to
    // know why no nodes appeared.
    warnings.push('A rule-based group with no rules matches no nodes.');
  }

  return warnings;
}
