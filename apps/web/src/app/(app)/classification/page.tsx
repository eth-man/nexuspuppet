'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw } from 'lucide-react';
import type { ClassificationWriteResult, MatchStrategy } from '@nexuspuppet/contracts';
import { useNodeGroups } from '@/lib/queries';
import { useCreateGroup, useForceReconcile } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError } from '@/components/states';
import { WriteResult } from '@/components/data/write-result';

/**
 * Node groups, in merge order.
 *
 * Listed by rank ascending because that IS the evaluation order — reading the
 * table top to bottom is reading how a node's classification is built up, with
 * later rows overriding earlier ones (ADR-0009).
 */
export default function ClassificationPage() {
  const router = useRouter();
  const { can } = useAuth();
  const groups = useNodeGroups();
  const create = useCreateGroup();
  const reconcile = useForceReconcile();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [rank, setRank] = useState('100');
  const [strategy, setStrategy] = useState<MatchStrategy>('ALL_RULES');
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<Pick<
    ClassificationWriteResult,
    'materializationQueued' | 'warnings'
  > | null>(null);
  const [reconciled, setReconciled] = useState(false);

  const writable = can('classification:write');
  const canTrigger = can('materialization:trigger');

  return (
    <div className="p-3">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Classification</h1>
          <p className="text-xs text-ink-muted">
            Node groups in merge order — higher rank is applied last and wins
          </p>
        </div>

        <div className="flex gap-2">
          {canTrigger && (
            <Button
              variant="secondary"
              size="sm"
              disabled={reconcile.isPending}
              onClick={() =>
                reconcile.mutate(undefined, {
                  onSuccess: () => {
                    setReconciled(true);
                    setError(null);
                  },
                  onError: (caught) =>
                    setError(caught instanceof ApiError ? caught.message : String(caught)),
                })
              }
              title="Recompute every node's classification and repair any drift"
            >
              <RefreshCw aria-hidden />
              {reconcile.isPending ? 'Queueing…' : 'Reconcile all'}
            </Button>
          )}

          {writable && (
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus aria-hidden />
              New group
            </Button>
          )}
        </div>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="mb-3 rounded border border-state-failed/40 bg-state-failed/10 p-2.5 text-xs"
        >
          <p className="font-medium text-state-failed">Change rejected</p>
          <p className="mt-0.5 text-state-failed/80">{error}</p>
        </div>
      )}

      {reconciled && (
        <div
          role="status"
          className="mb-3 rounded border border-state-pending/40 bg-state-pending/10 p-2.5 text-xs"
        >
          <p className="font-medium text-state-pending">Full reconcile queued</p>
          <p className="mt-0.5 text-ink-muted">
            Every node will be recomputed and any orphaned ENC files removed. Puppet applies changes
            on each node&rsquo;s next run.
          </p>
        </div>
      )}

      {written !== null && <WriteResult result={written} className="mb-3" />}

      <Card>
        <CardHeader>
          <CardTitle>Node groups</CardTitle>
          <span className="text-[11px] text-ink-faint">
            {groups.isSuccess
              ? `${groups.data.length} group${groups.data.length === 1 ? '' : 's'}`
              : ''}
          </span>
        </CardHeader>

        {groups.isError ? (
          <QueryError error={groups.error} />
        ) : groups.isPending ? (
          <LoadingRows rows={6} columns={7} />
        ) : groups.data.length === 0 ? (
          <EmptyState
            title="No node groups defined"
            hint="Every node currently receives default.yaml — a valid, empty classification."
          />
        ) : (
          <Table>
            <THead>
              <TR className="hover:bg-panel-raised">
                <TH>Rank</TH>
                <TH>Name</TH>
                <TH>Strategy</TH>
                <TH>Environment</TH>
                <TH className="text-right">Rules</TH>
                <TH className="text-right">Classes</TH>
                <TH className="text-right">Pins</TH>
              </TR>
            </THead>
            <TBody>
              {groups.data.map((group) => (
                <TR key={group.id}>
                  <TD className="font-mono text-xs tabular-nums text-ink-faint">{group.rank}</TD>
                  <TD className="text-xs">
                    <Link href={`/classification/${group.id}`} className="link-entity">
                      {group.name}
                    </Link>
                    {!group.isEnabled && (
                      <span className="ml-1.5 text-[10px] uppercase text-ink-faint">disabled</span>
                    )}
                  </TD>
                  <TD>
                    <Badge>{group.strategy}</Badge>
                  </TD>
                  <TD className="text-xs text-ink-muted">{group.environment ?? '—'}</TD>
                  <TD className="text-right font-mono text-xs tabular-nums text-ink-muted">
                    {group.ruleCount}
                  </TD>
                  <TD className="text-right font-mono text-xs tabular-nums text-ink-muted">
                    {group.classCount}
                  </TD>
                  <TD className="text-right font-mono text-xs tabular-nums text-ink-muted">
                    {group.pinCount}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New node group"
        description="A new group has no rules, so it matches nothing until you add some."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={name.trim() === '' || create.isPending}
              onClick={() =>
                create.mutate(
                  {
                    name: name.trim(),
                    rank: Number(rank),
                    strategy,
                    environment: null,
                    isEnabled: true,
                    parentId: null,
                  },
                  {
                    onSuccess: (result) => {
                      setOpen(false);
                      setName('');
                      setWritten(result);
                      // Straight into the editor: a group with no rules and no
                      // classes does nothing, so creation is never the end of
                      // the task.
                      router.push(`/classification/${result.group.id}`);
                    },
                    onError: (caught) => {
                      setOpen(false);
                      setError(caught instanceof ApiError ? caught.message : String(caught));
                    },
                  },
                )
              }
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="groupName">Name</Label>
            <Input
              id="groupName"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="redhat-hardening"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="groupRank">Rank</Label>
              <Input
                id="groupRank"
                type="number"
                value={rank}
                onChange={(event) => setRank(event.target.value)}
                className="font-mono"
              />
              <p className="text-[11px] text-ink-faint">Higher is applied later and wins.</p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="groupStrategy">Strategy</Label>
              <Select
                id="groupStrategy"
                value={strategy}
                onChange={(event) => setStrategy(event.target.value as MatchStrategy)}
                className="w-full"
              >
                <option value="ALL_RULES">ALL_RULES — every rule must match</option>
                <option value="ANY_RULE">ANY_RULE — any rule matches</option>
                <option value="PINNED">PINNED — explicit certnames</option>
              </Select>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
