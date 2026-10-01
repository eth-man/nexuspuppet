/**
 * The shape of one line in the API's local log history (ADR-0028), and the
 * naming of the files it lives in.
 *
 * PURE. The writer and the support-bundle reader both depend on these, so the
 * format each side assumes is stated exactly once.
 */

/** One JSON object per line. `ts` FIRST, always — the reader relies on it. */
export interface LogRecord {
  /** ISO-8601, UTC, millisecond precision: `Date.prototype.toISOString`. */
  ts: string;
  level: string;
  context: string;
  message: string;
  pid: number;
  host: string;
  /** Present only when Nest logged an error with a stack. */
  stack?: string;
}

// ESC [ ... final-byte, plus the OSC form. Enough for what Nest and chalk emit.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/**
 * Nest colours its stdout. A file read months later by somebody in another
 * tool must not carry escape sequences, and a redaction pass must not be
 * defeated by a colour code landing in the middle of a secret.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Serialise one record. Key order is fixed so `ts` is always the first field,
 * which lets the reader take the timestamp without parsing the whole line.
 */
export function formatRecord(record: LogRecord): string {
  const ordered: LogRecord = {
    ts: record.ts,
    level: record.level,
    context: stripAnsi(record.context),
    message: stripAnsi(record.message),
    pid: record.pid,
    host: record.host,
    ...(record.stack === undefined ? {} : { stack: stripAnsi(record.stack) }),
  };
  return JSON.stringify(ordered);
}

const TS_PREFIX = '{"ts":"';
const ISO_LENGTH = 24; // 2026-09-30T12:00:00.000Z
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The timestamp of a line, or null if it is not one of ours.
 *
 * The fast path reads the fixed prefix `formatRecord` guarantees; anything
 * else is parsed properly. A torn final line — the process killed mid-write —
 * is simply not a record, and is counted by the caller rather than guessed at.
 */
export function lineTimestamp(line: string): string | null {
  if (line.startsWith(TS_PREFIX)) {
    const candidate = line.slice(TS_PREFIX.length, TS_PREFIX.length + ISO_LENGTH);
    if (ISO.test(candidate) && line.endsWith('}')) return candidate;
  }

  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'ts' in parsed) {
      const ts = (parsed as { ts: unknown }).ts;
      if (typeof ts === 'string' && ISO.test(ts)) return ts;
    }
  } catch {
    // Not JSON: not a record.
  }
  return null;
}

/**
 * A hostname made safe for a filename and a tar header.
 *
 * Container hostnames are 12 hex characters; this exists for the host that is
 * not a container, and for anything unexpected found in a shared directory.
 */
export function safeHost(host: string): string {
  const cleaned = host.replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 64);
  return cleaned === '' ? 'unknown' : cleaned;
}

export function logFileName(host: string): string {
  return `api-${safeHost(host)}.log`;
}

/** `api-<host>.log` is generation 0; `api-<host>.log.3` is generation 3. */
export function parseLogFileName(name: string): { host: string; generation: number } | null {
  const match = /^api-([A-Za-z0-9._-]+?)\.log(?:\.(\d{1,3}))?$/.exec(name);
  if (match === null) return null;
  const host = match[1];
  if (host === undefined) return null;
  return { host, generation: match[2] === undefined ? 0 : Number(match[2]) };
}
