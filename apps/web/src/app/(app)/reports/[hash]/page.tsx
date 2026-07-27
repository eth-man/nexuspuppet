'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { ResourceEvent } from '@nexuspuppet/contracts';
import { useReport } from '@/lib/queries';
import { absolute, duration, relativeAge, shortHash } from '@/lib/format';
import { eventState, stateStyle } from '@/lib/status';
import { cn } from '@/lib/utils';
import { Badge, StateBadge } from '@/components/ui/badge';
import { EmptyState, QueryError, Spinner } from '@/components/states';

/**
 * Run detail — the failure-triage screen.
 *
 * The product requirement is "find why a run failed in under two minutes", so
 * the failing resource, its message, and its manifest location are visible
 * without expanding anything. Events arrive severity-ordered from the API
 * (failures, then skipped) because a run with 200 successes and one failure
 * must not bury the failure.
 */
export default function ReportPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = use(params);
  const query = useReport(hash);
  const [filter, setFilter] = useState<'all' | 'problems'>('problems');

  const events = useMemo(() => {
    const all = query.data?.events ?? [];
    return filter === 'all'
      ? all
      : all.filter((event) => event.status === 'failure' || event.status === 'skipped');
  }, [query.data, filter]);

  if (query.isError) return <QueryError error={query.error} />;
  if (query.isPending) return <Spinner label="Loading report…" />;

  const { report, summary } = query.data;
  const problemCount = query.data.events.filter(
    (event) => event.status === 'failure' || event.status === 'skipped',
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line-soft px-3 py-2">
        <Link
          href={`/nodes/${encodeURIComponent(report.certname)}`}
          className="mb-1 inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="size-3" aria-hidden />
          {report.certname}
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold tracking-tight">Run report</h1>
          <StateBadge state={report.noop ? 'noop' : report.status} />
          <Badge className="font-mono" title={report.hash}>
            {shortHash(report.hash)}
          </Badge>
          {report.environment !== null && <Badge>{report.environment}</Badge>}
        </div>

        <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-0.5 text-xs">
          <Field
            label="Started"
            value={`${relativeAge(report.startTime)} ago`}
            title={absolute(report.startTime)}
          />
          <Field label="Duration" value={duration(report.durationSeconds)} />
          <Field label="Puppet" value={report.puppetVersion ?? '—'} />
          <Field label="Config version" value={report.configurationVersion ?? '—'} />
          <Field label="Catalog" value={report.cachedCatalogStatus ?? '—'} />
        </dl>
      </header>

      {summary !== null && (
        <div className="grid grid-cols-2 gap-px border-b border-line-soft bg-line-soft sm:grid-cols-5">
          <Metric label="Resources" value={summary.resourcesTotal} />
          <Metric label="Changed" value={summary.resourcesChanged} tone="changed" />
          <Metric label="Failed" value={summary.resourcesFailed} tone="failed" />
          <Metric label="Skipped" value={summary.resourcesSkipped} tone="pending" />
          <Metric label="Events" value={summary.eventsTotal} />
        </div>
      )}

      <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5">
        <h2 className="text-xs font-medium text-ink-muted">Resource events</h2>
        <div className="flex gap-1" role="group" aria-label="Filter events">
          {(
            [
              ['problems', `Problems (${problemCount})`],
              ['all', `All (${query.data.events.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                filter === key
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-line text-ink-muted hover:bg-panel-raised',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {events.length === 0 ? (
          <EmptyState
            title={filter === 'problems' ? 'No failures or skipped resources' : 'No events'}
            hint={filter === 'problems' ? 'This run applied cleanly.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {events.map((event, index) => (
              <EventRow
                key={`${event.resourceType}-${event.resourceTitle}-${index}`}
                event={event}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink-muted" title={title}>
        {value}
      </dd>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: 'changed' | 'failed' | 'pending';
}) {
  // Zero is meaningful here — "0 failed" is the answer an operator is looking
  // for — so it is shown plainly rather than dimmed away.
  const emphasise = tone !== undefined && value !== null && value > 0;

  return (
    <div className="bg-panel px-3 py-1.5">
      <p className="text-[11px] text-ink-faint">{label}</p>
      <p
        className={cn(
          'font-mono text-sm tabular-nums',
          emphasise ? stateStyle(tone).text : 'text-ink',
        )}
      >
        {value ?? '—'}
      </p>
    </div>
  );
}

function EventRow({ event }: { event: ResourceEvent }) {
  const state = eventState(event.status);
  const style = stateStyle(state);

  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', style.dot)} aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs text-ink">
              {event.resourceType}[{event.resourceTitle}]
            </span>
            {event.property !== null && (
              <span className="font-mono text-[11px] text-ink-faint">{event.property}</span>
            )}
          </div>

          {event.message !== null && (
            // Agent output is log data: monospace, wrapped, never truncated.
            // The message IS the answer to "why did this fail".
            <pre
              className={cn(
                'mt-1 whitespace-pre-wrap break-words font-mono text-[11px]',
                style.text,
              )}
            >
              {event.message}
            </pre>
          )}

          {(event.oldValue !== null || event.newValue !== null) && (
            <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
              {JSON.stringify(event.oldValue)} → {JSON.stringify(event.newValue)}
            </p>
          )}

          {event.file !== null && (
            <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
              {event.file}
              {event.line !== null && `:${event.line}`}
            </p>
          )}

          {/* The dependency chain explains WHY a resource was skipped — usually
              because something it depends on failed. */}
          {event.containmentPath.length > 0 && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint/70">
              {event.containmentPath.join(' › ')}
            </p>
          )}
        </div>

        <StateBadge state={state} className="shrink-0" />
      </div>
    </li>
  );
}
