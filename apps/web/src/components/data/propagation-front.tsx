'use client';

import Link from 'next/link';
import type { PropagationFront as Front } from '@nexuspuppet/contracts';
import { usePropagationFront } from '@/lib/queries';
import { ago, shortHash } from '@/lib/format';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingRows, QueryError } from '@/components/states';

/**
 * Where the current classification has actually got to (#147).
 *
 * NexusPuppet is the only thing in the estate that knows both the intent and
 * the outcome, and this is that asymmetry made visible: written here,
 * replicated to Puppet servers, compiled by nodes.
 *
 * IT READS AS PROGRESS, NOT AS FAILURE. A node that has not compiled the
 * current revision has almost always just not run yet — agents check in on
 * their own schedule, and most of every interval is spent legitimately behind.
 * Rendering that as a fault would make the view noise in the routine case and
 * unbelievable in the real one, so nothing here is red except a genuine
 * materialization failure, which is the one stage that is nobody's schedule.
 */
export function PropagationFront() {
  const query = usePropagationFront();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Propagation</CardTitle>
        <span className="text-[11px] text-ink-faint">where the current classification has got</span>
      </CardHeader>

      {query.isPending ? (
        <LoadingRows rows={2} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : (
        <Body front={query.data} />
      )}
    </Card>
  );
}

function Body({ front }: { front: Front }) {
  /*
   * No revision means the tree has never been stamped, so every comparison
   * below is impossible rather than false. Saying so is the honest answer; the
   * alternative is reporting an estate that is 0% propagated, which is a
   * confident wrong number at the moment somebody is trusting it.
   */
  if (front.revision === null) {
    return (
      <div className="px-3 py-2.5 text-[11px] text-ink-muted">
        The ENC tree carries no revision yet, so propagation cannot be measured. It is stamped when
        the materializer next writes.
      </div>
    );
  }

  const compiledPercent =
    front.compiled.total === 0
      ? 0
      : Math.round((front.compiled.current / front.compiled.total) * 100);

  return (
    <div className="space-y-2.5 px-3 py-2.5">
      {/* The chain, in the order a change travels. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Stage
          label="materialized"
          value={front.pending === 0 ? 'done' : `${String(front.pending)} queued`}
          tone={front.pending === 0 ? 'ok' : 'working'}
        />
        <Arrow />
        {/*
          PEERS DECIDE THIS STAGE, NOT THE FLAG.
          `ENC_REPLICATION_ENABLED` means "the ENC listener is running"
          (CONTEXT.md), and since ADR-0022 §14 a co-located deployment turns it
          on purely to accept its OWN receipts over loopback — replicating to
          nobody. Reading the flag showed such a deployment `replicated 0/0` in
          amber, which says something is failing to arrive when nothing is meant
          to be arriving.

          A deployment that genuinely expects peers and has none is a real
          problem, and it is already an open condition (`replication.no-peer`).
          Raising it a second time here would double-count one fault and make
          the routine co-located case look broken.
        */}
        {front.replication.total === 0 ? (
          <Stage
            label="replicated"
            value={front.replication.enabled ? 'no peers' : 'not replicating'}
            tone="muted"
          />
        ) : (
          <Stage
            label="replicated"
            value={`${String(front.replication.current)}/${String(front.replication.total)}`}
            tone={front.replication.current === front.replication.total ? 'ok' : 'working'}
          />
        )}
        <Arrow />
        <Stage
          label="compiled"
          value={`${String(front.compiled.current)}/${String(front.compiled.total)}`}
          tone={
            front.compiled.total > 0 && front.compiled.current === front.compiled.total
              ? 'ok'
              : 'working'
          }
        />
      </div>

      {/* Progress, not a gauge of health — deliberately unlabelled by colour. */}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-panel-raised"
        role="progressbar"
        aria-valuenow={compiledPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="nodes on the current classification"
      >
        <div
          className="h-full rounded-full bg-state-unchanged transition-[width] duration-500"
          style={{ width: `${String(compiledPercent)}%` }}
        />
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
        <div className="flex gap-1.5">
          <dt className="text-ink-faint">revision</dt>
          <dd className="text-ink">{shortHash(front.revision)}</dd>
        </div>
        {front.materializedAt !== null && (
          <div className="flex gap-1.5">
            <dt className="text-ink-faint">written</dt>
            <dd className="text-ink">{ago(front.materializedAt)}</dd>
          </div>
        )}
        <div className="flex gap-1.5">
          <dt className="text-ink-faint">reported</dt>
          <dd className="text-ink">
            {front.compiled.reported}/{front.compiled.total}
          </dd>
        </div>
      </dl>

      {/* The one genuine fault in the chain. Everything else is a schedule. */}
      {front.failed > 0 && (
        <p className="text-[11px] text-state-failed">
          {front.failed} classification change{front.failed === 1 ? '' : 's'} could not be written.
          These will not arrive without intervention.
        </p>
      )}

      <Outstanding front={front} />
    </div>
  );
}

/**
 * Who is not there yet, by name, so the view leads somewhere.
 *
 * Split by whether the node has ever reported, because those lead to different
 * places: one is waiting for an agent run, the other ran and was handed an
 * older classification — which points at a Puppet server, not at the node.
 */
function Outstanding({ front }: { front: Front }) {
  if (front.outstandingTotal === 0) {
    return (
      <p className="text-[11px] text-ink-muted">
        Every node in the estate has been served this classification.
      </p>
    );
  }

  const stale = front.outstanding.filter((n) => n.reportedRevision !== null);
  const silent = front.outstanding.filter((n) => n.reportedRevision === null);

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-ink-muted">
        {front.outstandingTotal} node{front.outstandingTotal === 1 ? '' : 's'} not yet on this
        revision. Outstanding, not failing — agents compile on their own schedule.
      </p>

      {stale.length > 0 && (
        <NodeList
          hint="reported an older revision"
          nodes={stale.map((n) => ({
            certname: n.certname,
            detail: shortHash(n.reportedRevision),
          }))}
        />
      )}
      {silent.length > 0 && (
        <NodeList
          hint="not reported yet"
          nodes={silent.map((n) => ({ certname: n.certname, detail: '—' }))}
        />
      )}

      {front.outstandingTotal > front.outstanding.length && (
        <p className="text-[11px] text-ink-faint">
          and {front.outstandingTotal - front.outstanding.length} more
        </p>
      )}
    </div>
  );
}

function NodeList({
  hint,
  nodes,
}: {
  hint: string;
  nodes: Array<{ certname: string; detail: string }>;
}) {
  return (
    <div>
      <p className="text-[11px] text-ink-faint">{hint}</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {nodes.map((node) => (
          <li key={node.certname}>
            <Link href={`/nodes/${node.certname}`} className="text-ink hover:text-accent">
              {node.certname}
            </Link>{' '}
            <span className="text-ink-faint">{node.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TONES = {
  ok: 'text-state-unchanged',
  working: 'text-state-pending',
  muted: 'text-ink-faint',
} as const;

function Stage({ label, value, tone }: { label: string; value: string; tone: keyof typeof TONES }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-ink-faint">{label}</span>
      <span className={`font-mono ${TONES[tone]}`}>{value}</span>
    </span>
  );
}

function Arrow() {
  return (
    <span aria-hidden className="text-ink-faint">
      →
    </span>
  );
}
