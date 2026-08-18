import type { ResourceSummary } from '@nexuspuppet/contracts';
import { groupResources, MAX_CERTNAMES_PER_VARIANT } from './group-resources';

/*
 * The consistency view (ADR-0025 §7, §8).
 *
 * Every assertion here is about a NUMBER an operator reads and acts on. A
 * variant count that is wrong in the safe direction — reporting agreement that
 * does not exist — is the most dangerous way this feature can fail, because the
 * screen looks calm and the estate is not.
 */

const resource = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  certname: 'web01.example.com',
  type: 'File',
  title: '/etc/motd',
  file: '/etc/puppetlabs/code/.../base.pp',
  line: 12,
  environment: 'production',
  resourceHash: 'aaa',
  exported: false,
  tags: [],
  ...over,
});

describe('groupResources', () => {
  it('reports one variant when every node agrees', () => {
    const groups = groupResources([
      resource({ certname: 'a' }),
      resource({ certname: 'b' }),
      resource({ certname: 'c' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodeCount).toBe(3);
    expect(groups[0]?.variantCount).toBe(1);
  });

  /*
   * THE CASE THE SCREEN EXISTS FOR. Three nodes were hand-edited; 187 were not.
   */
  it('separates nodes whose parameters differ', () => {
    const rows = [
      ...Array.from({ length: 187 }, (_, i) =>
        resource({ certname: `ok${i}`, resourceHash: 'same' }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        resource({ certname: `bad${i}`, resourceHash: 'drift' }),
      ),
    ];

    const group = groupResources(rows)[0];

    expect(group?.nodeCount).toBe(190);
    expect(group?.variantCount).toBe(2);
    // Majority first: the baseline on top, the odd ones underneath it.
    expect(group?.variants[0]?.nodeCount).toBe(187);
    expect(group?.variants[1]?.nodeCount).toBe(3);
    expect(group?.variants[1]?.certnames).toEqual(['bad0', 'bad1', 'bad2']);
  });

  /*
   * §8, AND THE REASON THE SCREEN IS USABLE AT ALL. A development node and a
   * production node differing is not drift. Counting it as drift would flag
   * essentially every resource in a two-environment estate, and ADR-0021
   * already records where that ends: the channel gets muted and takes the
   * alert that mattered with it.
   */
  it('never counts variance ACROSS environments', () => {
    const groups = groupResources([
      resource({ certname: 'prod1', environment: 'production', resourceHash: 'p' }),
      resource({ certname: 'prod2', environment: 'production', resourceHash: 'p' }),
      resource({ certname: 'dev1', environment: 'development', resourceHash: 'd' }),
    ]);

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.variantCount).toBe(1);
    }
    expect(groups.map((g) => g.environment).sort()).toEqual(['development', 'production']);
  });

  it('still finds drift WITHIN one environment', () => {
    const groups = groupResources([
      resource({ certname: 'prod1', environment: 'production', resourceHash: 'p' }),
      resource({ certname: 'prod2', environment: 'production', resourceHash: 'DRIFT' }),
      resource({ certname: 'dev1', environment: 'development', resourceHash: 'd' }),
    ]);

    const production = groups.find((g) => g.environment === 'production');
    expect(production?.variantCount).toBe(2);
  });

  /*
   * INCONSISTENT FIRST. An operator scrolling past 190 agreeing rows to find
   * the one that disagrees is doing the work the console was supposed to do.
   */
  it('sorts inconsistent resources above consistent ones', () => {
    const groups = groupResources([
      resource({ title: '/etc/aaa-consistent', certname: 'a', resourceHash: 'x' }),
      resource({ title: '/etc/aaa-consistent', certname: 'b', resourceHash: 'x' }),
      resource({ title: '/etc/zzz-drifted', certname: 'a', resourceHash: 'y' }),
      resource({ title: '/etc/zzz-drifted', certname: 'b', resourceHash: 'z' }),
    ]);

    // Alphabetically last, but it is the one that matters — so it is first.
    expect(groups[0]?.title).toBe('/etc/zzz-drifted');
    expect(groups[0]?.variantCount).toBe(2);
  });

  /*
   * DETERMINISM. Two operators comparing notes must be shown the same
   * representative for a variant, or they will read different parameter values
   * for what the console told them was one configuration.
   */
  it('picks the same representative regardless of input order', () => {
    const rows = [
      resource({ certname: 'zeta', resourceHash: 'h' }),
      resource({ certname: 'alpha', resourceHash: 'h' }),
      resource({ certname: 'mike', resourceHash: 'h' }),
    ];

    const forward = groupResources(rows)[0]?.variants[0]?.sampleCertname;
    const reversed = groupResources([...rows].reverse())[0]?.variants[0]?.sampleCertname;

    expect(forward).toBe('alpha');
    expect(reversed).toBe('alpha');
  });

  /*
   * A variant covering four hundred nodes answers "which nodes" with its COUNT.
   * Listing all of them would push the whole estate into the browser to say
   * something the number already said.
   */
  it('caps the certname list but never the count', () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      resource({ certname: `node${String(i).padStart(3, '0')}`, resourceHash: 'h' }),
    );

    const variant = groupResources(rows)[0]?.variants[0];

    expect(variant?.nodeCount).toBe(400);
    expect(variant?.certnames).toHaveLength(MAX_CERTNAMES_PER_VARIANT);
  });

  it('groups resources of different types separately', () => {
    const groups = groupResources([
      resource({ type: 'File', title: 'shared-title' }),
      resource({ type: 'Package', title: 'shared-title' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  /*
   * A title containing the group separator must not be able to collide with a
   * different group. Tabs cannot appear in a type or an environment name, which
   * is why the key uses one.
   */
  it('cannot be confused by a title containing the key separator', () => {
    const groups = groupResources([
      resource({ title: 'a\tproduction', environment: 'production' }),
      resource({ title: 'a', environment: 'production\tb' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('returns nothing for no resources', () => {
    expect(groupResources([])).toEqual([]);
  });
});
