/**
 * A line-level diff between two multi-line parameter values (ADR-0025 §9).
 *
 * PURE: no I/O, no clock, no randomness.
 *
 * WHY THIS EXISTS. Showing two `content` values side by side satisfies the
 * letter of "compare the variants" and defeats its purpose: a real
 * `sshd_config` is a hundred near-identical lines, and two columns of them is
 * exactly the "two blobs to diff by eye" §9 says not to hand anybody. A mode
 * of `0600` against `0666` reads fine side by side. A file body does not.
 *
 * So values that span lines get a line diff, and the operator reads the two
 * lines that changed rather than two hundred that did not.
 */

export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Above this many lines on either side, the quadratic table is not worth
 * building and the answer stops being readable anyway.
 *
 * A managed file CAN be enormous — a generated allow-list, a bundled cert
 * chain. Refusing to diff those is honest; grinding through an O(n·m) table to
 * produce a thousand-line result nobody will read is not.
 */
export const MAX_DIFF_LINES = 400;

/** Whether a value is worth line-diffing at all. */
export function isMultiline(value: unknown): value is string {
  return typeof value === 'string' && value.includes('\n');
}

/**
 * Longest common subsequence over LINES, then walked back into a diff.
 *
 * Lines, not characters: a config file changes by lines, and a character diff
 * of two hundred lines produces noise where the useful signal is "this line
 * became that line".
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');

  // Too big to be useful. Null rather than a partial answer — a truncated diff
  // presented as a whole one is worse than admitting the file is too large.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lengths[i] as number[];
      const next = lengths[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i] as string });
      i += 1;
      j += 1;
      continue;
    }

    const next = lengths[i + 1] as number[];
    const row = lengths[i] as number[];
    // Prefer removals first, so a changed line reads as "- old" then "+ new"
    // rather than the reverse, which is how every diff anybody has read works.
    if ((next[j] as number) >= (row[j + 1] as number)) {
      result.push({ kind: 'removed', text: a[i] as string });
      i += 1;
    } else {
      result.push({ kind: 'added', text: b[j] as string });
      j += 1;
    }
  }

  while (i < a.length) {
    result.push({ kind: 'removed', text: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    result.push({ kind: 'added', text: b[j] as string });
    j += 1;
  }

  return result;
}

/**
 * Drop the unchanged bulk, keeping a little context around each change.
 *
 * A hundred identical lines around the one that changed is the same problem
 * the side-by-side view had. Context is kept because a bare changed line
 * without its surroundings is often unreadable — you cannot tell which stanza
 * of a config file it belongs to.
 */
export function collapseUnchanged(lines: readonly DiffLine[], context = 2): DiffLine[] {
  const keep = new Set<number>();

  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  // Nothing changed: there is nothing to collapse TO, and returning an empty
  // list would render as "no difference" under a heading that says there is
  // one. Show the value as it is.
  if (keep.size === 0) return [...lines];

  return lines.filter((_, index) => keep.has(index));
}
