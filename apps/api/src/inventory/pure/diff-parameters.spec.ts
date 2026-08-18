import type { ResourceParameters } from '@nexuspuppet/contracts';
import { differingKeys } from './diff-parameters';

/*
 * Which parameters differ between variants (ADR-0025 §9).
 *
 * A wrong answer here sends somebody to a machine. Too many keys highlighted
 * and the operator stops trusting the highlight; too few and the one that
 * matters is the one they scroll past.
 */

const variant = (certname: string, parameters: Record<string, unknown>): ResourceParameters => ({
  certname,
  resourceHash: certname,
  parameters,
});

describe('differingKeys', () => {
  /*
   * THE CASE THE FEATURE EXISTS FOR: one node was hand-edited.
   */
  it('names only the parameters that actually differ', () => {
    const keys = differingKeys([
      variant('app18', {
        ensure: 'file',
        owner: 'root',
        mode: '0600',
        content: 'PermitRootLogin no',
      }),
      variant('cache35', {
        ensure: 'file',
        owner: 'root',
        mode: '0666',
        content: 'PermitRootLogin yes',
      }),
    ]);

    expect(keys).toEqual(['content', 'mode']);
  });

  it('returns nothing when every variant agrees', () => {
    const same = { ensure: 'file', mode: '0644' };
    expect(differingKeys([variant('a', same), variant('b', { ...same })])).toEqual([]);
  });

  /*
   * A single variant cannot differ from itself. The list already said
   * "1 variant"; contradicting it here would have the screen arguing with
   * itself in front of the operator.
   */
  it('returns nothing for one variant, or none', () => {
    expect(differingKeys([variant('a', { mode: '0644' })])).toEqual([]);
    expect(differingKeys([])).toEqual([]);
  });

  /*
   * A parameter present on one node and ABSENT on another is a difference, and
   * usually the most telling one — it normally means a node is running older
   * code than the rest.
   */
  it('treats a missing parameter as a difference', () => {
    const keys = differingKeys([
      variant('a', { ensure: 'file', mode: '0644' }),
      variant('b', { ensure: 'file' }),
    ]);

    expect(keys).toEqual(['mode']);
  });

  /*
   * Values are arbitrary JSON. Comparing arrays and objects by reference would
   * report every one of them as differing on every comparison — highlighting
   * everything, which highlights nothing.
   */
  it('compares structured values by content, not by reference', () => {
    const keys = differingKeys([
      variant('a', { require: ['Package[openssh]'], meta: { retries: 3 } }),
      variant('b', { require: ['Package[openssh]'], meta: { retries: 3 } }),
    ]);

    expect(keys).toEqual([]);
  });

  /*
   * `{a:1,b:2}` and `{b:2,a:1}` are the same configuration and Puppet promises
   * no key order. Reporting them as different would send somebody to a machine
   * that is fine.
   */
  it('ignores key order inside a structured value', () => {
    const keys = differingKeys([
      variant('a', { meta: { alpha: 1, beta: 2 } }),
      variant('b', { meta: { beta: 2, alpha: 1 } }),
    ]);

    expect(keys).toEqual([]);
  });

  it('finds a difference nested inside a structured value', () => {
    const keys = differingKeys([
      variant('a', { meta: { retries: 3 } }),
      variant('b', { meta: { retries: 5 } }),
    ]);

    expect(keys).toEqual(['meta']);
  });

  /*
   * `undefined` and an explicit null are not the same thing to Puppet, and
   * collapsing them would hide a real difference between a parameter that was
   * set to undef and one that was never set.
   */
  it('separates an explicit null from an absent parameter', () => {
    const keys = differingKeys([variant('a', { mode: null }), variant('b', {})]);

    expect(keys).toEqual(['mode']);
  });

  it('compares across more than two variants', () => {
    const keys = differingKeys([
      variant('a', { mode: '0600', owner: 'root' }),
      variant('b', { mode: '0600', owner: 'root' }),
      variant('c', { mode: '0600', owner: 'nobody' }),
    ]);

    expect(keys).toEqual(['owner']);
  });

  it('sorts the keys, so one comparison always renders the same way', () => {
    const keys = differingKeys([
      variant('a', { zebra: 1, alpha: 1, mode: 1 }),
      variant('b', { zebra: 2, alpha: 2, mode: 2 }),
    ]);

    expect(keys).toEqual(['alpha', 'mode', 'zebra']);
  });
});
