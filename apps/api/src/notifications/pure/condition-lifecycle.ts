/**
 * When a condition opens and when it resolves (ADR-0021 §2).
 *
 * Pure: no I/O, no clock, no randomness. `now` is a parameter, which is what
 * lets the boundaries be tested exhaustively rather than by sleeping.
 *
 * THE ASYMMETRY IS THE DESIGN, not a tuning choice to be averaged out later:
 *
 *   three consecutive failing evaluations to OPEN
 *   one passing evaluation to RESOLVE
 *
 * Slow to alarm, because a transient blip — one slow PuppetDB poll, one
 * database hiccup — must never page anybody. Alert fatigue is not a usability
 * complaint; it is the failure mode that makes an alerting system worse than
 * none, because the channel gets muted and takes the alert that mattered with
 * it.
 *
 * Quick to clear, because somebody who has just fixed something should be told
 * at once rather than left wondering whether it worked.
 */

export const FAILURES_TO_OPEN = 3;

/** What the store holds between evaluations. */
export interface ConditionState {
  consecutiveFailures: number;
  openedAt: Date | null;
  resolvedAt: Date | null;
}

export interface Evaluation {
  failing: boolean;
  /**
   * A discrete signal that will never stop being true on its own — "retention
   * dropped 12 undelivered records" (ADR-0021 §3).
   *
   * These open on FIRST observation rather than waiting for three, and the
   * exception is deliberate. The three-evaluation threshold exists to tolerate
   * transient measurement error; a recorded count of dropped records is not a
   * measurement that can flap, so requiring it to repeat would only delay a
   * fact that is already certain — and it might never repeat at all.
   */
  selfResolving: boolean;
}

export type Transition = 'opened' | 'resolved' | null;

export interface Decision {
  state: ConditionState;
  /** Non-null only at the edges. Everything downstream keys off this, so a
   *  condition that is merely still-open produces no delivery. */
  transition: Transition;
}

const OPEN = (state: ConditionState): boolean =>
  state.openedAt !== null && state.resolvedAt === null;

/**
 * Advance one condition by one evaluation.
 *
 * @param previous null when this condition has never been evaluated.
 */
export function decide(
  previous: ConditionState | null,
  evaluation: Evaluation,
  now: Date,
): Decision {
  const state: ConditionState = previous ?? {
    consecutiveFailures: 0,
    openedAt: null,
    resolvedAt: null,
  };

  if (!evaluation.failing) {
    /*
     * Passing. Resolve if it was open, and reset the run either way.
     *
     * Resetting on every pass is what makes the threshold mean CONSECUTIVE.
     * Without it, three failures spread across a week would open a condition
     * that was healthy almost the whole time.
     */
    if (OPEN(state)) {
      return {
        state: { consecutiveFailures: 0, openedAt: state.openedAt, resolvedAt: now },
        transition: 'resolved',
      };
    }
    return {
      state: { consecutiveFailures: 0, openedAt: state.openedAt, resolvedAt: state.resolvedAt },
      transition: null,
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;

  // Already open: still failing is not news. This is the whole point of the
  // condition model — no repeat delivery while nothing has changed.
  if (OPEN(state)) {
    return { state: { ...state, consecutiveFailures }, transition: null };
  }

  const threshold = evaluation.selfResolving ? 1 : FAILURES_TO_OPEN;
  if (consecutiveFailures < threshold) {
    return { state: { ...state, consecutiveFailures }, transition: null };
  }

  // Opening. resolvedAt is cleared so a condition that opens again after being
  // resolved reads as open rather than as both.
  return {
    state: { consecutiveFailures, openedAt: now, resolvedAt: null },
    transition: 'opened',
  };
}

/** True when the condition is currently open — the panel's filter. */
export function isOpen(state: ConditionState): boolean {
  return OPEN(state);
}
