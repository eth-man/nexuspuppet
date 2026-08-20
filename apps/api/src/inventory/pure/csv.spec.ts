import { csvField, csvRow, isFormulaRisk } from './csv';

/*
 * CSV export (#243 phase 3).
 *
 * The assertions that matter are about VALUES THE NODES CONTROL. A certname and
 * every fact in an export are self-reported by the agent, so a machine that can
 * set one of its own facts can choose what lands in an operator's spreadsheet.
 */

describe('isFormulaRisk', () => {
  /*
   * THE ATTACK. Excel's legacy DDE syntax turns a leading `=` into a command,
   * so this string in a fact value runs a program on the workstation of
   * whoever opens the export.
   */
  it.each([String.raw`=cmd|'/c calc'!A0`, '=1+1', '@SUM(A1:A9)', '+HYPERLINK("http://x")'])(
    'flags %s',
    (value) => {
      expect(isFormulaRisk(value)).toBe(true);
    },
  );

  /*
   * Excel strips leading whitespace BEFORE deciding whether a cell is a
   * formula, so a tab in front of the equals sign does not make it safe.
   */
  it('flags a formula hidden behind leading whitespace', () => {
    // A REAL tab, not the two characters `\t` — the point is the control
    // character Excel strips before deciding.
    expect(isFormulaRisk("\t=cmd|'/c calc'!A0")).toBe(true);
    expect(isFormulaRisk('\r=1+1')).toBe(true);
  });

  /*
   * AND THE OTHER HALF, which a blunt fix gets wrong. A negative number starts
   * with a dangerous character and is not a formula; quoting it as text turns
   * every negative value in an export into something nobody can sum.
   */
  it.each(['-5', '-5.25', '+3', '1.5e3', '-1.5E-3', '.5'])(
    'leaves the number %s alone',
    (value) => {
      expect(isFormulaRisk(value)).toBe(false);
    },
  );

  it('flags arithmetic that merely looks like a number', () => {
    expect(isFormulaRisk('-1+1')).toBe(true);
    expect(isFormulaRisk('-5,6')).toBe(true);
  });

  it.each(['web01.example.com', 'Ubuntu', '0644', '', 'a=b'])('leaves %s alone', (value) => {
    expect(isFormulaRisk(value)).toBe(false);
  });
});

describe('csvField', () => {
  it('defuses a formula with a leading apostrophe', () => {
    // quote, apostrophe, the original text, quote — the apostrophe is what
    // makes a spreadsheet display the cell instead of evaluating it.
    expect(csvField('=1+1')).toBe(`"'=1+1"`);
    expect(csvField('@SUM(A1:A9)')).toBe(`"'@SUM(A1:A9)"`);
  });

  it('doubles a literal quote, per RFC 4180', () => {
    expect(csvField('say "hello"')).toBe('"say ""hello"""');
  });

  it('quotes a field containing a comma or a newline', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  /*
   * A quote is not an escape hatch out of the cell: the defused value stays
   * inside its quotes, so a field cannot break the row structure.
   */
  it('cannot be used to break out of the field', () => {
    const hostile = String.raw`","=cmd|'/c calc'!A0,"`;
    const field = csvField(hostile);

    expect(field.startsWith('"')).toBe(true);
    expect(field.endsWith('"')).toBe(true);
    // Every internal quote doubled — so no bare `","` sequence remains to end
    // the field early.
    expect(field.slice(1, -1).replace(/""/g, '')).not.toContain('"');
  });

  it('renders absent values as empty, never as "null" or "undefined"', () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
  });

  it('serialises a structured fact value rather than printing [object Object]', () => {
    expect(csvField({ major: '22.04' })).toBe('"{""major"":""22.04""}"');
    expect(csvField(['a', 'b'])).toBe('"[""a"",""b""]"');
  });

  it('keeps booleans and numbers readable', () => {
    expect(csvField(true)).toBe('"true"');
    expect(csvField(0)).toBe('"0"');
  });
});

describe('csvRow', () => {
  it('joins fields with commas and ends CRLF, as the RFC says', () => {
    expect(csvRow(['a', 'b'])).toBe('"a","b"\r\n');
  });

  it('keeps an empty row structurally valid', () => {
    expect(csvRow(['', ''])).toBe('"",""\r\n');
  });
});
