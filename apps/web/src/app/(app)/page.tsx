'use client';

import Link from 'next/link';
import { useNodeCount, useNodes } from '@/lib/queries';
import { absolute, isStale, relativeAge } from '@/lib/format';
import { stateStyle, type DisplayState } from '@/lib/status';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { StateBadge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError } from '@/components/states';
import { SystemStatusCard } from '@/components/data/system-status-card';
import { OpenConditionsPanel } from '@/components/data/open-conditions-panel';
import { PropagationFront } from '@/components/data/propagation-front';

/**
 * Estate overview.
 *
 * Answers one question on load: is anything wrong right now. Failures lead,
 * because that is what an operator opens this for; totals are context, not the
 * headline.
 */
export default function DashboardPage() {
  const total = useNodeCount(undefined, 'all');
  const failed = useNodeCount(['failed'], 'failed');
  const changed = useNodeCount(['changed'], 'changed');
  const unchanged = useNodeCount(['unchanged'], 'unchanged');

  // Failures first — the triage list.
  const failing = useNodes({
    limit: 15,
    offset: 0,
    statuses: ['failed'],
    orderBy: 'certname',
    order: 'asc',
  });

  return (
    <div className="p-3">
      <header className="mb-3">
        <h1 className="text-sm font-semibold tracking-tight">Dashboard</h1>
        <p className="text-xs text-ink-muted">Estate health at a glance</p>
      </header>

      {/*
        Above the status card, deliberately. The status card says how things
        are; this says what is WRONG, and something wrong should not sit below
        a screen of numbers that are fine.
      */}
      <div className="mb-3">
        <OpenConditionsPanel />
      </div>

      <div className="mb-3">
        <SystemStatusCard />
      </div>

      {/*
        Below the status card and above the estate totals. It answers a question
        an operator asks WHILE watching something happen — "has my change
        landed" — which sits between "is anything wrong" and "what does the
        estate look like".
      */}
      <div className="mb-3">
        <PropagationFront />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile label="Nodes" value={total.data} href="/nodes" />
        <Tile label="Failed" value={failed.data} tone="failed" href="/nodes?status=failed" />
        <Tile label="Changed" value={changed.data} tone="changed" />
        <Tile label="Unchanged" value={unchanged.data} tone="unchanged" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Failing nodes</CardTitle>
          <Link href="/nodes" className="text-[11px] text-ink-muted hover:text-accent">
            All nodes →
          </Link>
        </CardHeader>

        {failing.isError ? (
          <QueryError error={failing.error} />
        ) : failing.isPending ? (
          <LoadingRows rows={5} columns={4} />
        ) : failing.data.items.length === 0 ? (
          <EmptyState
            title="No failing nodes"
            hint="Every node applied its last catalog cleanly."
          />
        ) : (
          <Table>
            <THead>
              <TR className="hover:bg-panel-raised">
                <TH>Certname</TH>
                <TH>Status</TH>
                <TH>Environment</TH>
                <TH>Last run</TH>
                <TH className="text-right">Report</TH>
              </TR>
            </THead>
            <TBody>
              {failing.data.items.map((node) => (
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
                    {relativeAge(node.reportTimestamp)}
                  </TD>
                  <TD className="text-right">
                    {node.latestReportHash === null ? (
                      <span className="text-xs text-ink-faint">—</span>
                    ) : (
                      <Link
                        href={`/reports/${node.latestReportHash}`}
                        className="link-entity text-xs text-ink-muted"
                      >
                        view
                      </Link>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number | undefined;
  tone?: DisplayState;
  href?: string;
}) {
  const emphasise = tone !== undefined && value !== undefined && value > 0;

  const body = (
    <Card className={cn('px-3 py-2', href !== undefined && 'transition-colors hover:border-line')}>
      <p className="text-[11px] text-ink-faint">{label}</p>
      <p
        className={cn(
          'font-mono text-lg tabular-nums leading-tight',
          emphasise ? stateStyle(tone).text : 'text-ink',
        )}
      >
        {value === undefined ? '—' : value.toLocaleString()}
      </p>
    </Card>
  );

  return href === undefined ? body : <Link href={href}>{body}</Link>;
}
