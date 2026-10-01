import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLogSink, STALE_FOREIGN_FILE_MS } from './file-log-sink';

const dir = () => mkdtempSync(join(tmpdir(), 'np-logsink-'));

describe('FileLogSink', () => {
  it('appends one line per write, newline-terminated', () => {
    const directory = dir();
    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 1_000_000, keep: 2 });

    sink.write('{"a":1}');
    sink.write('{"a":2}');

    expect(readFileSync(join(directory, 'api-h1.log'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');
    expect(sink.state()).toMatchObject({ enabled: true, file: 'api-h1.log' });
  });

  it('continues an existing file rather than truncating it on restart', () => {
    const directory = dir();
    writeFileSync(join(directory, 'api-h1.log'), 'before\n');

    FileLogSink.open({ directory, host: 'h1', maxBytes: 1_000_000, keep: 2 }).write('after');

    expect(readFileSync(join(directory, 'api-h1.log'), 'utf8')).toBe('before\nafter\n');
  });

  /*
   * THE BOUND. Disk use must never exceed MAX_BYTES × (KEEP + 1), however much
   * is written — that is the promise that makes it safe to leave on.
   */
  it('rotates at the size limit and keeps exactly `keep` older generations', () => {
    const directory = dir();
    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 100, keep: 2 });
    const line = 'x'.repeat(39); // 40 bytes with the newline: two fit, three do not

    for (let i = 0; i < 50; i++) sink.write(line);

    const files = readdirSync(directory).sort();
    expect(files).toEqual(['api-h1.log', 'api-h1.log.1', 'api-h1.log.2']);
    for (const file of files) expect(statSync(join(directory, file)).size).toBeLessThanOrEqual(100);
  });

  it('keeps the newest lines in the live file and the oldest in the highest generation', () => {
    const directory = dir();
    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 64 * 2, keep: 1 });

    for (let i = 0; i < 6; i++) sink.write(`line-${String(i)}`.padEnd(63, '.'));

    expect(readFileSync(join(directory, 'api-h1.log'), 'utf8')).toContain('line-4');
    expect(readFileSync(join(directory, 'api-h1.log'), 'utf8')).toContain('line-5');
    expect(readFileSync(join(directory, 'api-h1.log.1'), 'utf8')).toContain('line-2');
    expect(existsSync(join(directory, 'api-h1.log.2'))).toBe(false);
  });

  it('with keep=0 simply starts the file again', () => {
    const directory = dir();
    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 100, keep: 0 });

    for (let i = 0; i < 10; i++) sink.write('y'.repeat(39));

    expect(readdirSync(directory)).toEqual(['api-h1.log']);
  });

  it('writes a line longer than the limit rather than dropping it', () => {
    const directory = dir();
    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 100, keep: 1 });

    sink.write('z'.repeat(500));

    expect(statSync(join(directory, 'api-h1.log')).size).toBe(501);
  });

  it('is off by configuration with maxBytes=0, silently and without creating anything', () => {
    const directory = dir();
    const stderr = jest.fn();
    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 0, keep: 5, stderr });

    sink.write('ignored');

    expect(readdirSync(directory)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    expect(sink.state()).toEqual({
      enabled: false,
      directory,
      reason: 'disabled by configuration (LOG_FILE_MAX_BYTES=0)',
    });
  });

  /*
   * NEVER THROWS, AND SAYS SO ONCE. A missing directory is the normal state of
   * a dev run and of an old compose file without the volume; the API must come
   * up, and the operator must be told exactly once rather than per line.
   */
  it('disables itself when the directory is missing, telling stderr once', () => {
    const stderr = jest.fn();
    const sink = FileLogSink.open({
      directory: '/nonexistent/nexuspuppet-logs',
      host: 'h1',
      maxBytes: 1000,
      keep: 1,
      stderr,
    });

    expect(() => {
      sink.write('a');
      sink.write('b');
    }).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toContain('ENOENT');
    expect(sink.state()).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('ENOENT'),
    });
  });

  it('disables itself when the directory is not writable', () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const directory = dir();
    chmodSync(directory, 0o500);
    const stderr = jest.fn();

    const sink = FileLogSink.open({ directory, host: 'h1', maxBytes: 1000, keep: 1, stderr });

    expect(sink.state()).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('EACCES'),
    });
    expect(stderr).toHaveBeenCalledTimes(1);
    chmodSync(directory, 0o700);
  });

  it('reopens when its file is deleted underneath it, instead of writing into the void', () => {
    const directory = dir();
    let now = 1_000_000;
    const sink = FileLogSink.open({
      directory,
      host: 'h1',
      maxBytes: 10_000,
      keep: 1,
      now: () => now,
    });
    sink.write('before');

    unlinkSync(join(directory, 'api-h1.log'));
    now += 61_000;
    sink.write('after');

    expect(readFileSync(join(directory, 'api-h1.log'), 'utf8')).toBe('after\n');
  });

  /*
   * A container's hostname is its id, so every redeploy leaves the previous
   * container's files behind with nobody to rotate them.
   */
  it("prunes other replicas' files that nobody has written for longer than any window", () => {
    const directory = dir();
    const now = Date.now();
    const old = (now - STALE_FOREIGN_FILE_MS - 60_000) / 1000;
    const recent = (now - 3_600_000) / 1000;

    for (const name of ['api-gone.log', 'api-gone.log.1', 'api-alive.log', 'unrelated.txt']) {
      writeFileSync(join(directory, name), 'x\n');
    }
    for (const name of ['api-gone.log', 'api-gone.log.1', 'unrelated.txt']) {
      utimesSync(join(directory, name), old, old);
    }
    utimesSync(join(directory, 'api-alive.log'), recent, recent);
    // Our own file, however old, is never pruned by this.
    writeFileSync(join(directory, 'api-me.log.3'), 'x\n');
    utimesSync(join(directory, 'api-me.log.3'), old, old);

    FileLogSink.open({ directory, host: 'me', maxBytes: 1000, keep: 5 });

    expect(readdirSync(directory).sort()).toEqual([
      'api-alive.log',
      'api-me.log',
      'api-me.log.3',
      'unrelated.txt',
    ]);
  });

  it('reports a never-opened sink as disabled with the reason given', () => {
    expect(FileLogSink.disabled('/var/log/x', 'not started').state()).toEqual({
      enabled: false,
      directory: '/var/log/x',
      reason: 'not started',
    });
  });
});
