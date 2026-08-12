import type { CompileCurrency, CompileReceiptView } from '@nexuspuppet/contracts';
import { Card, CardHeader, CardTitle } from '../ui/card';
import { EmptyState } from '../states';
import { ago, shortHash } from '../../lib/format';

/**
 * What each Puppet server reported this node last compiling (ADR-0022).
 *
 * Sits beside the served document deliberately: that card says what this node
 * WILL be served, and this one says what it last actually compiled. Together
 * they are the whole question an operator is asking during a rollout, and apart
 * they are each half an answer.
 */

/**
 * WHAT THIS SAYS, AND WHAT IT MUST NEVER SAY.
 *
 * "Reported", never "compiled at". The receipt carries no compile time — the
 * ENC script writes only a revision and a certname (§9), and the origin stamps
 * arrival. The gap between the two is up to one collection interval, and
 * labelling it as a compile time would invent precision in exactly the incident
 * where somebody is reasoning about ordering.
 *
 * It also proves what was SERVED, not what was applied. A catalogue that failed
 * afterwards is loud in PuppetDB and absent here.
 */
/*
 * ONE mapping, in one place, using the existing palette tokens — the same
 * discipline `lib/status.ts` enforces for Puppet state, applied to a different
 * domain. Compile currency is NOT a Puppet state, so it must not go through
 * stateStyle(): that would make "behind" and "changed" the same concept.
 *
 * Amber rather than red throughout. A node that has not compiled the newest
 * classification is normal for most of every agent interval; red would make the
 * ordinary case look like an incident and teach operators to ignore it.
 */
const VERDICT: Record<CompileCurrency, { label: string; tone: string; detail: string }> = {
  CURRENT: {
    label: 'Current',
    tone: 'text-state-unchanged',
    detail: 'Compiled the classification this deployment is serving.',
  },
  PULLER_BEHIND: {
    label: 'Puller behind',
    tone: 'text-state-pending',
    detail:
      'The node has what its Puppet server has — that server has not fetched the current tree yet.',
  },
  AGENT_BEHIND: {
    label: 'Agent behind',
    tone: 'text-state-pending',
    detail: 'Its Puppet server has the current tree; the node has not compiled since.',
  },
  BOTH_BEHIND: {
    label: 'Both behind',
    tone: 'text-state-pending',
    detail: 'Its Puppet server has not fetched the current tree, and the node is behind that.',
  },
  BEHIND: {
    label: 'Behind',
    tone: 'text-state-pending',
    detail:
      'Not the revision being served. No fetch position is recorded for this server, so the ' +
      'lag cannot be attributed — normal where NexusPuppet runs on the Puppet server itself.',
  },
};

export function CompileReceipts({ receipts }: { receipts: CompileReceiptView[] | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last reported compile</CardTitle>
        <span className="text-2xs text-ink-faint">what was served, not what was applied</span>
      </CardHeader>

      {receipts === undefined || receipts.length === 0 ? (
        /*
         * "Not reported" is not "behind". Before a collector runs there is no
         * receipt for any node, and rendering that as a fault would light up
         * every row in the estate over missing bookkeeping.
         */
        <EmptyState
          title="Nothing reported yet"
          hint="A Puppet server reports this as it serves the node. Nothing has been received for it."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {receipts.map((receipt) => {
            const verdict = VERDICT[receipt.currency];
            return (
              <li key={receipt.peerCertname} className="space-y-1 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-xs font-medium ${verdict.tone}`}>{verdict.label}</span>
                  <span className="text-2xs text-ink-faint">
                    reported {ago(receipt.reportedAt)}
                  </span>
                </div>

                <p className="text-2xs text-ink-muted">{verdict.detail}</p>

                {/* Monospace, and truncated to a prefix: a full SHA-256 is
                    unreadable and never retyped, but the first characters are
                    what someone compares against another screen. */}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-2xs">
                  <dt className="text-ink-faint">compiled</dt>
                  <dd className="text-ink">{shortHash(receipt.revision)}</dd>
                  {receipt.peerRevision !== null && (
                    <>
                      <dt className="text-ink-faint">server has</dt>
                      <dd className="text-ink">{shortHash(receipt.peerRevision)}</dd>
                    </>
                  )}
                  <dt className="text-ink-faint">via</dt>
                  <dd className="text-ink">{receipt.peerCertname}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
