import type { SystemStatus } from '@nexuspuppet/contracts';

/**
 * The conditions this product alerts on, and nothing else (ADR-0021 §6).
 *
 * Pure: given a reading of the system, produce the evaluations. No I/O, no
 * clock — `decide()` owns the lifecycle and takes `now` as a parameter.
 *
 * BINDING CONSTRAINT (ADR-0021 §1): a summary here describes the DEPLOYMENT'S
 * HEALTH and never a person or an action they took. The test any reader can
 * apply: does the message name somebody? If it could, it belongs in the audit
 * trail and goes out through the audit transports, which are gated on
 * `audit.export`. This is the whole reason notifications can live in core.
 *
 * WHAT IS DELIBERATELY ABSENT is as load-bearing as what is here:
 *
 *   - Per-node run failures. PuppetDB already knows, the estate already
 *     monitors it, and one flapping node would generate more traffic than
 *     every condition below combined — poisoning the channel for all of them.
 *   - Login failures and lockouts. The audit trail's job, and close to the §1
 *     line.
 *   - Anything already in AuditLog.
 */

export type Severity = 'critical' | 'warning';

export interface ConditionReading {
  /** Stable identity, including the instance for per-peer conditions. */
  key: string;
  kind: string;
  severity: Severity;
  /** Human-readable, and never naming a person or an action (§1). */
  summary: string;
  failing: boolean;
  selfResolving: boolean;
}

/** Days before expiry at which a certificate starts being worth mentioning. */
export const CERT_EXPIRY_WARNING_DAYS = 30;

export interface CatalogueInput {
  status: SystemStatus;
  puppetDbReachable: boolean;
  puppetDbLastSuccessAt: string | null;
  /** Null when no certificate path is configured — not a fault (ADR-0013). */
  consoleCertDaysRemaining: number | null;
  /** Cumulative drops already announced, so the same drop is not re-opened. */
  announcedUndeliveredDrops: number;
  pruneSkippedReason: string | null;
}

/**
 * How long a peer may hold a tree with nothing to report before that is odd.
 *
 * Four Puppet run intervals at the 30-minute default. Long enough that an agent
 * which simply has not run yet is never mistaken for a broken collector.
 */
const RECEIPT_GRACE_SECONDS = 4 * 30 * 60;

