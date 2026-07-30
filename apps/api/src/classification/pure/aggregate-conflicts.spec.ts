import type { ClassificationConflict } from '@nexuspuppet/contracts';
import { aggregateConflicts, type NodeConflicts } from './aggregate-conflicts';

const conflict = (over: Partial<ClassificationConflict> = {}): ClassificationConflict => ({
  kind: 'CLASS_PARAMETER',
  key: 'profile::base.ntp_servers',
  winningGroupId: 'g-web',
  winningGroupName: 'web-tier',
  winningValue: ['ntp1'],
  losingGroupId: 'g-base',
  losingGroupName: 'base-linux',
  losingValue: ['ntp0'],
  ...over,
});

const node = (certname: string, conflicts: ClassificationConflict[]): NodeConflicts => ({
  certname,
  conflicts,
});

describe('aggregateConflicts', () => {
  it('collapses the same override across nodes into one row with a count', () => {
    const rows = ['a', 'b', 'c'].map((n) => node(n, [conflict()]));

    const [row, ...rest] = aggregateConflicts(rows);

    expect(rest).toEqual([]);
    expect(row?.nodeCount).toBe(3);
    expect(row?.key).toBe('profile::base.ntp_servers');
    expect(row?.winningGroupName).toBe('web-tier');
    expect(row?.losingGroupName).toBe('base-linux');
  });

  it('groups by winner AND loser, not by key alone', () => {
    // Two different groups overriding the same parameter are two different
    // facts about the configuration, and fixing one does not fix the other.
    const rows = [
      node('a', [conflict()]),
      node('b', [conflict({ winningGroupId: 'g-db', winningGroupName: 'db-tier' })]),
    ];

    expect(aggregateConflicts(rows)).toHaveLength(2);
  });

  it('ignores differing VALUES when grouping', () => {
    // The same override with a per-node winning value is one misconfiguration.
    // Splitting by value would turn it into dozens of rows and bury it.
    const rows = [
      node('a', [conflict({ winningValue: ['one'] })]),
      node('b', [conflict({ winningValue: ['two'] })]),
    ];

    const result = aggregateConflicts(rows);

    expect(result).toHaveLength(1);
    expect(result[0]?.nodeCount).toBe(2);
  });

  it('counts a node once even if it reports the same override twice', () => {
    const rows = [node('a', [conflict(), conflict()])];

    expect(aggregateConflicts(rows)[0]?.nodeCount).toBe(1);
  });

  it('puts ENVIRONMENT conflicts first, however few nodes they touch', () => {
    // The asymmetry that ordering by count alone would hide: environment
    // decides which branch of the control repo a machine runs, so three nodes
    // disagreeing about it outranks three hundred disagreeing about a timeout.
    const rows = [
      ...Array.from({ length: 300 }, (_, i) => node(`bulk${i}`, [conflict()])),
      node('x', [conflict({ kind: 'ENVIRONMENT', key: 'environment' })]),
    ];

    const result = aggregateConflicts(rows);

    expect(result[0]?.kind).toBe('ENVIRONMENT');
    expect(result[0]?.nodeCount).toBe(1);
    expect(result[1]?.nodeCount).toBe(300);
  });

  it('orders the rest by breadth', () => {
    const rows = [
      node('a', [conflict({ key: 'narrow' })]),
      ...['b', 'c', 'd'].map((n) => node(n, [conflict({ key: 'wide' })])),
    ];

    expect(aggregateConflicts(rows).map((c) => c.key)).toEqual(['wide', 'narrow']);
  });

  it('is deterministic when counts tie, so the report does not reshuffle', () => {
    const rows = [node('a', [conflict({ key: 'zebra' })]), node('b', [conflict({ key: 'alpha' })])];

    const once = aggregateConflicts(rows).map((c) => c.key);
    const twice = aggregateConflicts([...rows].reverse()).map((c) => c.key);

    expect(once).toEqual(['alpha', 'zebra']);
    expect(twice).toEqual(once);
  });

  it('caps examples but keeps counting past the cap', () => {
    const rows = Array.from({ length: 40 }, (_, i) => node(`n${i}`, [conflict()]));

    const [row] = aggregateConflicts(rows);

    expect(row?.nodeCount).toBe(40);
    expect(row?.exampleCertnames).toHaveLength(5);
    expect(row?.exampleCertnames[0]).toBe('n0');
  });

  it('returns nothing for an estate with no conflicts', () => {
    expect(aggregateConflicts([node('a', []), node('b', [])])).toEqual([]);
    expect(aggregateConflicts([])).toEqual([]);
  });
});
