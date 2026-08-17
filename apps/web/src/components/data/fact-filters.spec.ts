import { completeFactRows, type FactRow } from './fact-filters';

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
