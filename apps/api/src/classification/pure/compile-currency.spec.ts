import { compileCurrency } from './compile-currency';

const A = 'aaa';
const B = 'bbb';
const C = 'ccc';

describe('compileCurrency (ADR-0022 §12)', () => {
  it('is current when the node compiled the revision the origin holds', () => {
    expect(compileCurrency({ reported: A, origin: A, peer: A })).toBe('CURRENT');
  });

  /*
   * Current against the ORIGIN even if the peer's recorded position is stale.
   * The peer row is written on fetch and the receipt on compile; a receipt can
   * legitimately arrive first, and that must not make a current node look
   * behind.
   */
  it('is current against the origin regardless of what the peer last fetched', () => {
    expect(compileCurrency({ reported: A, origin: A, peer: B })).toBe('CURRENT');
  });

  it('blames the puller when the node matches its server and the server is behind', () => {
    expect(compileCurrency({ reported: A, origin: B, peer: A })).toBe('PULLER_BEHIND');
  });

  it('blames the agent when the server is current and the node is not', () => {
    expect(compileCurrency({ reported: A, origin: B, peer: B })).toBe('AGENT_BEHIND');
  });

  it('reports both when the server is behind and the node is behind the server', () => {
    expect(compileCurrency({ reported: A, origin: C, peer: B })).toBe('BOTH_BEHIND');
  });

  /*
   * Co-located: the tree is materialized in place, so there is no puller and
   * no fetch to record. The replication-lag failure mode cannot occur, so the
   * verdict is two-state rather than four — a simplification, not missing data
   * (§16).
   */
  it('is unattributed when there is no peer position, as co-located', () => {
    expect(compileCurrency({ reported: A, origin: B, peer: null })).toBe('BEHIND');
  });

  it('is still current co-located when the revisions match', () => {
    expect(compileCurrency({ reported: A, origin: A, peer: null })).toBe('CURRENT');
  });

  /*
   * An unstamped tree means the comparison was never made. Saying "behind"
   * asserts a comparison; this returns the unattributed state instead of
   * inventing a verdict from one operand.
   */
  it('does not claim a verdict when the tree carries no revision', () => {
    expect(compileCurrency({ reported: A, origin: null, peer: null })).toBe('BEHIND');
    expect(compileCurrency({ reported: A, origin: null, peer: A })).toBe('BEHIND');
  });

  /*
   * Revisions are content hashes with no order. Nothing here may infer which
   * of two revisions is newer — only whether they are the same string.
   */
  it('treats revisions as opaque, comparing only for equality', () => {
    expect(compileCurrency({ reported: 'zzz', origin: 'aaa', peer: 'aaa' })).toBe('AGENT_BEHIND');
    expect(compileCurrency({ reported: 'aaa', origin: 'zzz', peer: 'zzz' })).toBe('AGENT_BEHIND');
  });
});
