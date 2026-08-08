'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNodes } from '@/lib/queries';
import { absolute, ago, isStale, shortHash } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { StateBadge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError } from '@/components/states';

/**
 * Latest run per node, newest first.
 *
 * NOTE ON SCOPE: PuppetDB's reports endpoint is queried per certname, and the
 * API exposes it that way, so there is no estate-wide historical run feed
 * without a new endpoint. What an operator actually wants here is "what ran
 * recently and what broke", which the node inventory already carries —
 * every node reports its latest run status and report hash.
 *
 * So this is the estate's most recent runs, one row per node, linking straight
 * to the report. Per-node history lives on the node page. If a true global
 * timeline is wanted later, it needs an API addition rather than a UI one.
 */

const STATUSES = ['failed', 'changed', 'unchanged'] as const;
const PAGE_SIZE = 50;

export default function ReportsPage() {
  // Failures first: this page exists for triage.
  const [statuses, setStatuses] = useState<string[]>(['failed']);
  const [offset, setOffset] = useState(0);

  const runs = useNodes({
    limit: PAGE_SIZE,
    offset,
    orderBy: 'report_timestamp',
    order: 'desc',
    ...(statuses.length === 0 ? {} : { statuses }),
  });

  const toggle = (status: string) => {
    setOffset(0);
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  };

  const total = runs.data?.total ?? 0;
  const shown = runs.data?.items.length ?? 0;
  /** A filter narrow enough that the count describes a subset, not the estate. */
  const filtered = statuses.length > 0 && statuses.length < STATUSES.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line-soft px-3 py-2">
        <h1 className="text-sm font-semibold tracking-tight">Reports</h1>
        {/*
          Say that a filter is on, in the same breath as the count.

          This page opens filtered to `failed`, so on a 48-node estate it read
          "showing 1–9 of 9" — a true statement about the filtered set that an
          operator reads as a statement about the estate. The `1 of 3 states`
          chip beside the filters was the only clue, and it is nowhere near the
          number it qualifies.
        */}
        <p className="text-xs text-ink-muted">
          Most recent run per node
          {runs.isSuccess && (
            <>
              {` — showing ${shown === 0 ? 0 : offset + 1}–${offset + shown} of ${total.toLocaleString()}`}
              {filtered ? ` ${statuses.join(' / ')}` : ''}
            </>
          )}
        </p>
      </header>

      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => toggle(status)}
              aria-pressed={statuses.includes(status)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                statuses.includes(status)
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-line text-ink-muted hover:bg-panel-raised',
              )}
            >
              <StateBadge state={status} className="border-0 bg-transparent px-0" />
            </button>
          ))}
        </div>
        <span className="text-[11px] text-ink-faint">
          {statuses.length === 0 || statuses.length === STATUSES.length
            ? 'all states'
            : `${statuses.length} of ${STATUSES.length} states`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {runs.isError ? (
          <QueryError error={runs.error} />
        ) : runs.isPending ? (
          <LoadingRows rows={12} columns={5} />
        ) : runs.data.items.length === 0 ? (
          <EmptyState
            title="No runs match these filters"
            hint={statuses.includes('failed') ? 'Nothing is failing right now.' : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TR className="hover:bg-panel-raised">
                <TH>Node</TH>
                <TH>Status</TH>
                <TH>Environment</TH>
                <TH>Ran</TH>
                <TH className="text-right">Report</TH>
              </TR>
            </THead>
            <TBody>
              {runs.data.items.map((node) => (
                <TR key={node.certname}>
                  <TD className="font-mono text-xs">
                    <Link
                      href={`/nodes/${encodeURIComponent(node.certname)}`}
                      className="link-entity"
                    >
                      {node.certname}
                    </Link>
                  </TD>
                  <TD>
                    <StateBadge state={node.latestReportStatus} />
                  </TD>
                  <TD className="text-xs text-ink-muted">{node.environment ?? '—'}</TD>
                  <TD
                    className={cn(
                      'text-xs tabular-nums',
                      node.isActive && isStale(node.reportTimestamp)
                        ? 'text-state-pending'
                        : 'text-ink-muted',
                    )}
                    title={absolute(node.reportTimestamp)}
                  >
                    {ago(node.reportTimestamp)}
                  </TD>
                  <TD className="text-right">
                    {node.latestReportHash === null ? (
                      <span className="text-xs text-ink-faint">—</span>
                    ) : (
                      <Link
                        href={`/reports/${node.latestReportHash}`}
                        className="link-entity font-mono text-xs text-ink-muted"
                        title={node.latestReportHash}
                      >
                        {shortHash(node.latestReportHash)}
                      </Link>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      {runs.isSuccess && total > PAGE_SIZE && (
        <footer className="flex items-center justify-between border-t border-line-soft px-3 py-1.5 text-xs text-ink-muted">
          <span>
            {offset + 1}–{offset + shown} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}
