import { formatRecord } from '../../logging/pure/log-record';
import { capOldestFirst, selectWindow, type HostLog } from './log-window';

const line = (ts: string, message = 'm', host = 'h') =>
  formatRecord({ ts, level: 'log', context: 'C', message, pid: 1, host });

const host = (name: string, stamps: string[], message = 'm'): HostLog => ({
  host: name,
  lines: stamps.map((ts) => ({ ts, text: line(ts, message, name) })),
  files: [],
  earliestOnDisk: stamps[0] ?? null,
  latestOnDisk: stamps[stamps.length - 1] ?? null,
  unparseable: 0,
});

describe('selectWindow', () => {
  const content = [
    line('2026-09-29T10:00:00.000Z', 'before'),
    line('2026-09-29T12:00:00.000Z', 'at start'),
    line('2026-09-30T06:00:00.000Z', 'inside'),
    '[Nest] a stray non-record line',
    line('2026-09-30T12:00:00.000Z', 'at end'),
    line('2026-09-30T12:00:00.001Z', 'after'),
    '{"ts":"2026-09-30T12:00:01.000Z","lev', // torn by a crash
    '',
  ].join('\n');

  const selected = selectWindow(content, '2026-09-29T12:00:00.000Z', '2026-09-30T12:00:00.000Z');

  it('keeps lines in the inclusive window, in file order', () => {
    expect(selected.lines.map((l) => JSON.parse(l.text).message)).toEqual([
      'at start',
      'inside',
      'at end',
    ]);
  });

  it('reports the extent of the file, in or out of window', () => {
    expect(selected.earliestOnDisk).toBe('2026-09-29T10:00:00.000Z');
    expect(selected.latestOnDisk).toBe('2026-09-30T12:00:00.001Z');
  });

  it('counts non-records instead of guessing at them', () => {
    expect(selected.unparseable).toBe(2);
  });

  it('handles an empty file', () => {
    expect(selectWindow('', 'a', 'b')).toEqual({
      lines: [],
      earliestOnDisk: null,
      latestOnDisk: null,
      unparseable: 0,
    });
  });
});

describe('capOldestFirst', () => {
  it('changes nothing under the cap', () => {
    const hosts = [host('a', ['2026-09-30T01:00:00.000Z'])];
    const result = capOldestFirst(hosts, 1_000_000);

    expect(result.hosts).toEqual(hosts);
    expect(result).toMatchObject({ droppedLines: 0, droppedBytes: 0, keptFrom: null });
  });

  /*
   * Across replicas, oldest first: the busy replica's last hour must survive
   * even if the quiet one's lines are older and fewer.
   */
  it('drops the globally oldest lines across every replica', () => {
    const hosts = [
      host('aaaa', [
        '2026-09-30T10:00:00.000Z',
        '2026-09-30T11:00:00.000Z',
        '2026-09-30T12:00:00.000Z',
      ]),
      host('bbbb', ['2026-09-29T00:00:00.000Z', '2026-09-30T11:30:00.000Z']),
    ];
    const one = Buffer.byteLength(hosts[0]?.lines[0]?.text ?? '') + 1;

    const result = capOldestFirst(hosts, one * 3);

    expect(result.hosts.map((h) => h.lines.map((l) => l.ts))).toEqual([
      ['2026-09-30T11:00:00.000Z', '2026-09-30T12:00:00.000Z'],
      ['2026-09-30T11:30:00.000Z'],
    ]);
    expect(result.droppedLines).toBe(2);
    expect(result.droppedBytes).toBe(one * 2);
    expect(result.keptFrom).toBe('2026-09-30T11:00:00.000Z');
  });

  it('stops at the first line that does not fit rather than leaving a hole', () => {
    const big = host('a', ['2026-09-30T11:00:00.000Z'], 'x'.repeat(500));
    const small = host('b', ['2026-09-30T10:00:00.000Z', '2026-09-30T12:00:00.000Z']);
    const smallBytes = Buffer.byteLength(small.lines[0]?.text ?? '') + 1;

    const result = capOldestFirst([big, small], smallBytes * 2);

    // The 11:00 line is too big; the OLDER 10:00 line would fit but is dropped
    // with it, so what remains is a contiguous stretch ending now.
    expect(result.hosts.map((h) => h.lines.map((l) => l.ts))).toEqual([
      [],
      ['2026-09-30T12:00:00.000Z'],
    ]);
    expect(result.keptFrom).toBe('2026-09-30T12:00:00.000Z');
  });

  it('keeps nothing, and says so, when not even the newest line fits', () => {
    const result = capOldestFirst([host('a', ['2026-09-30T12:00:00.000Z'])], 10);
    expect(result.hosts[0]?.lines).toEqual([]);
    expect(result).toMatchObject({ droppedLines: 1, keptFrom: null });
  });
});
