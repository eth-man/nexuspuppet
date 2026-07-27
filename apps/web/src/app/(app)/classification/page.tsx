'use client';

import { useNodeGroups } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError } from '@/components/states';

/**
 * Node groups, read-only.
 *
 * The editing UI is deliberately not here yet. Classification writes reconfigure
 * real machines, so that screen needs the pending/materialization feedback loop
 * built properly rather than bolted onto a list.
 */
export default function ClassificationPage() {
  const groups = useNodeGroups();

  return (
    <div className="p-3">
      <header className="mb-3">
        <h1 className="text-sm font-semibold tracking-tight">Classification</h1>
        <p className="text-xs text-ink-muted">
          Node groups in merge order — higher rank is applied last and wins
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Node groups</CardTitle>
          <span className="text-[11px] text-ink-faint">read-only — editing arrives next</span>
        </CardHeader>

        {groups.isError ? (
          <QueryError error={groups.error} />
        ) : groups.isPending ? (
          <LoadingRows rows={6} columns={5} />
        ) : groups.data.length === 0 ? (
          <EmptyState
            title="No node groups defined"
            hint="Every node currently receives default.yaml."
          />
        ) : (
          <Table>
            <THead>
              <TR className="hover:bg-panel-raised">
                <TH>Rank</TH>
                <TH>Name</TH>
                <TH>Strategy</TH>
                <TH>Environment</TH>
                <TH>Rules</TH>
                <TH>Classes</TH>
                <TH>Pins</TH>
              </TR>
            </THead>
            <TBody>
              {groups.data.map((group) => (
                <TR key={group.id}>
                  <TD className="font-mono text-xs tabular-nums text-ink-faint">{group.rank}</TD>
                  <TD className="text-xs">
                    {group.name}
                    {!group.isEnabled && (
                      <span className="ml-1.5 text-[10px] uppercase text-ink-faint">disabled</span>
                    )}
                  </TD>
                  <TD>
                    <Badge>{group.strategy}</Badge>
                  </TD>
                  <TD className="text-xs text-ink-muted">{group.environment ?? '—'}</TD>
                  <TD className="font-mono text-xs tabular-nums text-ink-muted">
                    {group.ruleCount}
                  </TD>
                  <TD className="font-mono text-xs tabular-nums text-ink-muted">
                    {group.classCount}
                  </TD>
                  <TD className="font-mono text-xs tabular-nums text-ink-muted">
                    {group.pinCount}
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
