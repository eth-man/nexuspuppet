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
          <span className="text-2xs font-medium text-state-failed">
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
        {/*
          "Stranded", not "Failed". This card sits directly above the estate
          tiles, where "Failed 9" counts NODE RUNS — so two numbers labelled
          the same thing, inches apart, meant entirely different things. This
          one counts nodes whose ENC file could not be written and which
          nothing will retry.
        */}
        <Metric
          label="Stranded"
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
        <Metric
          label="Audit export"
          value={data.auditForwarding.available ? data.auditForwarding.pending : '—'}
          {...(forwardingTone(data.auditForwarding) === null ? {} : { tone: 'failed' as const })}
          hint={forwardingHint(data.auditForwarding)}
        />
        {/*
          Materialized is not the end of the sentence; replicated is (ADR-0019
          §6). Without this the console reports a change as materialized —
          true, and useless, because it only means the file was written HERE.
        */}
        {data.replication !== undefined && (
          <Metric
            label="Replicated"
            value={replicationValue(data.replication)}
            {...(replicationTone(data.replication) === null ? {} : { tone: 'failed' as const })}
            hint={replicationHint(data.replication)}
          />
        )}
      </dl>

      {/*
        The pipeline states an operator must not have to infer (issue #95).
        Each renders only while true — a strip that is always present becomes
        furniture, and these exist to be noticed.
      */}
      {data.replication !== undefined &&
        data.replication.enabled &&
        data.replication.peers.some((peer) => peer.behind) && (
          <p className="border-t border-line px-3 py-2 text-2xs text-state-pending">
            <span className="font-medium">A Puppet server is behind.</span> Classification has been
            materialized since it last received the tree, so it is compiling catalogs from an older
            copy:{' '}
            {data.replication.peers
              .filter((peer) => peer.behind)
              .map((peer) =>
                peer.lastChangedAt === null
                  ? `${peer.certname} (has never received one)`
                  : `${peer.certname} (last received ${relativeAge(peer.lastChangedAt)})`,
              )
              .join(', ')}
            .
          </p>
        )}

      {/*
        Enabled, allowlisted, and yet nothing has ever asked. The listener is
        open and the puller is not installed or cannot reach it — which looks
        identical to "working" on every other surface.
      */}
      {data.replication !== undefined &&
        data.replication.enabled &&
        data.replication.peers.length === 0 && (
          <p className="border-t border-line px-3 py-2 text-2xs text-state-pending">
            <span className="font-medium">Replication is on, but nothing has fetched.</span> No
            Puppet server has ever asked for the tree
            {data.replication.allowedCertnames.length > 0 && (
              <>
                {' '}
                — expecting{' '}
                <span className="font-mono">{data.replication.allowedCertnames.join(', ')}</span>
              </>
            )}
            .
          </p>
        )}

      {data.auditForwarding.unconfirmableDelivery && (
        <p className="border-t border-line px-3 py-2 text-2xs text-state-pending">
          <span className="font-medium">Syslog over UDP: unconfirmable delivery.</span> This
          deployment cannot prove its audit records arrived at the collector.
        </p>
      )}

      {data.auditForwarding.lastDelivery?.ok === false && (
        <p className="border-t border-line px-3 py-2 text-2xs text-state-failed">
          <span className="font-medium">
            Last delivery failed {relativeAge(data.auditForwarding.lastDelivery.at)}.
          </span>{' '}
          Records queue rather than being lost; they need the collector back.
          {data.auditForwarding.lastDelivery.error !== null && (
            <span className="mt-0.5 block truncate font-mono text-ink-faint">
              {data.auditForwarding.lastDelivery.error}
            </span>
          )}
        </p>
      )}

      {data.retention.undeliveredDropped.total > 0 && (
        <p className="border-t border-line px-3 py-2 text-2xs text-state-failed">
          <span className="font-medium">
            {data.retention.undeliveredDropped.total} undelivered audit record
            {data.retention.undeliveredDropped.total === 1 ? '' : 's'} dropped by the row ceiling
          </span>
          {data.retention.undeliveredDropped.lastDroppedAt !== null &&
            `, last ${relativeAge(data.retention.undeliveredDropped.lastDroppedAt)}`}
          . The pending queue outgrew its bound — check the forwarding configuration and the
          collector.
        </p>
      )}

      <p className="border-t border-line px-3 py-2 text-2xs text-ink-faint">
        Audit retention: {data.retention.ageDays}d age window
        {' · '}
        {data.retention.maxRows === null
          ? 'no row ceiling configured'
          : `row ceiling ${data.retention.maxRows.toLocaleString()}`}
      </p>

      {data.projection.factsNoNodeReports.length > 0 && (
        <FactWarning facts={data.projection.factsNoNodeReports} />
      )}

      {data.includesDetail && data.materialization.failures.length > 0 && (
        <Failures failures={data.materialization.failures} />
      )}
    </Card>
  );
}

