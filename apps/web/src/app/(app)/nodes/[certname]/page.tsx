'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clock, Layers } from 'lucide-react';
import { useNode, useNodeClassification, useNodeFacts, useNodeReports } from '@/lib/queries';
import { absolute, ago, duration, relativeAge, shortHash } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, StateBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError, Spinner } from '@/components/states';
import { JsonView } from '@/components/data/json-view';
import { AttributionCard } from '@/components/data/attribution-card';

type Tab = 'facts' | 'classification' | 'runs';

/**
 * Node detail.
 *
 * Three questions, three tabs: what is this machine, why is it configured this
 * way, and what happened on its last runs. Facts and classification come from
 * different systems with different failure modes, so each tab degrades on its
 * own — a PuppetDB outage empties Facts while Classification keeps working.
 */
export default function NodeDetailPage({ params }: { params: Promise<{ certname: string }> }) {
  const { certname: raw } = use(params);
  const certname = decodeURIComponent(raw);
  const [tab, setTab] = useState<Tab>('classification');

  const node = useNode(certname);
  const classification = useNodeClassification(certname);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line-soft px-3 py-2">
        <Link
          href="/nodes"
          className="mb-1 inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="size-3" aria-hidden />
          Nodes
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-sm font-semibold tracking-tight">{certname}</h1>
          {node.isSuccess && <StateBadge state={node.data.latestReportStatus} />}
          {node.isSuccess && node.data.environment !== null && (
            <Badge>{node.data.environment}</Badge>
          )}
          {classification.data?.pending === true && (
            <Badge className="border-state-pending/40 bg-state-pending/10 text-state-pending">
              <Clock className="size-3" aria-hidden />
              Materialization pending
            </Badge>
          )}
        </div>

        {node.isSuccess && (
          <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-0.5 text-xs">
            <Field
              label="Last run"
              value={relativeAge(node.data.reportTimestamp)}
              title={absolute(node.data.reportTimestamp)}
            />
            <Field
              label="Facts"
              value={relativeAge(node.data.factsTimestamp)}
              title={absolute(node.data.factsTimestamp)}
            />
            <Field
              label="Catalog"
              value={relativeAge(node.data.catalogTimestamp)}
              title={absolute(node.data.catalogTimestamp)}
            />
            {!node.data.isActive && (
              <Field
                label={node.data.deactivated !== null ? 'Deactivated' : 'Expired'}
                value={absolute(node.data.deactivated ?? node.data.expired)}
              />
            )}
          </dl>
        )}
      </header>

      <nav className="flex gap-0.5 border-b border-line-soft px-2" aria-label="Node sections">
        {(
          [
            ['classification', 'Classification'],
            ['facts', 'Facts'],
            ['runs', 'Run history'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? 'page' : undefined}
            className={cn(
              'border-b-2 px-2.5 py-1.5 text-xs transition-colors',
              tab === key
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'classification' && <ClassificationTab certname={certname} />}
        {tab === 'facts' && <FactsTab certname={certname} />}
        {tab === 'runs' && <RunsTab certname={certname} />}
      </div>
    </div>
  );
}

function Field({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular-nums text-ink-muted" title={title}>
        {value}
      </dd>
    </div>
  );
}

/**
 * "Why is this node getting this class?" — the primary product requirement,
 * answered on one screen.
 *
 * Groups are listed in MERGE order, because the sequence is the explanation:
 * later groups override earlier ones (ADR-0009).
 */
function ClassificationTab({ certname }: { certname: string }) {
  const query = useNodeClassification(certname);

  if (query.isError) return <QueryError error={query.error} />;
  if (query.isPending) return <Spinner label="Loading classification…" />;

  const { appliedGroups, conflicts, materialization, factsAsOf, pending, attribution } = query.data;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Applied groups</CardTitle>
          <span className="text-[11px] text-ink-faint">merge order — last wins</span>
        </CardHeader>
        {appliedGroups.length === 0 ? (
          <EmptyState
            title="No groups match this node"
            hint="It receives default.yaml, which is a valid empty classification."
          />
        ) : (
          <ol className="divide-y divide-line-soft">
            {appliedGroups.map((group, index) => (
              <li key={group.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-4 text-right font-mono text-[11px] text-ink-faint">
                  {index + 1}
                </span>
                <Layers className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm">{group.name}</span>
                <Badge>rank {group.rank}</Badge>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="space-y-3">
        <Card>
          <CardHeader>
            <CardTitle>Materialization</CardTitle>
            {pending && (
              <span className="text-[11px] text-state-pending">queued — disk not yet updated</span>
            )}
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {materialization === null ? (
              <p className="text-ink-muted">
                Never materialized. This node receives{' '}
                <code className="font-mono">default.yaml</code>.
              </p>
            ) : (
              <dl className="grid grid-cols-[7rem_1fr] gap-y-1">
                <dt className="text-ink-faint">File</dt>
                <dd className="font-mono text-ink">{materialization.relativePath}</dd>
                <dt className="text-ink-faint">Revision</dt>
                <dd className="font-mono tabular-nums text-ink">{materialization.revision}</dd>
                <dt className="text-ink-faint">Content hash</dt>
                <dd className="font-mono text-ink" title={materialization.contentHash}>
                  {shortHash(materialization.contentHash)}
                </dd>
                <dt className="text-ink-faint">Written</dt>
                <dd className="text-ink" title={absolute(materialization.writtenAt)}>
                  {ago(materialization.writtenAt)}
                </dd>
                <dt className="text-ink-faint">Facts as of</dt>
                <dd className="text-ink" title={absolute(factsAsOf)}>
                  {ago(factsAsOf)}
                </dd>
              </dl>
            )}
          </CardContent>
        </Card>

        <AttributionCard attribution={attribution} groups={appliedGroups} />

        {conflicts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Conflicts</CardTitle>
              <span className="text-[11px] text-ink-faint">{conflicts.length} overridden</span>
            </CardHeader>
            {/* Warnings, not errors: base-plus-override is a legitimate and
                common pattern. Hiding them would be worse (ADR-0009). */}
            <ul className="divide-y divide-line-soft">
              {conflicts.map((conflict, index) => (
                <li key={`${conflict.key}-${index}`} className="px-3 py-1.5 text-xs">
                  <p className="font-mono text-ink">{conflict.key}</p>
                  <p className="mt-0.5 text-ink-muted">
                    <span className="text-state-unchanged">{conflict.winningGroupName}</span> set{' '}
                    <code className="font-mono">{JSON.stringify(conflict.winningValue)}</code>,
                    overriding <span className="text-ink-faint">{conflict.losingGroupName}</span>{' '}
                    <code className="font-mono">{JSON.stringify(conflict.losingValue)}</code>
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function FactsTab({ certname }: { certname: string }) {
  const query = useNodeFacts(certname);

  if (query.isError) return <QueryError error={query.error} />;
  if (query.isPending) return <Spinner label="Loading facts from PuppetDB…" />;

  const count = Object.keys(query.data).length;
  if (count === 0) {
    return <EmptyState title="No facts reported" hint="This node may not have checked in yet." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <CardTitle>Facts</CardTitle>
          <span className="text-[11px] text-ink-faint">
            full set from PuppetDB, not the projected subset
          </span>
        </CardHeader>
        <JsonView data={query.data} className="min-h-0 flex-1" />
      </Card>
    </div>
  );
}

function RunsTab({ certname }: { certname: string }) {
  const query = useNodeReports(certname);

  if (query.isError) return <QueryError error={query.error} />;
  if (query.isPending) return <LoadingRows rows={8} columns={5} />;
  if (query.data.items.length === 0) {
    return <EmptyState title="No runs recorded" hint="PuppetDB has no reports for this node." />;
  }

  return (
    <Table>
      <THead>
        <TR className="hover:bg-panel-raised">
          <TH>Status</TH>
          <TH>Started</TH>
          <TH>Duration</TH>
          <TH>Environment</TH>
          <TH>Config version</TH>
          <TH className="text-right">Report</TH>
        </TR>
      </THead>
      <TBody>
        {query.data.items.map((report) => (
          <TR key={report.hash}>
            <TD>
              <StateBadge state={report.noop ? 'noop' : report.status} />
            </TD>
            <TD className="text-xs tabular-nums text-ink-muted" title={absolute(report.startTime)}>
              {ago(report.startTime)}
            </TD>
            <TD className="text-xs tabular-nums text-ink-muted">
              {duration(report.durationSeconds)}
            </TD>
            <TD className="text-xs text-ink-muted">{report.environment ?? '—'}</TD>
            <TD className="font-mono text-xs text-ink-faint">
              {report.configurationVersion ?? '—'}
            </TD>
            <TD className="text-right">
              <Link
                href={`/reports/${report.hash}`}
                className="link-entity font-mono text-xs text-ink-muted"
                title={report.hash}
              >
                {shortHash(report.hash)}
              </Link>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
