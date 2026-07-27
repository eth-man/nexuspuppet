/** Presentation helpers. Deliberately explicit about missing data. */

/**
 * Relative age, e.g. "4m", "2h", "3d".
 *
 * Ops readers scan for "is this stale?", which an absolute timestamp answers
 * only after mental arithmetic. The absolute value goes in a `title` so it is
 * one hover away.
 */
export function relativeAge(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function absolute(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return 'never';
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed)
    ? 'unknown'
    : new Date(parsed).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** Run duration. Sub-second runs are common and "0s" reads as broken. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** A node is stale if it has not reported in over 2 agent intervals (~1h). */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export function isStale(reportTimestamp: string | null): boolean {
  if (reportTimestamp === null) return true;
  const parsed = Date.parse(reportTimestamp);
  return Number.isNaN(parsed) || Date.now() - parsed > STALE_AFTER_MS;
}

/** Short hash for display; the full value belongs in a title or the URL. */
export function shortHash(hash: string | null | undefined): string {
  return hash === null || hash === undefined ? '—' : hash.slice(0, 12);
}