/**
 * One line under the number, saying what the pipeline is doing — including the
 * unlicensed case, in the same terms the Integrations screen uses.
 */
function forwardingHint(forwarding: SystemStatus['auditForwarding']): string {
  if (!forwarding.available) return 'needs audit.export';
  if (forwarding.active === 'none') return 'forwarding off';
  if (!forwarding.configured) return `via ${forwarding.active} (cannot send)`;
  if (forwarding.lastDelivery?.ok === true) {
    return `via ${forwarding.active}, delivered ${relativeAge(forwarding.lastDelivery.at)}`;
  }
  return `via ${forwarding.active}`;
}

/** Red only for the unambiguous condition: an active transport whose last attempt failed. */
/**
 * The number that answers "is my estate running what the console shows?".
 *
 * Peers up to date, out of peers seen. Not a percentage: with one Puppet
 * server — the common case — a percentage reads 0% or 100% and hides which.
 */
function replicationValue(replication: NonNullable<SystemStatus['replication']>): string | number {
  if (!replication.enabled) return '—';
  if (replication.peers.length === 0) return 0;
  return `${String(replication.peers.filter((peer) => !peer.behind).length)}/${String(replication.peers.length)}`;
}

function replicationHint(replication: NonNullable<SystemStatus['replication']>): string {
  if (!replication.enabled) return 'not replicating';
  if (replication.peers.length === 0) return 'no server has fetched';

  const behind = replication.peers.filter((peer) => peer.behind).length;
  if (behind > 0) return `${String(behind)} behind`;

  // Newest fetch, because "when did this last work" is the question a green
  // number provokes.
  const newest = replication.peers.reduce((a, b) => (a.lastFetchAt > b.lastFetchAt ? a : b));
  return `checked ${relativeAge(newest.lastFetchAt)}`;
}

function replicationTone(replication: NonNullable<SystemStatus['replication']>): 'failed' | null {
  if (!replication.enabled) return null;
  // Behind is amber, and stated in the strip below. Nothing having EVER
  // fetched is the one that reads as failure: the tree is not leaving the box.
  return replication.peers.length === 0 ? 'failed' : null;
}

function forwardingTone(forwarding: SystemStatus['auditForwarding']): 'failed' | null {
  return forwarding.active !== 'none' && forwarding.lastDelivery?.ok === false ? 'failed' : null;
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
      {hint !== undefined && <p className="text-2xs text-ink-faint">{hint}</p>}
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
    <div className="border-t border-line px-3 py-2 text-2xs text-state-pending">
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
      <p className="mb-1 text-2xs font-medium text-state-failed">
        Stranded nodes — these keep their previous classification until fixed
      </p>
      <ul className="space-y-1">
        {failures.slice(0, 5).map((failure) => (
          <li key={`${failure.certname ?? 'reconcile'}-${failure.failedAt ?? ''}`}>
            <span className="font-mono text-2xs text-ink">
              {failure.certname ?? 'full reconcile'}
            </span>
            {failure.lastError !== null && (
              <p className="truncate text-2xs text-ink-faint" title={failure.lastError}>
                {failure.lastError}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
