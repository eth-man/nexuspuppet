import { collapseUnchanged, diffLines, isMultiline, MAX_DIFF_LINES } from './diff-lines';

/*
 * Line diffs for multi-line parameter values (ADR-0025 §9).
 *
 * The screen exists so an operator does not diff two blobs by eye. These tests
 * are about whether the output is READABLE, not merely correct: a diff that
 * marks every line as changed is technically a diff and practically useless.
 */

const text = (...lines: string[]) => lines.join('\n');

describe('isMultiline', () => {
  it('is true only for strings spanning lines', () => {
    expect(isMultiline('a\nb')).toBe(true);
    expect(isMultiline('0600')).toBe(false);
    expect(isMultiline(600)).toBe(false);
    expect(isMultiline(null)).toBe(false);
    expect(isMultiline(['a\nb'])).toBe(false);
  });
});

describe('diffLines', () => {
  /*
   * THE REAL CASE, from the staging fixture. Two lines, one of which changed —
   * the output must say exactly that.
   */
  it('marks one changed line and leaves the rest alone', () => {
    const result = diffLines(
      text('# managed by puppet', 'PermitRootLogin no', ''),
      text('# managed by puppet', 'PermitRootLogin yes', ''),
    );

    expect(result).toEqual([
      { kind: 'same', text: '# managed by puppet' },
      { kind: 'removed', text: 'PermitRootLogin no' },
      { kind: 'added', text: 'PermitRootLogin yes' },
      { kind: 'same', text: '' },
    ]);
  });

  /*
   * REMOVED BEFORE ADDED. Every diff anybody has ever read puts the old line
   * above the new one; reversing it would be correct and unreadable.
   */
  it('puts the removed line above the added one', () => {
    const result = diffLines('old', 'new');

    expect(result?.map((l) => l.kind)).toEqual(['removed', 'added']);
  });

  it('finds an inserted line without marking the rest changed', () => {
    const result = diffLines(text('a', 'c'), text('a', 'b', 'c'));

    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('finds a deleted line', () => {
    const result = diffLines(text('a', 'b', 'c'), text('a', 'c'));

    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('reports nothing changed when the values are identical', () => {
    const result = diffLines(text('a', 'b'), text('a', 'b'));

    expect(result?.every((l) => l.kind === 'same')).toBe(true);
  });

  /*
   * A CHANGE IN THE MIDDLE of a long file must not cascade. An LCS that lost
   * alignment would mark every following line as changed, which is exactly the
   * unreadable output this function exists to avoid.
   */
  it('does not cascade a mid-file change into the rest of the file', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${String(i)}`);
    const after = [...before];
    after[25] = 'line 25 CHANGED';

    const result = diffLines(before.join('\n'), after.join('\n'));
    const changed = result?.filter((l) => l.kind !== 'same') ?? [];

    expect(changed).toHaveLength(2);
    expect(changed[0]).toEqual({ kind: 'removed', text: 'line 25' });
    expect(changed[1]).toEqual({ kind: 'added', text: 'line 25 CHANGED' });
  });

  /*
   * A managed file can be enormous — a generated allow-list, a bundled cert
   * chain. Null is honest; a truncated diff presented as a whole one is not.
   */
  it('refuses a file too large to diff usefully', () => {
    const huge = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => String(i)).join('\n');

    expect(diffLines(huge, huge)).toBeNull();
    expect(diffLines('small', huge)).toBeNull();
  });
});

describe('collapseUnchanged', () => {
  /*
   * A hundred identical lines around the one that changed is the same problem
   * the side-by-side view had.
   */
  it('keeps the change and a little context, dropping the bulk', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`);
    const after = [...before];
    after[20] = 'CHANGED';

    const collapsed = collapseUnchanged(diffLines(before.join('\n'), after.join('\n')) ?? []);

    // Two changed lines plus two lines of context either side of each.
    expect(collapsed.length).toBeLessThan(12);
    expect(collapsed.some((l) => l.text === 'CHANGED')).toBe(true);
    expect(collapsed.some((l) => l.text === 'line 19')).toBe(true);
    expect(collapsed.some((l) => l.text === 'line 0')).toBe(false);
  });

  /*
   * Nothing changed: there is nothing to collapse TO. Returning an empty list
   * would render as "no difference" under a heading that says there is one.
   */
  it('returns the value unchanged when nothing differs', () => {
    const lines = diffLines(text('a', 'b'), text('a', 'b')) ?? [];

    expect(collapseUnchanged(lines)).toHaveLength(2);
  });
});
