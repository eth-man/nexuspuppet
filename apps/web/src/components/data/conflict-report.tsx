'use client';

import Link from 'next/link';
import type { AggregatedConflict } from '@nexuspuppet/contracts';
import { ArrowRight } from 'lucide-react';
import { useConflictReport } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

/**
 * Where one group is overriding another, across the whole estate (ADR-0009).
 *
 * The node page answers "why is this machine configured this way". This answers
 * the question people actually arrive with — "is something overriding my base
 * group, and how much does it touch" — which previously required opening nodes
 * one at a time.
 *
 * NOT AN ERROR LIST. Base-plus-override is the normal way to use group
 * hierarchies, and ADR-0009 is explicit that conflicts are warnings. A table
 * that shouts would train people to close it; this one is quiet except where
 * something is genuinely surprising.
 */
export function ConflictReport() {
  const report = useConflictReport();

  if (report.isPending || report.data === undefined) return null;
  if (report.isError) return null;

  const { conflicts, nodesAffected, nodesMaterialized } = report.data;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Overrides in effect</CardTitle>
        <span className="text-[11px] text-ink-faint">
          {nodesAffected === 0
            ? `no overrides across ${nodesMaterialized} node${nodesMaterialized === 1 ? '' : 's'}`
            : `${nodesAffected} of ${nodesMaterialized} node${nodesMaterialized === 1 ? '' : 's'}`}
        </span>
      </CardHeader>

      {conflicts.length === 0 ? (
        <div className="p-3">
          <p className="text-xs text-ink-faint">
            No group is overriding another anywhere in the estate. This is not necessarily better
            than the alternative — overriding a base group is a normal pattern — it just is not
            happening yet.
          </p>
        </div>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Setting</TH>
                <TH>Winner</TH>
                <TH>Overrides</TH>
                <TH className="text-right">Nodes</TH>
              </TR>
            </THead>
            <TBody>
              {conflicts.map((conflict) => (
                <Row key={rowKey(conflict)} conflict={conflict} />
              ))}
            </TBody>
          </Table>

          <p className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
            Higher-ranked groups win, and the losing value is discarded — there is no deep merge
            (ADR-0009). Read this as a list of decisions, not failures.
          </p>
        </>
      )}
    </Card>
  );
}

function Row({ conflict }: { conflict: AggregatedConflict }) {
  // Environment decides which branch of the control repository a machine runs,
  // so a disagreement about it is a different kind of problem from a parameter
  // being overridden — and it is the one that would otherwise sink to the
  // bottom of a table sorted by breadth.
  const isEnvironment = conflict.kind === 'ENVIRONMENT';

  return (
    <TR className={cn(isEnvironment && 'bg-state-pending/5')}>
      <TD>
        <span className="font-mono text-[11px] text-ink">{conflict.key}</span>
        {isEnvironment && (
          <Badge className="ml-2 border-state-pending/40 text-state-pending">environment</Badge>
        )}
      </TD>
      <TD>
        <Link
          href={`/classification/${conflict.winningGroupId}`}
          className="text-ink hover:underline"
        >
          {conflict.winningGroupName}
        </Link>
      </TD>
      <TD>
        <span className="flex items-center gap-1 text-ink-muted">
          <ArrowRight size={11} aria-hidden />
          <Link href={`/classification/${conflict.losingGroupId}`} className="hover:underline">
            {conflict.losingGroupName}
          </Link>
        </span>
      </TD>
      <TD className="text-right">
        <span className="font-mono tabular-nums text-ink">{conflict.nodeCount}</span>
        {conflict.exampleCertnames.length > 0 && (
          <div className="mt-0.5 text-[10px] text-ink-faint">
            {conflict.exampleCertnames.slice(0, 2).map((certname, index) => (
              <span key={certname}>
                {index > 0 && ', '}
                <Link href={`/nodes/${encodeURIComponent(certname)}`} className="hover:underline">
                  {certname}
                </Link>
              </span>
            ))}
            {conflict.nodeCount > 2 && ' …'}
          </div>
        )}
      </TD>
    </TR>
  );
}

/** Same identity the aggregation groups by, so keys are stable across refetches. */
function rowKey(conflict: AggregatedConflict): string {
  return [conflict.kind, conflict.key, conflict.winningGroupId, conflict.losingGroupId].join(' ');
}
