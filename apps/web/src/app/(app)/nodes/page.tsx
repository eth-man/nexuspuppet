'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import type { PuppetNode } from '@nexuspuppet/contracts';
import { useEnvironments, useNodes } from '@/lib/queries';
import {
  completeFactRows,
  FactFilters,
  factRowsFrom,
  type FactRow,
  type StoredCondition,
} from '@/components/data/fact-filters';
import { SavedQueries } from '@/components/data/saved-queries';
import { absolute, isStale, relativeAge } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StateBadge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError } from '@/components/states';

/**
 * Node inventory.
 *
 * Server-driven pagination and filtering throughout — a 10,000-node estate is
 * never shipped to the browser to be sorted client-side (ADR-0008). The table
 * fills the full fluid width so an operator can see certname, status,
 * environment, and age together without horizontal scrolling on a normal
 * display.
 */

const STATUSES = ['failed', 'changed', 'unchanged', 'unknown'] as const;
const PAGE_SIZE = 50;

export default function NodesPage() {
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  // Fact filters (#243). Held as UI rows so a half-typed one does not requery
  // on every keystroke; only complete rows are sent.
  const [factRows, setFactRows] = useState<FactRow[]>([]);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' }>({
    by: 'certname',
    dir: 'asc',
  });

  const query = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset,
      orderBy: sort.by,
      order: sort.dir,
      ...(search === '' ? {} : { certnameContains: search }),
      ...(completeFactRows(factRows).length === 0 ? {} : { facts: completeFactRows(factRows) }),
      ...(statuses.length === 0 ? {} : { statuses }),
      ...(environment === null ? {} : { environments: [environment] }),
      includeInactive,
    }),
    [offset, sort, search, statuses, environment, includeInactive, factRows],
  );

  /**
   * Put a saved filter back into the controls (ADR-0026).
   *
   * The page's state is the SOURCE, and `query` is derived from it — so a
   * saved query is applied by writing the controls, not by bypassing them.
   * Setting `query` directly would show results the filter bar disagreed with,
   * which is the same class of lie as a screen that hides half a comparison.
   *
   * Pagination resets: page 4 of the previous filter is meaningless under a
   * new one.
   */
  const applySaved = (filter: unknown) => {
    const f = (filter ?? {}) as {
      certnameContains?: string;
      statuses?: string[];
      environments?: string[];
      includeInactive?: boolean;
      facts?: StoredCondition[];
    };

    setOffset(0);
    setSearch(f.certnameContains ?? '');
    setStatuses(f.statuses ?? []);
    setEnvironment(f.environments?.[0] ?? null);
    setIncludeInactive(f.includeInactive ?? false);
    setFactRows(factRowsFrom(f.facts));
  };

  const nodes = useNodes(query);
  const environments = useEnvironments();

  const toggleStatus = (status: string) => {
    setOffset(0);
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  };

  const toggleSort = (column: string) => {
    setOffset(0);
    setSort((current) =>
      current.by === column
        ? { by: column, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { by: column, dir: 'asc' },
    );
  };

  const total = nodes.data?.total ?? 0;
  const filtered =
    search !== '' ||
    statuses.length > 0 ||
    environment !== null ||
    includeInactive ||
    completeFactRows(factRows).length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-line-soft px-3 py-2">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Nodes</h1>
          <p className="text-xs text-ink-muted">
            {nodes.isSuccess
              ? `${total.toLocaleString()} node${total === 1 ? '' : 's'}${filtered ? ' matching' : ' in the estate'}`
              : 'Loading inventory…'}
          </p>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1">
        <SavedQueries
          kind="node"
          currentFilter={filtered ? { ...query, limit: undefined, offset: undefined } : null}
          canSave={filtered}
          onApply={applySaved}
        />
      </div>

      {/* Filters. Kept on one dense row so the table starts as high as possible. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
        <div className="relative min-w-56 flex-1 max-w-md">
          <Search
            className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => {
              setOffset(0);
              setSearch(event.target.value);
            }}
            placeholder="Filter by certname…"
            className="pl-7 font-mono text-xs"
            aria-label="Filter by certname"
          />
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              aria-pressed={statuses.includes(status)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-2xs transition-colors',
                statuses.includes(status)
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-line text-ink-muted hover:bg-panel-raised',
              )}
            >
              <StateBadge state={status} className="border-0 bg-transparent px-0" />
            </button>
          ))}
        </div>

        <select
          value={environment ?? ''}
          onChange={(event) => {
            setOffset(0);
            setEnvironment(event.target.value === '' ? null : event.target.value);
          }}
          aria-label="Filter by environment"
          className="h-8 rounded border border-line bg-surface px-2 text-xs text-ink"
        >
          <option value="">All environments</option>
          {(environments.data ?? []).map((env) => (
            <option key={env} value={env}>
              {env}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => {
              setOffset(0);
              setIncludeInactive(event.target.checked);
            }}
            className="size-3.5 accent-[var(--color-accent)]"
          />
          Include deactivated
        </label>

        {/* Fact filters (#243), on their own row: a path, an operator and a
            value do not fit beside the status pills, and squeezing them there
            is how a filter nobody can read gets built. */}
      </div>

      <div className="mb-2">
        <FactFilters
          rows={factRows}
          onChange={(rows) => {
            setOffset(0);
            setFactRows(rows);
          }}
        />

        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('');
              setStatuses([]);
              setEnvironment(null);
              setIncludeInactive(false);
              setOffset(0);
            }}
          >
            <X aria-hidden />
            Clear
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {nodes.isError ? (
          <QueryError error={nodes.error} />
        ) : nodes.isPending ? (
          <LoadingRows rows={12} columns={6} />
        ) : nodes.data.items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No nodes match these filters' : 'No nodes in the inventory'}
            hint={
              filtered
                ? 'Try clearing a filter.'
                : 'The projector populates this from PuppetDB every few minutes.'
            }
          />
        ) : (
          <Table>
            <THead>
              <TR className="hover:bg-panel-raised">
                <SortableTH label="Certname" column="certname" sort={sort} onSort={toggleSort} />
                <TH>Status</TH>
                <SortableTH
                  label="Environment"
                  column="report_environment"
                  sort={sort}
                  onSort={toggleSort}
                />
                <SortableTH
                  label="Last run"
                  column="report_timestamp"
                  sort={sort}
                  onSort={toggleSort}
                />
                <TH>Facts</TH>
                <TH className="text-right">Report</TH>
              </TR>
            </THead>
            <TBody>
              {nodes.data.items.map((node) => (
                <NodeRow key={node.certname} node={node} />
              ))}
            </TBody>
          </Table>
        )}
      </div>

      {nodes.isSuccess && total > PAGE_SIZE && (
        <footer className="flex items-center justify-between border-t border-line-soft px-3 py-1.5 text-xs text-ink-muted">
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
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

function SortableTH({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: string;
  sort: { by: string; dir: 'asc' | 'desc' };
  onSort: (column: string) => void;
}) {
  const active = sort.by === column;
  return (
    <TH>
      <button
        type="button"
        onClick={() => onSort(column)}
        // `uppercase` is repeated here rather than inherited from TH: the
        // button resets text-transform, which left sortable headers title-case
        // beside uppercase static ones.
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink',
          active && 'text-ink',
        )}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {active && <span aria-hidden>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </TH>
  );
}

function NodeRow({ node }: { node: PuppetNode }) {
  // A deactivated or expired node is not stale — it is decommissioned, and
  // correctly not reporting. "Stale" means "should be reporting and isn't",
  // which is an alarm; flagging a retired node as one is noise that trains
  // operators to ignore the marker where it matters.
  const stale = node.isActive && isStale(node.reportTimestamp);

  // Dim decommissioned rows so the live estate reads first — but per CELL, not
  // on the row. Opacity on the row would dim the status badge with everything
  // else, and status colour is the column this table is scanned for. The
  // badge stays at full strength.
  const dim = node.isActive ? undefined : 'opacity-45';

  return (
    <TR>
      <TD className={cn('font-mono text-xs', dim)}>
        <Link href={`/nodes/${encodeURIComponent(node.certname)}`} className="link-entity">
          {node.certname}
        </Link>
        {!node.isActive && (
          <span className="ml-1.5 text-3xs uppercase text-ink-faint">
            {node.deactivated !== null ? 'deactivated' : 'expired'}
          </span>
        )}
      </TD>
      <TD>
        <StateBadge state={node.latestReportStatus} />
      </TD>
      <TD className={cn('text-xs text-ink-muted', dim)}>{node.environment ?? '—'}</TD>
      <TD
        className={cn('text-xs tabular-nums', stale ? 'text-state-pending' : 'text-ink-muted', dim)}
        title={absolute(node.reportTimestamp)}
      >
        {relativeAge(node.reportTimestamp)}
        {stale && <span className="ml-1 text-3xs uppercase">stale</span>}
      </TD>
      <TD className={cn('text-xs text-ink-faint', dim)} title={absolute(node.factsTimestamp)}>
        {relativeAge(node.factsTimestamp)}
      </TD>
      <TD className={cn('text-right', dim)}>
        {node.latestReportHash === null ? (
          <span className="text-xs text-ink-faint">—</span>
        ) : (
          <Link
            href={`/reports/${node.latestReportHash}`}
            className="link-entity font-mono text-xs text-ink-muted"
          >
            view
          </Link>
        )}
      </TD>
    </TR>
  );
}
