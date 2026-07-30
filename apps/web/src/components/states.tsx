'use client';

import { AlertTriangle, Compass, Inbox, Loader2, ShieldAlert } from 'lucide-react';
import { ApiError } from '@/lib/client';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The states an ops tool must render explicitly.
 *
 * An empty table is indistinguishable from "your estate has no nodes", which is
 * the most alarming thing this console could say incorrectly. Loading, empty,
 * degraded, and forbidden are therefore distinct, named states — never a
 * spinner that resolves to nothing (ADR-0004 §6).
 */

export function LoadingRows({ rows = 8, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-2">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-ink-faint">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 p-8 text-center">
      <Inbox className="size-5 text-ink-faint" aria-hidden />
      <p className="text-sm text-ink-muted">{title}</p>
      {hint !== undefined && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * PuppetDB is unreachable.
 *
 * States plainly that classification is unaffected, because under ADR-0003 it
 * genuinely is — the ENC files on disk are untouched and agents keep
 * converging. Without that line an operator reasonably assumes the estate is
 * unmanaged, and escalates an outage that is not happening.
 */
export function PuppetDbDown({ error }: { error: unknown }) {
  const message = error instanceof ApiError ? error.message : 'PuppetDB is unreachable.';
  const lastSuccess =
    error instanceof ApiError && error.body !== null && typeof error.body === 'object'
      ? (error.body as { lastSuccessAt?: string | null }).lastSuccessAt
      : null;

  return (
    <div
      role="alert"
      className="m-3 rounded border border-state-pending/40 bg-state-pending/10 p-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-state-pending" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-state-pending">PuppetDB unreachable</p>
          <p className="mt-0.5 break-words font-mono text-[11px] text-state-pending/80">
            {message}
          </p>
          {lastSuccess !== null && lastSuccess !== undefined && (
            <p className="mt-1 text-xs text-ink-muted">
              Last successful contact: <span className="font-mono">{lastSuccess}</span>
            </p>
          )}
          <p className="mt-2 text-xs text-ink-muted">
            Inventory and run reports are unavailable. Classification is unaffected — the ENC files
            on disk are unchanged and Puppet agent runs continue against them.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Forbidden({ permission }: { permission?: string | undefined }) {
  return (
    <div role="alert" className="m-3 rounded border border-line bg-panel p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
        <div>
          <p className="text-sm font-medium text-ink">Not permitted</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Your role does not grant{permission === undefined ? ' this action' : ` ${permission}`}.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The thing in the URL is not there.
 *
 * Absence is not failure. This used to render as the red "Request failed"
 * banner, which is the same treatment a 500 gets — so an operator following a
 * bookmark to a group somebody deleted last week saw an alarm rather than an
 * explanation, with no way onward except the back button.
 *
 * Found by the QA fuzzer walking to an id that does not resolve.
 */
export function MissingResource({ what = 'That page' }: { what?: string }) {
  return (
    <div className="m-3 rounded border border-line bg-panel p-3">
      <div className="flex items-start gap-2">
        <Compass className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
        <div>
          <p className="text-sm font-medium text-ink">{what} could not be found</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            It may have been deleted or renamed since this link was made.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Routes an error to the right named state rather than a generic failure. */
export function QueryError({ error }: { error: unknown }) {
  if (error instanceof ApiError) {
    if (error.isPuppetDbUnavailable) return <PuppetDbDown error={error} />;
    if (error.isForbidden) return <Forbidden />;
    if (error.isNotFound) return <MissingResource />;
  }

  return (
    <div role="alert" className="m-3 rounded border border-state-failed/40 bg-state-failed/10 p-3">
      <p className="text-sm font-medium text-state-failed">Request failed</p>
      <p className="mt-0.5 font-mono text-[11px] text-state-failed/80">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  );
}
