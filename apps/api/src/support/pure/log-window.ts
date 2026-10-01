import { lineTimestamp } from '../../logging/pure/log-record';

/**
 * Choosing which log lines go into a support bundle (ADR-0028 §3).
 *
 * PURE. The collector reads files; this decides what to keep, and reports
 * enough about the decision that a reader can tell a quiet day from a missing
 * one.
 */

export interface TimedLine {
  ts: string;
  text: string;
}

/** What one file contributed. Lines are in file order, which is time order. */
export interface WindowSelection {
  lines: TimedLine[];
  /** Earliest and latest record anywhere in the file, in or out of window. */
  earliestOnDisk: string | null;
  latestOnDisk: string | null;
  /** Lines that were not records — normally at most one torn final line. */
  unparseable: number;
}

/**
 * Lines of one file whose timestamp falls in [from, to].
 *
 * ISO-8601 UTC strings of fixed width compare correctly as strings, so no
 * Date is constructed per line — this runs over up to a few hundred MiB.
 */
export function selectWindow(content: string, from: string, to: string): WindowSelection {
  const lines: TimedLine[] = [];
  let earliestOnDisk: string | null = null;
  let latestOnDisk: string | null = null;
  let unparseable = 0;

  for (const text of content.split('\n')) {
    if (text === '') continue;
    const ts = lineTimestamp(text);
    if (ts === null) {
      unparseable++;
      continue;
    }
    if (earliestOnDisk === null || ts < earliestOnDisk) earliestOnDisk = ts;
    if (latestOnDisk === null || ts > latestOnDisk) latestOnDisk = ts;
    if (ts >= from && ts <= to) lines.push({ ts, text });
  }

  return { lines, earliestOnDisk, latestOnDisk, unparseable };
}

export interface HostLog {
  host: string;
  /** Oldest first, concatenated across rotations. */
  lines: TimedLine[];
  files: Array<{ name: string; bytes: number }>;
  earliestOnDisk: string | null;
  latestOnDisk: string | null;
  unparseable: number;
}

/**
 * Enforce the byte cap across every replica, dropping the OLDEST lines first.
 *
 * Oldest, because the lines nearest the export are the ones describing the
 * problem somebody is exporting for. Across replicas, because a cap applied per
 * host would keep a quiet replica's week-old chatter while cutting a busy
 * one's last hour.
 *
 * Returns where the kept history begins, so the manifest can say so rather
 * than leaving a reader to infer it from the first line.
 */
export function capOldestFirst(
  hosts: readonly HostLog[],
  capBytes: number,
): { hosts: HostLog[]; droppedLines: number; droppedBytes: number; keptFrom: string | null } {
  const all: Array<{ host: number; index: number; ts: string; bytes: number }> = [];
  let total = 0;
  hosts.forEach((host, hostIndex) => {
    host.lines.forEach((line, index) => {
      const bytes = Buffer.byteLength(line.text, 'utf8') + 1;
      all.push({ host: hostIndex, index, ts: line.ts, bytes });
      total += bytes;
    });
  });

  if (total <= capBytes) {
    return { hosts: [...hosts], droppedLines: 0, droppedBytes: 0, keptFrom: null };
  }

  // Newest first. Ties are broken by position so the result never depends on
  // sort stability: later in a file is newer, and hosts are taken in order.
  all.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    if (a.host !== b.host) return a.host - b.host;
    return b.index - a.index;
  });

  // Keep until the first line that does not fit, then stop. Skipping it and
  // admitting smaller, OLDER lines would leave a hole in the middle of the
  // history — worse than a clean starting point.
  const keep = hosts.map(() => new Set<number>());
  let kept = 0;
  let keptLines = 0;
  let keptFrom: string | null = null;
  for (const line of all) {
    if (kept + line.bytes > capBytes) break;
    kept += line.bytes;
    keptLines++;
    keep[line.host]?.add(line.index);
    keptFrom = line.ts;
  }

  return {
    hosts: hosts.map((host, hostIndex) => ({
      ...host,
      lines: host.lines.filter((_line, index) => keep[hostIndex]?.has(index) === true),
    })),
    droppedLines: all.length - keptLines,
    droppedBytes: total - kept,
    keptFrom,
  };
}
