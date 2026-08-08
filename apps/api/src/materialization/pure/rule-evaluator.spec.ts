import {
  matchGroups,
  evaluateRule,
  resolveFactPath,
  groupMatches,
  explainMatch,
} from './rule-evaluator';
import type { EvaluableGroup, EvaluableNode } from './rule-evaluator';
import type { NodeRule } from '@nexuspuppet/contracts';

const facts = {
  os: { family: 'RedHat', release: { major: '9' } },
  memorymb: 16384,
  is_virtual: true,
  networking: { domain: 'example.com' },
  empty_string: '',
  nullish: null,
};

const group = (over: Partial<EvaluableGroup> = {}): EvaluableGroup => ({
  id: 'g1',
  name: 'group',
  rank: 100,
  strategy: 'ALL_RULES',
  isEnabled: true,
  rules: [],
  pinnedCertnames: [],
  ...over,
});

const node = (over: Partial<EvaluableNode> = {}): EvaluableNode => ({
  certname: 'web01.example.com',
  facts,
  ...over,
});

const rule = (factPath: string, operator: NodeRule['operator'], value?: unknown): NodeRule =>
  value === undefined ? { factPath, operator } : { factPath, operator, value };

describe('resolveFactPath', () => {
  it.each([
    ['os.family', 'RedHat'],
    ['os.release.major', '9'],
    ['memorymb', 16384],
    ['networking.domain', 'example.com'],
    ['nullish', null],
  ])('resolves %s', (path, expected) => {
    expect(resolveFactPath(facts, path)).toEqual(expected);
  });

  it.each([
    ['os.missing'],
    ['missing.entirely'],
    ['os.family.deeper'], // descending into a scalar
    [''],
  ])('returns undefined for %s', (path) => {
    expect(resolveFactPath(facts, path)).toBeUndefined();
  });
});

describe('evaluateRule', () => {
  describe('EQUALS', () => {
    it('matches identical strings', () => {
      expect(evaluateRule(facts, rule('os.family', 'EQUALS', 'RedHat'))).toBe(true);
    });

    it('is case sensitive', () => {
      expect(evaluateRule(facts, rule('os.family', 'EQUALS', 'redhat'))).toBe(false);
    });

    // Facts arrive as JSON; "9" from a fact must match 9 from a rule.
    it('compares scalars across string/number representations', () => {
      expect(evaluateRule(facts, rule('os.release.major', 'EQUALS', 9))).toBe(true);
      expect(evaluateRule(facts, rule('memorymb', 'EQUALS', '16384'))).toBe(true);
    });

    it('does not match a missing fact', () => {
      expect(evaluateRule(facts, rule('os.missing', 'EQUALS', 'anything'))).toBe(false);
    });

    it('never equates an object with a scalar', () => {
      expect(evaluateRule(facts, rule('os', 'EQUALS', '[object Object]'))).toBe(false);
    });
  });

  describe('NOT_EQUALS', () => {
    it('matches a differing value', () => {
      expect(evaluateRule(facts, rule('os.family', 'NOT_EQUALS', 'Debian'))).toBe(true);
    });

    // A missing fact is not "not equal" — it is unknown. Treating absence as a
    // match would let a typo'd fact path classify the whole estate.
    it('does NOT match a missing fact', () => {
      expect(evaluateRule(facts, rule('os.missing', 'NOT_EQUALS', 'Debian'))).toBe(false);
    });
  });

  describe('EXISTS / NOT_EXISTS', () => {
    it('EXISTS matches a present fact, including falsy values', () => {
      expect(evaluateRule(facts, rule('empty_string', 'EXISTS'))).toBe(true);
      expect(evaluateRule(facts, rule('nullish', 'EXISTS'))).toBe(true);
    });

    it('NOT_EXISTS matches an absent fact', () => {
      expect(evaluateRule(facts, rule('os.missing', 'NOT_EXISTS'))).toBe(true);
      expect(evaluateRule(facts, rule('os.family', 'NOT_EXISTS'))).toBe(false);
    });
  });

  describe('MATCHES_REGEX', () => {
    it('matches', () => {
      expect(evaluateRule(facts, rule('networking.domain', 'MATCHES_REGEX', '\\.com$'))).toBe(true);
    });

    it('does not match', () => {
      expect(evaluateRule(facts, rule('networking.domain', 'MATCHES_REGEX', '^prod-'))).toBe(false);
    });

    // An invalid regex must never abort materialization for the whole estate.
    it('returns false for an invalid pattern instead of throwing', () => {
      expect(() =>
        evaluateRule(facts, rule('networking.domain', 'MATCHES_REGEX', '([unclosed')),
      ).not.toThrow();
      expect(evaluateRule(facts, rule('networking.domain', 'MATCHES_REGEX', '([unclosed'))).toBe(
        false,
      );
    });

    it('returns false when the expected value is not a string', () => {
      expect(evaluateRule(facts, rule('networking.domain', 'MATCHES_REGEX', 42))).toBe(false);
    });
  });

  describe('IN / NOT_IN', () => {
    it('IN matches membership', () => {
      expect(evaluateRule(facts, rule('os.family', 'IN', ['Debian', 'RedHat']))).toBe(true);
      expect(evaluateRule(facts, rule('os.family', 'IN', ['Debian', 'Suse']))).toBe(false);
    });

    it('IN returns false when the expected value is not an array', () => {
      expect(evaluateRule(facts, rule('os.family', 'IN', 'RedHat'))).toBe(false);
    });

    it('NOT_IN does not match a missing fact', () => {
      expect(evaluateRule(facts, rule('os.missing', 'NOT_IN', ['a']))).toBe(false);
    });
  });

  describe('GREATER_THAN / LESS_THAN', () => {
    it('compares numerically, including numeric strings', () => {
      expect(evaluateRule(facts, rule('memorymb', 'GREATER_THAN', 8192))).toBe(true);
      expect(evaluateRule(facts, rule('memorymb', 'LESS_THAN', 8192))).toBe(false);
      expect(evaluateRule(facts, rule('os.release.major', 'GREATER_THAN', 8))).toBe(true);
    });

    // Lexicographic comparison here would make "10" < "9". It must not.
    it('does not fall back to string comparison', () => {
      expect(evaluateRule({ v: '10' }, rule('v', 'GREATER_THAN', '9'))).toBe(true);
    });

    it('returns false for non-numeric operands', () => {
      expect(evaluateRule(facts, rule('os.family', 'GREATER_THAN', 5))).toBe(false);
      expect(evaluateRule(facts, rule('is_virtual', 'LESS_THAN', 5))).toBe(false);
    });
  });
});

