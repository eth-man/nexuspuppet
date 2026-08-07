import {
  decide,
  isOpen,
  FAILURES_TO_OPEN,
  type ConditionState,
  type Decision,
} from './condition-lifecycle';

const T = (n: number) => new Date(`2026-08-07T10:${String(n).padStart(2, '0')}:00.000Z`);

const fail = { failing: true, selfResolving: false };
const pass = { failing: false, selfResolving: false };

/** Run a sequence of evaluations, returning every decision. */
function run(evaluations: Array<{ failing: boolean; selfResolving: boolean }>): Decision[] {
  let state: ConditionState | null = null;
  const decisions: Decision[] = [];

  evaluations.forEach((evaluation, index) => {
    const decision = decide(state, evaluation, T(index));
    state = decision.state;
    decisions.push(decision);
  });

  return decisions;
}

const transitions = (decisions: Decision[]) => decisions.map((d) => d.transition);

describe('condition lifecycle', () => {
  it('does not open before three consecutive failures', () => {
    expect(transitions(run([fail, fail]))).toEqual([null, null]);
  });

  it('opens on exactly the third consecutive failure', () => {
    const decisions = run([fail, fail, fail]);

    expect(transitions(decisions)).toEqual([null, null, 'opened']);
    expect(decisions[2]?.state.openedAt).toEqual(T(2));
  });

  /*
   * The reason the threshold says CONSECUTIVE. Without resetting the run on a
   * pass, three failures spread across a week would open a condition that was
   * healthy almost the whole time.
   */
  it('resets the run on a passing evaluation', () => {
    expect(transitions(run([fail, fail, pass, fail, fail]))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('resolves on the first passing evaluation after opening', () => {
    const decisions = run([fail, fail, fail, pass]);

    expect(transitions(decisions)).toEqual([null, null, 'opened', 'resolved']);
    expect(decisions[3]?.state.resolvedAt).toEqual(T(3));
  });

  /*
   * The entire point of the condition model. An evaluator firing per tick
   * would send the same alert every few minutes until somebody fixed it, and
   * the reliable consequence is a muted channel.
   */
  it('does not re-open or re-notify while it stays open', () => {
    expect(transitions(run([fail, fail, fail, fail, fail, fail, fail]))).toEqual([
      null,
      null,
      'opened',
      null,
      null,
      null,
      null,
    ]);
  });

  it('opens again after resolving, and clears the resolution', () => {
    const decisions = run([fail, fail, fail, pass, fail, fail, fail]);

    expect(transitions(decisions)).toEqual([
      null,
      null,
      'opened',
      'resolved',
      null,
      null,
      'opened',
    ]);
    expect(decisions[6]?.state.resolvedAt).toBeNull();
    expect(decisions[6]?.state.openedAt).toEqual(T(6));
  });

  it('stays quiet while healthy', () => {
    expect(transitions(run([pass, pass, pass]))).toEqual([null, null, null]);
  });

  it('does not resolve something that never opened', () => {
    const decisions = run([fail, pass]);

    expect(transitions(decisions)).toEqual([null, null]);
    expect(decisions[1]?.state.resolvedAt).toBeNull();
  });

  describe('self-resolving conditions (ADR-0021 §3)', () => {
    const drop = { failing: true, selfResolving: true };

    /*
     * A recorded count of dropped records is not a measurement that can flap,
     * so requiring it to repeat would delay a fact that is already certain —
     * and it might never repeat at all.
     */
    it('opens on the first observation rather than the third', () => {
      expect(transitions(run([drop]))).toEqual(['opened']);
    });

    it('resolves at the next evaluation once the signal is gone', () => {
      expect(transitions(run([drop, pass]))).toEqual(['opened', 'resolved']);
    });
  });

  describe('isOpen', () => {
    it('is false before it ever opened', () => {
      expect(isOpen({ consecutiveFailures: 2, openedAt: null, resolvedAt: null })).toBe(false);
    });

    it('is true while open', () => {
      expect(isOpen({ consecutiveFailures: 3, openedAt: T(0), resolvedAt: null })).toBe(true);
    });

    it('is false once resolved', () => {
      expect(isOpen({ consecutiveFailures: 0, openedAt: T(0), resolvedAt: T(1) })).toBe(false);
    });
  });

  it('states the threshold it was built against', () => {
    // Guards the ADR's number against a silent edit: changing it changes how
    // long an outage stays invisible.
    expect(FAILURES_TO_OPEN).toBe(3);
  });
});
