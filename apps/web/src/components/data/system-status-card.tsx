'use client';

import type { SystemStatus } from '@nexuspuppet/contracts';
import { useSystemStatus } from '@/lib/queries';
import { relativeAge } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Whether the deployment is keeping up with the estate.
 *
 * DELIBERATELY WITHOUT A HEALTHY/UNHEALTHY VERDICT. A large queue during a full
 * reconcile is normal, and a badge that goes red for it teaches people to ignore
 * the badge. Only one condition here is unambiguously bad, and it gets the only
 * red treatment on the card.
 *
 * That condition is a permanently failed materialization. Such a job is retained
 * with status FAILED and nothing ever retries or clears it, so the node keeps
 * its previous classification indefinitely — a silent, permanent
 * misconfiguration whose only other trace is one log line from whenever it
 * happened.
 */
export function SystemStatusCard() {
  const status = useSystemStatus();

  if (status.isPending || status.data === undefined) return null;
  // A status card that renders its own failure would be noise on a dashboard
  // whose other panels already report the outage.
  if (status.isError) return null;

  const data = status.data;
  const stranded = data.materialization.failed;

  return (
    <Card className={cn(stranded > 0 && 'border-state-failed/40')}>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>System</CardTitle>
        {stranded > 0 && (
          <span className="text-[11px] font-medium text-state-failed">
            {stranded} node{stranded === 1 ? '' : 's'} stranded
          </span>
        )}
      </CardHeader>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-3 pt-0 text-xs lg:grid-cols-4">
        <Metric
          label="Queued"
          value={data.materialization.pending}
          hint={
            data.materialization.oldestDueAt === null
              ? 'nothing waiting'
              : `oldest due ${relativeAge(data.materialization.oldestDueAt)}`
          }
        />
        <Metric
          label="Failed"
          value={stranded}
          // Spread rather than `tone={cond ? 'failed' : undefined}`:
          // exactOptionalPropertyTypes distinguishes "absent" from "undefined".
          {...(stranded > 0 ? { tone: 'failed' as const } : {})}
          hint={stranded > 0 ? 'not retried automatically' : 'none'}
        />
        <Metric
          label="Nodes projected"
          value={data.projection.nodes}
          hint={
            data.projection.oldestProjectedAt === null
              ? 'no nodes yet'
              : `oldest ${relativeAge(data.projection.oldestProjectedAt)}`
          }
        />
        {data.auditDelivery === undefined ? (
          <Metric label="Audit export" value="—" hint="no transport configured" />
        ) : (
          <Metric
            label="Audit export"
            value={data.auditDelivery.pending}
            hint={`queued via ${data.auditDelivery.transport}`}
          />
        )}
      </dl>

      {data.projection.factsNoNodeReports.length > 0 && (
        <FactWarning facts={data.projection.factsNoNodeReports} />
      )}

      {data.includesDetail && data.materialization.failures.length > 0 && (
        <Failures failures={data.materialization.failures} />
      )}
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'failed';
}) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd
        className={cn(
          'font-mono text-sm tabular-nums text-ink',
          tone === 'failed' && 'text-state-failed',
        )}
      >
        {value}
      </dd>
      {hint !== undefined && <p className="text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * A rule against a fact nothing reports can never match, and nothing about the
 * group would look wrong. Naming the facts is the whole value — the operator
 * can then go and find the rules.
 */
function FactWarning({ facts }: { facts: string[] }) {
  return (
    <div className="border-t border-line px-3 py-2 text-[11px] text-state-pending">
      <span className="font-medium">
        {facts.length} projected fact{facts.length === 1 ? '' : 's'} that no node reports:
      </span>{' '}
      <span className="font-mono">{facts.join(', ')}</span>
      <p className="mt-0.5 text-ink-faint">
        A classification rule on any of these can never match.
      </p>
    </div>
  );
}

/** ADMIN only — the API withholds these strings from everyone else. */
function Failures({ failures }: { failures: SystemStatus['materialization']['failures'] }) {
  return (
    <div className="border-t border-line px-3 py-2">
      <p className="mb-1 text-[11px] font-medium text-state-failed">
        Stranded nodes — these keep their previous classification until fixed
      </p>
      <ul className="space-y-1">
        {failures.slice(0, 5).map((failure) => (
          <li key={`${failure.certname ?? 'reconcile'}-${failure.failedAt ?? ''}`}>
            <span className="font-mono text-[11px] text-ink">
              {failure.certname ?? 'full reconcile'}
            </span>
            {failure.lastError !== null && (
              <p className="truncate text-[11px] text-ink-faint" title={failure.lastError}>
                {failure.lastError}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
