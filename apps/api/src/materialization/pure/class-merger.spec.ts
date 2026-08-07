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

describe('attribution (#141)', () => {
  const group = (
    id: string,
    over: Partial<{
      classes: Record<string, Record<string, unknown>>;
      parameters: Record<string, unknown>;
      environment: string | null;
    }> = {},
  ) =>
    ({
      id,
      name: `group-${id}`,
      environment: over.environment ?? null,
      classes: over.classes ?? {},
      parameters: over.parameters ?? {},
    }) as Parameters<typeof mergeGroups>[0][number];

  it('names every group that included a class, because inclusion is a union', () => {
    const result = mergeGroups([
      group('a', { classes: { 'profile::base': {} } }),
      group('b', { classes: { 'profile::base': {} } }),
      group('c', { classes: { 'profile::db': {} } }),
    ]);

    // Both contributed; neither lost (ADR-0009 — class inclusion is a union).
    expect(result.attribution.classes['profile::base']).toEqual(['a', 'b']);
    expect(result.attribution.classes['profile::db']).toEqual(['c']);
  });

  it('names the group whose class parameter won', () => {
    const result = mergeGroups([
      group('a', { classes: { 'profile::db': { port: 5432 } } }),
      group('b', { classes: { 'profile::db': { port: 6543 } } }),
    ]);

    expect(result.attribution.classParameters['profile::db.port']?.groupId).toBe('b');
    expect(result.attribution.classParameters['profile::db.port']?.overridden).toEqual([
      { groupId: 'a', value: 5432 },
    ]);
  });

  /*
   * THE CASE CONFLICTS MISS, and the reason attribution is not just a rename of
   * the conflict list. Two groups setting the SAME value produce no conflict —
   * nothing disagreed — but the earlier group did still set it, and answering
   * "who set this?" with only the winner would be a half-truth.
   */
  it('records an override even when the values were identical', () => {
    const result = mergeGroups([
      group('a', { parameters: { tier: 'gold' } }),
      group('b', { parameters: { tier: 'gold' } }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.attribution.parameters['tier']).toEqual({
      groupId: 'b',
      overridden: [{ groupId: 'a', value: 'gold' }],
    });
  });

  it('accumulates every loser, not just the last one', () => {
    const result = mergeGroups([
      group('a', { parameters: { tier: 1 } }),
      group('b', { parameters: { tier: 2 } }),
      group('c', { parameters: { tier: 3 } }),
      group('d', { parameters: { tier: 4 } }),
    ]);

    expect(result.attribution.parameters['tier']?.groupId).toBe('d');
    expect(result.attribution.parameters['tier']?.overridden.map((o) => o.groupId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('leaves overridden empty when exactly one group set a key', () => {
    const result = mergeGroups([group('a', { parameters: { tier: 'gold' } })]);

    expect(result.attribution.parameters['tier']).toEqual({ groupId: 'a', overridden: [] });
  });

  it('attributes the environment, and what it displaced', () => {
    const result = mergeGroups([
      group('a', { environment: 'staging' }),
      group('b', { environment: 'production' }),
    ]);

    expect(result.attribution.environment).toEqual({
      groupId: 'b',
      overridden: [{ groupId: 'a', value: 'staging' }],
    });
  });

  it('does not attribute an environment no group set', () => {
    expect(mergeGroups([group('a', { parameters: { x: 1 } })]).attribution.environment).toBeNull();
  });

  /*
   * A group with no environment does not clear an earlier one, so it must not
   * appear as having overridden it either — the attribution has to agree with
   * the merge rule rather than restate the group order.
   */
  it('ignores a group that sets no environment', () => {
    const result = mergeGroups([
      group('a', { environment: 'production' }),
      group('b', { environment: null }),
    ]);

    expect(result.attribution.environment).toEqual({ groupId: 'a', overridden: [] });
  });

  it('is empty for a node that matched nothing', () => {
    expect(mergeGroups([]).attribution).toEqual({
      classes: {},
      classParameters: {},
      parameters: {},
      environment: null,
    });
  });

  it('does not list the same group twice for a class', () => {
    const result = mergeGroups([group('a', { classes: { 'profile::base': { x: 1 } } })]);

    expect(result.attribution.classes['profile::base']).toEqual(['a']);
  });
});
