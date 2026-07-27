import type { NodeStatus } from '@nexuspuppet/contracts';

/**
 * The single mapping from a Puppet state to its appearance.
 *
 * Everything that renders a state — table cells, badges, detail headers,
 * counters — resolves through here. A second mapping anywhere else is how a
 * "failed" node ends up amber on one screen and red on another, which in an
 * ops tool is a correctness problem rather than an inconsistency.
 */
export type DisplayState = NodeStatus | 'pending' | 'noop' | 'skipped';

interface StateStyle {
  label: string;
  /** Border + tint for badges. */
  badge: string;
  /** Text only, for dense table cells. */
  text: string;
  /** The status dot. */
  dot: string;
}

export const STATE_STYLES: Record<DisplayState, StateStyle> = {
  failed: {
    label: 'Failed',
    badge: 'border-state-failed/40 bg-state-failed/10 text-state-failed',
    text: 'text-state-failed',
    dot: 'bg-state-failed',
  },
  changed: {
    label: 'Changed',
    badge: 'border-state-changed/40 bg-state-changed/10 text-state-changed',
    text: 'text-state-changed',
    dot: 'bg-state-changed',
  },
  unchanged: {
    label: 'Unchanged',
    badge: 'border-state-unchanged/40 bg-state-unchanged/10 text-state-unchanged',
    text: 'text-state-unchanged',
    dot: 'bg-state-unchanged',
  },
  pending: {
    label: 'Pending',
    badge: 'border-state-pending/40 bg-state-pending/10 text-state-pending',
    text: 'text-state-pending',
    dot: 'bg-state-pending',
  },
  noop: {
    label: 'No-op',
    badge: 'border-state-pending/40 bg-state-pending/10 text-state-pending',
    text: 'text-state-pending',
    dot: 'bg-state-pending',
  },
  /**
   * Skipped is a KNOWN outcome — the resource was not applied because
   * something it depends on failed. Rendering it as "Unknown" told an operator
   * triaging a failure that the system had no idea what happened, when in fact
   * it knows precisely.
   *
   * The colour stays neutral: a skipped resource is a consequence of a failure,
   * not a failure in itself, and the palette reserves rose for the actual
   * cause. The label carries the meaning.
   */
  skipped: {
    label: 'Skipped',
    badge: 'border-state-unknown/40 bg-state-unknown/10 text-state-unknown',
    text: 'text-state-unknown',
    dot: 'bg-state-unknown',
  },
  unknown: {
    label: 'Unknown',
    badge: 'border-state-unknown/40 bg-state-unknown/10 text-state-unknown',
    text: 'text-state-unknown',
    dot: 'bg-state-unknown',
  },
};

export function stateStyle(state: DisplayState): StateStyle {
  return STATE_STYLES[state] ?? STATE_STYLES.unknown;
}

/** Resource-event statuses map onto the same vocabulary. */
export function eventState(status: 'success' | 'failure' | 'noop' | 'skipped'): DisplayState {
  switch (status) {
    case 'failure':
      return 'failed';
    case 'success':
      return 'changed';
    case 'noop':
      return 'noop';
    case 'skipped':
      return 'skipped';
  }
}
