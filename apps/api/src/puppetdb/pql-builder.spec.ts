import {
  buildNodeQuery,
  buildCountQuery,
  buildPagination,
  escapeRegex,
  resolveOrderBy,
} from './pql-builder';
import { nodeFilterSchema, type NodeFilter } from '@nexuspuppet/contracts';

const filter = (over: Partial<NodeFilter> = {}): NodeFilter => ({
  includeInactive: false,
  ...over,
});

describe('escapeRegex', () => {
  // Without escaping, `.*` matches the whole estate and `(a+)+$` is a ReDoS
  // against PuppetDB itself (ADR-0004).
  it.each([
    ['.*', '\\.\\*'],
    ['web01.example.com', 'web01\\.example\\.com'],
    ['(a+)+$', '\\(a\\+\\)\\+\\$'],
    ['a|b', 'a\\|b'],
    ['[abc]', '\\[abc\\]'],
    ['back\\slash', 'back\\\\slash'],
  ])('escapes %s', (input, expected) => {
    expect(escapeRegex(input)).toBe(expected);
  });

  it('produces a pattern that matches the literal only', () => {
    const re = new RegExp(escapeRegex('web01.example.com'));
    expect(re.test('web01.example.com')).toBe(true);
    expect(re.test('web01Xexample.com')).toBe(false);
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeRegex('web01')).toBe('web01');
  });
});

describe('buildNodeQuery', () => {
  // PuppetDB reads an absent query as "everything"; an empty ["and"] is a
  // syntax error.
  it('returns a query even for an empty filter, because inactive nodes are hidden', () => {
    expect(buildNodeQuery(filter())).toEqual([
      'and',
      ['null?', 'deactivated', true],
      ['null?', 'expired', true],
    ]);
  });

  it('returns null when nothing at all constrains the query', () => {
    expect(buildNodeQuery(filter({ includeInactive: true }))).toBeNull();
  });

  it('unwraps a single clause rather than emitting a one-element and', () => {
    const q = buildNodeQuery(filter({ includeInactive: true, certnameContains: 'web' }));
    expect(q).toEqual(['~', 'certname', 'web']);
  });

  describe('values never escape their slot', () => {
    // The point of the AST: a hostile value stays a value.
    it.each(['x", "y', "'; DROP TABLE nodes; --", '["or", ["=", "certname", "anything"]]', '\\'])(
      'keeps %s as data',
      (hostile) => {
        const q = buildNodeQuery(
          filter({ includeInactive: true, certnameContains: hostile }),
        ) as unknown[];
        expect(q[0]).toBe('~');
        expect(q[1]).toBe('certname');
        // Round-trips as a single JSON string, never as structure.
        const roundTripped = JSON.parse(JSON.stringify(q)) as unknown[];
        expect(typeof roundTripped[2]).toBe('string');
        expect(roundTripped).toHaveLength(3);
      },
    );
  });

  it('matches an environment across all three environment fields', () => {
    const q = buildNodeQuery(
      filter({ includeInactive: true, environments: ['production'] }),
    ) as unknown[];

    expect(q).toEqual([
      'or',
      ['=', 'report_environment', 'production'],
      ['=', 'facts_environment', 'production'],
      ['=', 'catalog_environment', 'production'],
    ]);
  });

  describe('statuses', () => {
    it('ors literal statuses', () => {
      const q = buildNodeQuery(filter({ includeInactive: true, statuses: ['failed', 'changed'] }));
      expect(q).toEqual([
        'or',
        ['=', 'latest_report_status', 'failed'],
        ['=', 'latest_report_status', 'changed'],
      ]);
    });

    // Our `unknown` is PuppetDB's null; there is no literal to compare to.
    it('translates unknown to a null check', () => {
      const q = buildNodeQuery(filter({ includeInactive: true, statuses: ['unknown'] }));
      expect(q).toEqual(['or', ['null?', 'latest_report_status', true]]);
    });
  });

  // A node that never reported is stale by any reasonable reading; a bare
  // `<` comparison would silently exclude exactly the nodes an operator is
  // hunting for.
  it('counts never-reported nodes as stale', () => {
    const q = buildNodeQuery(
      filter({ includeInactive: true, staleBefore: '2026-07-01T00:00:00.000Z' }),
    );
    expect(q).toEqual([
      'or',
      ['<', 'report_timestamp', '2026-07-01T00:00:00.000Z'],
      ['null?', 'report_timestamp', true],
    ]);
  });

  it('combines multiple clauses under a single and', () => {
    const q = buildNodeQuery(
      filter({ certnameContains: 'web', statuses: ['failed'] }),
    ) as unknown[];

    expect(q[0]).toBe('and');
    expect(q).toHaveLength(5); // and + certname + status + deactivated + expired
  });

  it('ignores empty strings rather than emitting a match-everything clause', () => {
    expect(buildNodeQuery(filter({ includeInactive: true, certnameContains: '' }))).toBeNull();
    expect(buildNodeQuery(filter({ includeInactive: true, staleBefore: '' }))).toBeNull();
  });

  it('ignores empty arrays', () => {
    expect(buildNodeQuery(filter({ includeInactive: true, environments: [] }))).toBeNull();
    expect(buildNodeQuery(filter({ includeInactive: true, statuses: [] }))).toBeNull();
  });
});

