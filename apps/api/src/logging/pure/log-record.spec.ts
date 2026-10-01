import {
  formatRecord,
  lineTimestamp,
  logFileName,
  parseLogFileName,
  safeHost,
  stripAnsi,
} from './log-record';

const record = {
  ts: '2026-09-30T12:00:00.000Z',
  level: 'warn',
  context: 'NodeProjection',
  message: 'PuppetDB unreachable',
  pid: 1,
  host: 'abc123',
};

describe('log records', () => {
  it('puts ts first so the reader can take it without parsing', () => {
    expect(formatRecord(record).startsWith('{"ts":"2026-09-30T12:00:00.000Z"')).toBe(true);
  });

  it('round-trips through JSON with every field', () => {
    expect(JSON.parse(formatRecord({ ...record, stack: 'Error: x\n    at y' }))).toEqual({
      ...record,
      stack: 'Error: x\n    at y',
    });
  });

  it('strips colour codes from message, context and stack', () => {
    const line = formatRecord({
      ...record,
      context: '\u001b[38;5;3mCtx\u001b[39m',
      message: '\u001b[33mhello\u001b[39m',
      stack: '\u001b[31mboom\u001b[39m',
    });
    expect(line).not.toContain('\u001b');
    expect(JSON.parse(line)).toMatchObject({ context: 'Ctx', message: 'hello', stack: 'boom' });
  });

  it('stripAnsi leaves ordinary text alone', () => {
    expect(stripAnsi('plain [not a code] text')).toBe('plain [not a code] text');
  });

  describe('lineTimestamp', () => {
    it('reads the fast path', () => {
      expect(lineTimestamp(formatRecord(record))).toBe('2026-09-30T12:00:00.000Z');
    });

    it('falls back to parsing when ts is not first', () => {
      expect(lineTimestamp('{"level":"log","ts":"2026-09-30T12:00:00.000Z"}')).toBe(
        '2026-09-30T12:00:00.000Z',
      );
    });

    it('rejects a torn line, non-JSON, and a malformed timestamp', () => {
      expect(lineTimestamp('{"ts":"2026-09-30T12:00:00.000Z","level":"lo')).toBeNull();
      expect(lineTimestamp('[Nest] 1 - 09/30/2026 LOG hello')).toBeNull();
      expect(lineTimestamp('{"ts":"yesterday"}')).toBeNull();
      expect(lineTimestamp('{"no":"ts"}')).toBeNull();
      expect(lineTimestamp('null')).toBeNull();
    });
  });

  describe('file names', () => {
    it('names and parses the live file and its rotations', () => {
      expect(logFileName('abc123')).toBe('api-abc123.log');
      expect(parseLogFileName('api-abc123.log')).toEqual({ host: 'abc123', generation: 0 });
      expect(parseLogFileName('api-abc123.log.4')).toEqual({ host: 'abc123', generation: 4 });
      expect(parseLogFileName('api-web.example.com.log.1')).toEqual({
        host: 'web.example.com',
        generation: 1,
      });
    });

    it('ignores anything that is not ours', () => {
      for (const name of [
        'api.log',
        'other-abc.log',
        'api-abc.log.gz',
        'api-abc.log.x',
        '.api-a.log',
      ]) {
        expect(parseLogFileName(name)).toBeNull();
      }
    });

    it('makes any hostname safe for a filename and a tar header', () => {
      expect(safeHost('a/b c')).toBe('a_b_c');
      expect(safeHost('')).toBe('unknown');
      expect(safeHost('x'.repeat(200))).toHaveLength(64);
      expect(parseLogFileName(logFileName('../../etc'))).toEqual({
        host: '.._.._etc',
        generation: 0,
      });
    });
  });
});
