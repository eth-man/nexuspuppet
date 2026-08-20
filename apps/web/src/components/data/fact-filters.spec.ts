import { completeFactRows, factRowsFrom, valueSuggestions, type FactRow } from './fact-filters';

const row = (over: Partial<FactRow> = {}): FactRow => ({
  path: 'os.name',
  operator: 'EQUALS',
  value: 'Ubuntu',
  ...over,
});

/*
 * A half-typed row must not narrow the estate. Somebody typing `os.` should see
 * the list they had — not an empty one, and not a request per keystroke.
 */
describe('completeFactRows', () => {
  it('sends a complete row', () => {
    expect(completeFactRows([row()])).toEqual([
      { path: 'os.name', operator: 'EQUALS', value: 'Ubuntu' },
    ]);
  });

  it.each([
    ['no path yet', row({ path: '' })],
    ['no value yet', row({ value: '' })],
    ['whitespace only', row({ path: '   ', value: '  ' })],
  ])('holds back a row with %s', (_label, r) => {
    expect(completeFactRows([r])).toEqual([]);
  });

  it('keeps the complete rows and drops the rest', () => {
    expect(
      completeFactRows([row(), row({ path: '' }), row({ path: 'kernel', value: 'Linux' })]),
    ).toHaveLength(2);
  });

  /*
   * EXISTS asks only whether the fact is reported, so requiring a value would
   * make the row permanently incomplete and silently unsendable.
   */
  it.each(['EXISTS', 'NOT_EXISTS'] as const)('sends %s with no value', (operator) => {
    expect(completeFactRows([row({ operator, value: '' })])).toEqual([
      { path: 'os.name', operator },
    ]);
  });

  it('splits IN on commas and trims', () => {
    expect(completeFactRows([row({ operator: 'IN', value: ' Ubuntu , Debian ' })])).toEqual([
      { path: 'os.name', operator: 'IN', value: ['Ubuntu', 'Debian'] },
    ]);
  });

  it('holds back an IN row whose list is only separators', () => {
    expect(completeFactRows([row({ operator: 'IN', value: ' , , ' })])).toEqual([]);
  });

  it('trims the path, so a stray space does not become part of the fact name', () => {
    expect(completeFactRows([row({ path: '  os.release.major  ', value: '22.04' })])).toEqual([
      { path: 'os.release.major', operator: 'EQUALS', value: '22.04' },
    ]);
  });
});

/*
 * The value picker (#243).
 *
 * The operator reported that the filter "donst auto completet the facts vlaues
 * but only the facts themselfs" — and the suggestions were on the wire the
 * whole time: /fact-paths sends a `values` list for most paths, and the value
 * field simply never read it. A wrong value and a genuinely empty result look
 * identical in the UI, which is what makes the picker worth more than polish.
 */
describe('valueSuggestions', () => {
  const paths = [
    { path: 'os.name', nodeCount: 48, sampleValue: 'Ubuntu', values: ['Ubuntu', 'CentOS'] },
    { path: 'is_virtual', nodeCount: 48, sampleValue: true, values: [true, false] },
    { path: 'os.release.major', nodeCount: 48, sampleValue: 9, values: [9, 12] },
    // High cardinality: the API deliberately sends no list at all.
    { path: 'networking.ip', nodeCount: 48, sampleValue: '10.0.0.1' },
  ];

  it('offers the observed values for the chosen path', () => {
    expect(valueSuggestions(row(), paths)).toEqual(['Ubuntu', 'CentOS']);
  });

  it('matches the path after trimming, as the filter itself does', () => {
    expect(valueSuggestions(row({ path: '  os.name  ' }), paths)).toEqual(['Ubuntu', 'CentOS']);
  });

  /*
   * Facts are not all strings. The filter compares as text, so a picker that
   * offered a raw boolean would hand back a value matching nothing.
   */
  it('renders non-string values as the text the filter will compare', () => {
    expect(valueSuggestions(row({ path: 'is_virtual' }), paths)).toEqual(['true', 'false']);
    expect(valueSuggestions(row({ path: 'os.release.major' }), paths)).toEqual(['9', '12']);
  });

  /*
   * Undefined is the ordinary case, not a failure — it leaves the field as free
   * text. Returning [] instead would render an empty picker, which reads as
   * "this fact has no values".
   */
  it('offers nothing for a high-cardinality path', () => {
    expect(valueSuggestions(row({ path: 'networking.ip' }), paths)).toBeUndefined();
  });

  it('offers nothing for a path the estate does not report', () => {
    expect(valueSuggestions(row({ path: 'nosuchfact' }), paths)).toBeUndefined();
  });

  it('offers nothing before the paths have loaded', () => {
    expect(valueSuggestions(row(), undefined)).toBeUndefined();
  });

  /*
   * `is one of` takes a comma-separated list, and choosing from a datalist
   * REPLACES the whole field — so a suggestion here would silently delete the
   * values already typed.
   */
  it('offers nothing for `is one of`, whose input is a list', () => {
    expect(valueSuggestions(row({ operator: 'IN' }), paths)).toBeUndefined();
  });
});

/*
 * Restoring a saved query into the editor (ADR-0026 §8).
 *
 * The operator applied a saved resource query, saw correct results, and an
 * EMPTY filter box: the conditions were never put back into the rows. The
 * query ran fine, which is what makes it insidious — the screen showed one
 * thing and stated another, and only a person looking at it could tell.
 */
describe('factRowsFrom', () => {
  it('is the inverse of completeFactRows', () => {
    const rows: FactRow[] = [
      { path: 'os.name', operator: 'EQUALS', value: 'Ubuntu' },
      { path: 'os.release.major', operator: 'NOT_EQUALS', value: '22.04' },
      { path: 'role', operator: 'MATCHES_REGEX', value: '^web' },
      { path: 'is_virtual', operator: 'EXISTS', value: '' },
    ];

    expect(factRowsFrom(completeFactRows(rows))).toEqual(rows);
  });

  /*
   * THE ONE THAT BREAKS SILENTLY. `IN` is stored as an array and edited as a
   * comma-separated string; without the join, a saved "is one of" reopens as an
   * empty field while still returning its results.
   */
  it('round-trips IN through its comma-separated form', () => {
    const rows: FactRow[] = [{ path: 'os.name', operator: 'IN', value: 'Ubuntu, Debian' }];

    expect(completeFactRows(rows)).toEqual([
      { path: 'os.name', operator: 'IN', value: ['Ubuntu', 'Debian'] },
    ]);
    expect(factRowsFrom(completeFactRows(rows))).toEqual(rows);
  });

  it('renders a non-string value as the text the editor holds', () => {
    expect(factRowsFrom([{ path: 'is_virtual', operator: 'EQUALS', value: true }])).toEqual([
      { path: 'is_virtual', operator: 'EQUALS', value: 'true' },
    ]);
  });

  it('gives a value-less operator an empty field, not "undefined"', () => {
    expect(factRowsFrom([{ path: 'os.name', operator: 'EXISTS' }])).toEqual([
      { path: 'os.name', operator: 'EXISTS', value: '' },
    ]);
  });

  it('has nothing to restore from nothing', () => {
    expect(factRowsFrom(undefined)).toEqual([]);
    expect(factRowsFrom([])).toEqual([]);
  });
});
