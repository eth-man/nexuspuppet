import { mergeGroups } from './class-merger';
import type { MergeableGroup } from './class-merger';

const g = (over: Partial<MergeableGroup> & { id: string }): MergeableGroup => ({
  name: over.id,
  environment: null,
  classes: {},
  parameters: {},
  ...over,
});

describe('mergeGroups (ADR-0009)', () => {
  it('returns an empty document for no groups', () => {
    const result = mergeGroups([]);
    expect(result.document).toEqual({ classes: {}, parameters: {} });
    expect(result.conflicts).toEqual([]);
    expect(result.appliedGroupIds).toEqual([]);
  });

  it('unions class inclusion across groups', () => {
    const result = mergeGroups([
      g({ id: 'base', classes: { 'profile::base': {} } }),
      g({ id: 'web', classes: { 'profile::nginx': {} } }),
    ]);
    expect(Object.keys(result.document.classes).sort()).toEqual([
      'profile::base',
      'profile::nginx',
    ]);
  });

  it('merges disjoint parameters of the same class', () => {
    const result = mergeGroups([
      g({ id: 'a', classes: { 'profile::base': { ntp: 'a.pool' } } }),
      g({ id: 'b', classes: { 'profile::base': { dns: '8.8.8.8' } } }),
    ]);
    expect(result.document.classes['profile::base']).toEqual({ ntp: 'a.pool', dns: '8.8.8.8' });
    expect(result.conflicts).toEqual([]);
  });

  describe('last writer wins', () => {
    it('applies to class parameters and reports the conflict', () => {
      const result = mergeGroups([
        g({ id: 'base', name: 'Base', classes: { 'profile::base': { ntp: 'a.pool' } } }),
        g({ id: 'ovr', name: 'Override', classes: { 'profile::base': { ntp: 'b.pool' } } }),
      ]);

      expect(result.document.classes['profile::base']).toEqual({ ntp: 'b.pool' });
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        kind: 'CLASS_PARAMETER',
        key: 'profile::base.ntp',
        winningGroupName: 'Override',
        winningValue: 'b.pool',
        losingGroupName: 'Base',
        losingValue: 'a.pool',
      });
    });

    it('applies to top-scope parameters', () => {
      const result = mergeGroups([
        g({ id: 'a', parameters: { datacenter: 'dc1' } }),
        g({ id: 'b', parameters: { datacenter: 'dc2' } }),
      ]);
      expect(result.document.parameters).toEqual({ datacenter: 'dc2' });
      expect(result.conflicts[0]).toMatchObject({ kind: 'TOP_SCOPE_PARAMETER', key: 'datacenter' });
    });
  });

  // Re-setting a key to the same value is not a conflict; reporting it would
  // fill the UI with noise operators learn to ignore.
  it('does not report a conflict when the value is unchanged', () => {
    const result = mergeGroups([
      g({ id: 'a', parameters: { dc: 'dc1', tags: ['x', 'y'] } }),
      g({ id: 'b', parameters: { dc: 'dc1', tags: ['x', 'y'] } }),
    ]);
    expect(result.conflicts).toEqual([]);
  });

  describe('nested values are replaced wholesale, never deep-merged', () => {
    it('replaces a hash rather than merging its keys', () => {
      const result = mergeGroups([
        g({ id: 'a', classes: { 'profile::app': { cfg: { a: 1, b: 2 } } } }),
        g({ id: 'b', classes: { 'profile::app': { cfg: { b: 99 } } } }),
      ]);
      // Deep merge would yield { a: 1, b: 99 }. That is explicitly rejected —
      // it makes the effective value unreadable from any single group.
      expect(result.document.classes['profile::app']?.['cfg']).toEqual({ b: 99 });
    });

    it('replaces an array rather than concatenating', () => {
      const result = mergeGroups([
        g({ id: 'a', classes: { 'profile::app': { hosts: ['h1', 'h2'] } } }),
        g({ id: 'b', classes: { 'profile::app': { hosts: ['h3'] } } }),
      ]);
      expect(result.document.classes['profile::app']?.['hosts']).toEqual(['h3']);
    });
  });

  describe('environment', () => {
    it('takes the last non-null value', () => {
      const result = mergeGroups([
        g({ id: 'a', environment: 'production' }),
        g({ id: 'b', environment: 'staging' }),
      ]);
      expect(result.document.environment).toBe('staging');
      expect(result.conflicts[0]).toMatchObject({ kind: 'ENVIRONMENT' });
    });

    it('a group without an environment does not clear an earlier one', () => {
      const result = mergeGroups([
        g({ id: 'a', environment: 'production' }),
        g({ id: 'b', environment: null }),
      ]);
      expect(result.document.environment).toBe('production');
      expect(result.conflicts).toEqual([]);
    });

    it('omits the key entirely when no group sets one', () => {
      const result = mergeGroups([g({ id: 'a' })]);
      expect('environment' in result.document).toBe(false);
    });
  });

  it('records applied group ids in merge order for the "why?" view', () => {
    const result = mergeGroups([g({ id: 'first' }), g({ id: 'second' }), g({ id: 'third' })]);
    expect(result.appliedGroupIds).toEqual(['first', 'second', 'third']);
  });

  it('is deterministic: identical input yields identical output', () => {
    const input = [
      g({ id: 'a', classes: { 'profile::b': { x: 1 } }, parameters: { p: 'v' } }),
      g({ id: 'b', classes: { 'profile::a': { y: 2 } } }),
    ];
    expect(JSON.stringify(mergeGroups(input))).toBe(JSON.stringify(mergeGroups(input)));
  });
});