export function readConditions(input: CatalogueInput): ConditionReading[] {
  const { status } = input;
  const readings: ConditionReading[] = [];

  // 1. Classification is not reaching disk.
  //
  // Stranded jobs are not retried, so this does not clear itself. The console
  // says "saved" and nothing is on disk — the failure that looks most like
  // success.
  readings.push({
    key: 'materialization.stranded',
    kind: 'materialization.stranded',
    severity: 'critical',
    summary:
      status.materialization.failed > 0
        ? `${String(status.materialization.failed)} classification job(s) failed and are not retried. Nodes keep their previous classification.`
        : 'Classification is reaching disk.',
    failing: status.materialization.failed > 0,
    selfResolving: false,
  });

  // 2. Classification is not reaching a Puppet server.
  //
  // Silent everywhere else: the console reports the change as materialized,
  // which is true and useless if it never left the building.
  if (status.replication !== undefined && status.replication.enabled) {
    const { peers, allowedCertnames } = status.replication;

    readings.push({
      key: 'replication.no-peer',
      kind: 'replication.no-peer',
      severity: 'critical',
      summary:
        peers.length === 0
          ? `No Puppet server has ever fetched the classification tree${
              allowedCertnames.length > 0 ? ` (expecting ${allowedCertnames.join(', ')})` : ''
            }.`
          : 'A Puppet server is fetching the classification tree.',
      failing: peers.length === 0,
      selfResolving: false,
    });

    /*
     * A peer that fetches and never reports (ADR-0022).
     *
     * FOUND IN OUR OWN LAB, which is why it exists. The receipts collector was
     * pointed at a different instance from the one serving the tree, so a
     * Puppet server fetched 2705 times and reported nothing. The estate
     * converged perfectly the whole time; what was broken was only the
     * ANSWER to "did it land", and the console said `compiled 0/N` for ever
     * with no way to tell that apart from "no agent has run yet".
     *
     * WARNING, not critical: nothing is misconfigured on the estate and no node
     * is wrong. What is lost is visibility, and calling that critical would
     * teach people to ignore critical.
     *
     * The grace window is generous on purpose. Receipts appear only when an
     * agent actually runs, and Puppet's default runinterval is 30 minutes — so
     * a peer holding a fresh tree with nothing to report is NORMAL for a while.
     * Four agent cycles is long enough that silence means something.
     */
    for (const peer of peers) {
      const heldLongEnough =
        peer.secondsSinceChange !== null && peer.secondsSinceChange > RECEIPT_GRACE_SECONDS;

      readings.push({
        key: `replication.not-reporting:${peer.certname}`,
        kind: 'replication.not-reporting',
        severity: 'warning',
        summary:
          heldLongEnough && peer.reportedCount === 0
            ? `${peer.certname} has been fetching the tree for ` +
              `${Math.floor(peer.secondsSinceChange! / 3600)}h and has never reported a compile. ` +
              'Its receipts collector is either pointed at a different origin or not running, ' +
              'so this deployment cannot tell which nodes have applied the classification.'
            : `${peer.certname} is reporting compiles.`,
        failing: heldLongEnough && peer.reportedCount === 0,
        selfResolving: false,
      });

      readings.push({
        key: `replication.behind:${peer.certname}`,
        kind: 'replication.behind',
        severity: 'critical',
        summary: peer.behind
          ? peer.lastChangedAt === null
            ? `${peer.certname} has never received a classification tree.`
            : `${peer.certname} is serving classification older than this deployment has written.`
          : `${peer.certname} has the current classification.`,
        failing: peer.behind,
        selfResolving: false,
      });
    }
  }

  // 3. PuppetDB unreachable.
  //
  // A warning rather than critical: agents keep converging from the tree on
  // disk (ADR-0003). What degrades is inventory freshness, and rules evaluate
  // against facts that stopped moving.
  readings.push({
    key: 'puppetdb.unreachable',
    kind: 'puppetdb.unreachable',
    severity: 'warning',
    summary: input.puppetDbReachable
      ? 'PuppetDB is answering.'
      : `PuppetDB is not answering${
          input.puppetDbLastSuccessAt === null
            ? ' and never has'
            : `; last successful query ${input.puppetDbLastSuccessAt}`
        }. Inventory and rule evaluation are working from stale facts.`,
    failing: !input.puppetDbReachable,
    selfResolving: false,
  });

  // 4. The projector refused to prune.
  //
  // The implausibly-small-response guard fired: something upstream is wrong
  // and we deliberately did nothing, which is the correct behaviour and needs
  // saying out loud. Pruning on a truncated response would cascade to
  // EncMaterialization and unclassify the fleet.
  readings.push({
    key: 'projection.prune-refused',
    kind: 'projection.prune-refused',
    severity: 'warning',
    summary:
      input.pruneSkippedReason === null
        ? 'Node projection is pruning normally.'
        : `Node projection refused to prune: ${input.pruneSkippedReason}. Nothing was deleted.`,
    failing: input.pruneSkippedReason !== null,
    selfResolving: false,
  });

  // 5. Audit delivery failing. Present only where `audit.export` is — an
  //    absent capability is not an unhealthy deployment.
  if (status.auditForwarding.available && status.auditForwarding.active !== 'none') {
    const failed = status.auditForwarding.lastDelivery?.ok === false;
    readings.push({
      key: 'audit.delivery-failing',
      kind: 'audit.delivery-failing',
      severity: 'warning',
      summary: failed
        ? `Audit records are not reaching the ${status.auditForwarding.active} collector. They are queued, not lost.`
        : 'Audit records are being delivered.',
      failing: failed,
      selfResolving: false,
    });
  }

  // 6. Audit records dropped undelivered (§3, self-resolving).
  //
  // The one case where retention destroys evidence rather than merely ageing
  // it out. A cumulative counter, so it is compared against what has already
  // been announced — otherwise it would re-open on every evaluation forever.
  const dropped = status.retention.undeliveredDropped.total;
  readings.push({
    key: 'audit.records-dropped',
    kind: 'audit.records-dropped',
    severity: 'warning',
    summary:
      dropped > input.announcedUndeliveredDrops
        ? `Retention dropped ${String(dropped - input.announcedUndeliveredDrops)} audit record(s) that had never been delivered.`
        : 'No audit records have been dropped undelivered.',
    failing: dropped > input.announcedUndeliveredDrops,
    selfResolving: true,
  });

  // 7. The console certificate is expiring.
  //
  // Cheap, and the classic outage nobody saw coming — on the interface an
  // operator would use to fix it.
  if (input.consoleCertDaysRemaining !== null) {
    const days = input.consoleCertDaysRemaining;
    readings.push({
      key: 'console-cert.expiring',
      kind: 'console-cert.expiring',
      severity: days <= 0 ? 'critical' : 'warning',
      summary:
        days <= CERT_EXPIRY_WARNING_DAYS
          ? days <= 0
            ? 'The console certificate has expired.'
            : `The console certificate expires in ${String(days)} day(s).`
          : 'The console certificate is valid.',
      failing: days <= CERT_EXPIRY_WARNING_DAYS,
      selfResolving: false,
    });
  }

  return readings;
}
