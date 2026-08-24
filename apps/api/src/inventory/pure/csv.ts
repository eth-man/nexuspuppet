/**
 * CSV, safely (#243 phase 3).
 *
 * PURE: no I/O, no clock, no randomness.
 *
 * THE THREAT THIS EXISTS FOR. Everything exported here is REPORTED BY THE
 * NODES THEMSELVES — certnames, environments, and every fact value. A
 * spreadsheet treats a cell beginning `=`, `+`, `-` or `@` as a FORMULA, and
 * Excel's legacy DDE syntax makes that a command:
 *
 *     =cmd|'/c calc'!A0
 *
 * So an agent that can set one of its own facts can put that string in a
 * report, and the operator who exports it and opens the file executes it on
 * their workstation. That is a path from "a machine I manage" to "code on the
 * ops laptop", and it is the reason this file is not three lines of `join(',')`.
 *
 * The mitigation is to prefix a dangerous leading character with an apostrophe,
 * which spreadsheets read as "this cell is text". It changes what the cell
 * shows, and that is the correct trade: a visible apostrophe is a far better
 * outcome than a formula that runs.
 */

/**
 * Characters a spreadsheet treats as the start of a formula.
 *
 * Tab and carriage return are here because Excel strips leading whitespace
 * before deciding, so `\t=cmd|…` is a formula too.
 */
const FORMULA_STARTS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * A value that is only a number, including a signed or exponent form.
 *
 * `-5` and `+1.5e3` start with a dangerous character and are not formulas, and
 * quoting them as text would turn every negative number in an export into a
 * string nobody can sum. The guard is for `-1+1`, not for `-1`.
 */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** True when a spreadsheet would evaluate this cell rather than display it. */
export function isFormulaRisk(value: string): boolean {
  if (value === '') return false;
  if (!FORMULA_STARTS.includes(value[0] as string)) return false;
  return !PLAIN_NUMBER.test(value);
}

/**
 * One field, quoted per RFC 4180 and defused for spreadsheets.
 *
 * ALWAYS QUOTED, rather than only when it contains a comma. A field that is
 * sometimes bare and sometimes quoted is where hand-written CSV writers go
 * wrong, and the cost of quoting everything is bytes.
 */
export function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);

  const defused = isFormulaRisk(text) ? `'${text}` : text;

  // A literal quote is doubled. This is the whole of RFC 4180's escaping.
  return `"${defused.replace(/"/g, '""')}"`;
}

/** One record, CRLF-terminated as the RFC specifies. */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

/**
 * The bytes an export starts with.
 *
 * A UTF-8 BOM, because Excel on Windows assumes the local codepage otherwise
 * and renders any non-ASCII certname or fact value as mojibake. Every other
 * consumer tolerates it; Excel is the one that does not tolerate its absence.
 */
export const CSV_BOM = '﻿';