describe('groupMatches', () => {
  it('ALL_RULES requires every rule', () => {
    const g = group({
      rules: [rule('os.family', 'EQUALS', 'RedHat'), rule('memorymb', 'GREATER_THAN', 8192)],
    });
    expect(groupMatches(node(), g)).toBe(true);

    const g2 = group({
      rules: [rule('os.family', 'EQUALS', 'RedHat'), rule('memorymb', 'GREATER_THAN', 99999)],
    });
    expect(groupMatches(node(), g2)).toBe(false);
  });

  it('ANY_RULE requires one rule', () => {
    const g = group({
      strategy: 'ANY_RULE',
      rules: [rule('os.family', 'EQUALS', 'Debian'), rule('memorymb', 'GREATER_THAN', 8192)],
    });
    expect(groupMatches(node(), g)).toBe(true);
  });

  // An empty draft group matching everything would silently classify the estate.
  it('a rule-based group with no rules matches NOTHING', () => {
    expect(groupMatches(node(), group({ strategy: 'ALL_RULES', rules: [] }))).toBe(false);
    expect(groupMatches(node(), group({ strategy: 'ANY_RULE', rules: [] }))).toBe(false);
  });

  it('PINNED matches only listed certnames and ignores rules', () => {
    const g = group({
      strategy: 'PINNED',
      pinnedCertnames: ['web01.example.com'],
      rules: [rule('os.family', 'EQUALS', 'Debian')],
    });
    expect(groupMatches(node(), g)).toBe(true);
    expect(groupMatches(node({ certname: 'db01.example.com' }), g)).toBe(false);
  });

  it('a disabled group never matches', () => {
    const g = group({ isEnabled: false, rules: [rule('os.family', 'EQUALS', 'RedHat')] });
    expect(groupMatches(node(), g)).toBe(false);
  });
});

