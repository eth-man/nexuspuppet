import { strategyWarnings } from './strategy-warnings';

/**
 * Every combination of strategy, rules and pins, because the point of this
 * function is that some of them are inert and nothing else says so.
 */
describe('strategyWarnings', () => {
  describe('PINNED groups', () => {
    it('warns that rules decide nothing', () => {
      const [warning, ...rest] = strategyWarnings({
        strategy: 'PINNED',
        ruleCount: 3,
        pinCount: 2,
      });

      expect(warning).toContain('matches by pinned node');
      expect(warning).toContain('3 rules');
      expect(warning).toContain('ALL_RULES');
      expect(rest).toEqual([]);
    });

    it('says nothing when it holds only pins', () => {
      expect(strategyWarnings({ strategy: 'PINNED', ruleCount: 0, pinCount: 5 })).toEqual([]);
    });

    it('does NOT complain that a pinned group has no rules', () => {
      // The rule-based emptiness warning must not leak across. A PINNED group
      // with no rules is not merely fine, it is the normal case.
      expect(strategyWarnings({ strategy: 'PINNED', ruleCount: 0, pinCount: 0 })).toEqual([]);
    });
  });

  describe.each(['ALL_RULES', 'ANY_RULE'] as const)('%s groups', (strategy) => {
    it('warns that pins decide nothing', () => {
      const warnings = strategyWarnings({ strategy, ruleCount: 2, pinCount: 1 });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('matches by rule');
      expect(warnings[0]).toContain('1 pinned node');
      expect(warnings[0]).toContain('PINNED');
    });

    it('warns that no rules means no nodes', () => {
      const warnings = strategyWarnings({ strategy, ruleCount: 0, pinCount: 0 });

      expect(warnings).toEqual(['A rule-based group with no rules matches no nodes.']);
    });

    it('warns twice when the group is empty of rules AND holds orphaned pins', () => {
      // The state produced by flipping a PINNED group to a rule strategy and
      // never adding rules — both facts matter and neither implies the other.
      const warnings = strategyWarnings({ strategy, ruleCount: 0, pinCount: 4 });

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('4 pinned nodes');
      expect(warnings[1]).toContain('no rules');
    });

    it('says nothing about a group with rules and no pins', () => {
      expect(strategyWarnings({ strategy, ruleCount: 1, pinCount: 0 })).toEqual([]);
    });
  });

  it('pluralises so the message reads as English either way', () => {
    const one = strategyWarnings({ strategy: 'PINNED', ruleCount: 1, pinCount: 0 })[0] ?? '';
    const many = strategyWarnings({ strategy: 'PINNED', ruleCount: 2, pinCount: 0 })[0] ?? '';

    expect(one).toContain('1 rule ');
    expect(many).toContain('2 rules ');
  });
});
