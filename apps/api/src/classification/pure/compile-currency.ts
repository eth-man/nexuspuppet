import type { CompileCurrency } from '@nexuspuppet/contracts';

/**
 * How a node's last reported compile compares with the current classification
 * (ADR-0022 §12).
 *
 * THE VERDICT IS AGAINST THE ORIGIN, not against the node's own Puppet server.
 * The origin's revision is the one an operator created by saving a change, and
 * "did my change reach this node" is the question being asked. Judging against
 * the peer's revision instead would let a node read as perfectly current while
 * the change made an hour ago had reached nothing.
 *
 * The peer's revision is still needed — as the ATTRIBUTION. It is what
 * separates "the puller has not fetched" from "the agent has not run", which is
 * the difference between two entirely different things to go and fix.
 *
 * Pure, and deliberately in `pure/`: this is the sentence an operator acts on
 * during an incident, and it must be decidable from four strings with no clock,
 * no I/O and no ordering assumption between hosts.
 */
export function compileCurrency(input: {
  /** The revision the node reported compiling. */
  reported: string;
  /** The revision the tree on disk now carries, or null if never stamped. */
  origin: string | null;
  /**
   * The revision that node's Puppet server last fetched.
   *
   * Null co-located, where there is no puller — not missing data, but a
   * layout in which the question cannot arise.
   */
  peer: string | null;
}): CompileCurrency {
  const { reported, origin, peer } = input;

  // Nothing to compare against. Saying "behind" here would be an assertion
  // about a comparison that was never made.
  if (origin === null) return 'BEHIND';

  if (reported === origin) return 'CURRENT';

  /*
   * No peer position. Two cases reach here and neither can be attributed:
   * a co-located deployment, where the tree is materialized in place and the
   * peer IS the origin; and a peer that has never completed a fetch.
   *
   * Co-located, this is the whole answer — with no puller there is no
   * replication lag to distinguish, so "behind" means the agent has not run.
   * The caller knows which layout it is; this function does not pretend to.
   */
  if (peer === null) return 'BEHIND';

  const peerCurrent = peer === origin;
  const nodeMatchesPeer = reported === peer;

  // The node has what its server has; the server is the one lagging.
  if (nodeMatchesPeer && !peerCurrent) return 'PULLER_BEHIND';

  // The server has the current tree; the node has not compiled since.
  if (peerCurrent) return 'AGENT_BEHIND';

  // The server is behind AND the node has not even caught up with the server.
  return 'BOTH_BEHIND';
}