describe('matchGroups ordering (ADR-0009)', () => {
  const matching = (id: string, rank: number) =>
    group({ id, name: id, rank, rules: [rule('os.family', 'EQUALS', 'RedHat')] });

  it('sorts by rank ascending so higher rank is applied last and wins', () => {
    const result = matchGroups(node(), [
      matching('c', 300),
      matching('a', 100),
      matching('b', 200),
    ]);
    expect(result.map((g) => g.id)).toEqual(['a', 'b', 'c']);
  });

  // Determinism is what makes content-hash change detection correct.
  it('breaks rank ties by id, independent of input order', () => {
    const forward = matchGroups(node(), [
      matching('z', 100),
      matching('a', 100),
      matching('m', 100),
    ]);
    const reverse = matchGroups(node(), [
      matching('m', 100),
      matching('a', 100),
      matching('z', 100),
    ]);
    expect(forward.map((g) => g.id)).toEqual(['a', 'm', 'z']);
    expect(reverse.map((g) => g.id)).toEqual(forward.map((g) => g.id));
  });

  it('excludes non-matching and disabled groups', () => {
    const result = matchGroups(node(), [
      matching('a', 100),
      group({ id: 'b', rank: 100, rules: [rule('os.family', 'EQUALS', 'Debian')] }),
      group({
        id: 'c',
        rank: 100,
        isEnabled: false,
        rules: [rule('os.family', 'EQUALS', 'RedHat')],
      }),
    ]);
    expect(result.map((g) => g.id)).toEqual(['a']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(matchGroups(node(), [])).toEqual([]);
  });
});

describe('explainMatch (#142)', () => {
  const node = { certname: 'web01.example.com', facts: { os: { family: 'RedHat' }, tier: 'gold' } };

  const group = (over: Partial<Parameters<typeof explainMatch>[1]> = {}) =>
    ({
      id: 'g1',
      name: 'group one',
      rank: 100,
      strategy: 'ALL_RULES',
      isEnabled: true,
      rules: [],
      pinnedCertnames: [],
      ...over,
    }) as Parameters<typeof explainMatch>[1];

  it('says pinned, with nothing to inspect', () => {
    const result = explainMatch(
      node,
      group({ strategy: 'PINNED', pinnedCertnames: [node.certname] }),
    );

    expect(result).toEqual({ groupId: 'g1', strategy: 'PINNED', rules: [] });
  });

  it('reports the fact path, the expectation, and the value that satisfied it', () => {
    const result = explainMatch(
      node,
      group({ rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }] }),
    );

    expect(result.rules[0]).toEqual({
      factPath: 'os.family',
      operator: 'EQUALS',
      expected: 'RedHat',
      actual: 'RedHat',
      factMissing: false,
      matched: true,
    });
  });

  /*
   * Under ANY_RULE a group applies on one rule out of several, and knowing
   * which ones did NOT is most of the explanation — the difference between
   * "this is why" and "one of these is why".
   */
  it('reports every rule, including the ones that did not match', () => {
    const result = explainMatch(
      node,
      group({
        strategy: 'ANY_RULE',
        rules: [
          { factPath: 'os.family', operator: 'EQUALS', value: 'Debian' },
          { factPath: 'tier', operator: 'EQUALS', value: 'gold' },
        ],
      }),
    );

    expect(result.rules.map((r) => r.matched)).toEqual([false, true]);
  });

  /*
   * A path outside the projected allow-list is indistinguishable from a
   * genuinely absent fact, so a rule can look deliberate and be permanently
   * unsatisfiable. Saying the fact was missing is what makes that visible.
   */
  it('flags a fact path that resolved to nothing', () => {
    const result = explainMatch(
      node,
      group({ rules: [{ factPath: 'datacenter', operator: 'EQUALS', value: 'ams1' }] }),
    );

    expect(result.rules[0]?.factMissing).toBe(true);
    expect(result.rules[0]).not.toHaveProperty('actual');
    expect(result.rules[0]?.matched).toBe(false);
  });

  it('omits the expectation for operators that take none', () => {
    const result = explainMatch(node, group({ rules: [{ factPath: 'tier', operator: 'EXISTS' }] }));

    expect(result.rules[0]).not.toHaveProperty('expected');
    expect(result.rules[0]?.matched).toBe(true);
  });

  /*
   * The explanation must agree with the decision. Two functions computing "did
   * this match" are two answers waiting to disagree, and the one written to
   * disk would win silently.
   */
  it('agrees with groupMatches on every rule outcome', () => {
    const rules = [
      { factPath: 'os.family', operator: 'EQUALS' as const, value: 'RedHat' },
      { factPath: 'tier', operator: 'EQUALS' as const, value: 'silver' },
    ];

    for (const strategy of ['ALL_RULES', 'ANY_RULE'] as const) {
      const g = group({ strategy, rules });
      const explained = explainMatch(node, g);
      const decided = groupMatches(node, g);

      const expected =
        strategy === 'ALL_RULES'
          ? explained.rules.every((r) => r.matched)
          : explained.rules.some((r) => r.matched);

      expect(decided).toBe(expected);
    }
  });
});