describe('buildCountQuery', () => {
  it('wraps a query', () => {
    expect(buildCountQuery(['=', 'certname', 'a'])).toEqual([
      'extract',
      [['function', 'count']],
      ['=', 'certname', 'a'],
    ]);
  });

  it('counts everything when there is no query', () => {
    expect(buildCountQuery(null)).toEqual(['extract', [['function', 'count']]]);
  });
});

describe('resolveOrderBy', () => {
  it('defaults to certname', () => {
    expect(resolveOrderBy(undefined)).toBe('certname');
  });

  it('accepts allow-listed wire fields and camelCase aliases', () => {
    expect(resolveOrderBy('report_timestamp')).toBe('report_timestamp');
    expect(resolveOrderBy('reportTimestamp')).toBe('report_timestamp');
  });

  // Passing an unknown field through would earn an opaque PuppetDB 400 that
  // reaches the operator as "something broke".
  it('falls back for anything not allow-listed', () => {
    expect(resolveOrderBy('; DROP TABLE')).toBe('certname');
    expect(resolveOrderBy('password')).toBe('certname');
  });
});

describe('buildPagination', () => {
  it('emits order_by as JSON', () => {
    const p = buildPagination({ limit: 25, offset: 50, order: 'desc', orderBy: 'reportTimestamp' });
    expect(p).toEqual({
      limit: 25,
      offset: 50,
      order_by: '[{"field":"report_timestamp","order":"desc"}]',
    });
  });

  it('defaults the sort field', () => {
    const p = buildPagination({ limit: 10, offset: 0, order: 'asc' });
    expect(JSON.parse(p.order_by)).toEqual([{ field: 'certname', order: 'asc' }]);
  });
});

describe('factsChangedSince', () => {
  it('emits a strict greater-than on facts_timestamp', () => {
    const ast = buildNodeQuery(
      nodeFilterSchema.parse({ factsChangedSince: '2026-07-28T00:00:00.000Z' }),
    );
    expect(JSON.stringify(ast)).toContain('[">","facts_timestamp","2026-07-28T00:00:00.000Z"]');
  });

  /**
   * Unlike staleBefore, this is NOT or-ed with a null check. A node that has
   * never submitted facts has nothing to reclassify against, and including it
   * would return every factless node on every poll, forever.
   */
  it('does not include nodes that have never submitted facts', () => {
    const ast = buildNodeQuery(
      nodeFilterSchema.parse({ factsChangedSince: '2026-07-28T00:00:00.000Z' }),
    );
    // Scoped to this field: includeInactive legitimately emits null? clauses
    // for deactivated and expired, so asserting on the whole AST would pass or
    // fail for reasons unrelated to facts.
    expect(JSON.stringify(ast)).not.toContain('["null?","facts_timestamp"');
  });

  it('is absent from the query when not asked for', () => {
    const ast = buildNodeQuery(nodeFilterSchema.parse({}));
    expect(JSON.stringify(ast ?? null)).not.toContain('facts_timestamp');
  });

  /** Rule 2: a value never reaches an interpreter as text. */
  it('rejects a non-timestamp rather than interpolating it', () => {
    expect(() => nodeFilterSchema.parse({ factsChangedSince: "' or 1=1 --" })).toThrow();
  });
});
