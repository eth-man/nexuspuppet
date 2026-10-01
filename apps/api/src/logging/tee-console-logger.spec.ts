import { Logger } from '@nestjs/common';
import { levelsFor } from '../system/pure/log-levels';
import { TeeConsoleLogger, type LogLineSink } from './tee-console-logger';

class MemorySink implements LogLineSink {
  readonly host = 'h1';
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  records(): Array<Record<string, unknown>> {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe('TeeConsoleLogger', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('still prints to stdout exactly as ConsoleLogger does', () => {
    const logger = new TeeConsoleLogger(new MemorySink());
    logger.log('hello', 'Ctx');

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(String(stdout.mock.calls[0]?.[0])).toContain('hello');
  });

  it('writes one JSON record per message, without colour', () => {
    const sink = new MemorySink();
    const logger = new TeeConsoleLogger(sink);

    logger.warn('PuppetDB unreachable', 'NodeProjection');

    const [record] = sink.records();
    expect(record).toMatchObject({
      level: 'warn',
      context: 'NodeProjection',
      message: 'PuppetDB unreachable',
      pid: process.pid,
      host: 'h1',
    });
    expect(record?.['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(sink.lines[0]).not.toContain('\u001b');
  });

  /*
   * THE FILE RECORDS WHAT STDOUT RECORDS. An operator who raises the level to
   * debug, reproduces, and downloads a bundle must find the debug lines in it
   * — and one who lowers it must not find lines stdout never showed.
   */
  it('honours the live level, including changes after construction', () => {
    const sink = new MemorySink();
    const logger = new TeeConsoleLogger(sink);

    logger.setLogLevels(levelsFor('warn'));
    logger.log('info line', 'C');
    logger.debug('debug line', 'C');
    logger.warn('warn line', 'C');

    logger.setLogLevels(levelsFor('debug'));
    logger.debug('now visible', 'C');

    expect(sink.records().map((r) => r['message'])).toEqual(['warn line', 'now visible']);
    // Every line in the file was also on stdout, and nothing else was.
    expect(stdout).toHaveBeenCalledTimes(2);
  });

  it('carries the stack of a logged error', () => {
    const sink = new MemorySink();
    const logger = new TeeConsoleLogger(sink);

    logger.error('it broke', 'Error: it broke\n    at somewhere (file.ts:1:1)', 'Ctx');

    expect(sink.records()[0]).toMatchObject({
      level: 'error',
      message: 'it broke',
      context: 'Ctx',
      stack: 'Error: it broke\n    at somewhere (file.ts:1:1)',
    });
  });

  it('renders objects as text rather than [object Object]', () => {
    const sink = new MemorySink();
    new TeeConsoleLogger(sink).log({ nodes: 3 }, 'Ctx');

    expect(sink.records()[0]?.['message']).toBe('{ nodes: 3 }');
  });

  it('is what Nest Logger instances write through once installed', () => {
    const sink = new MemorySink();
    Logger.overrideLogger(new TeeConsoleLogger(sink));
    try {
      new Logger('SomeService').log('through the static logger');
    } finally {
      Logger.overrideLogger(false);
      Logger.overrideLogger(true);
    }

    expect(sink.records()[0]).toMatchObject({
      context: 'SomeService',
      message: 'through the static logger',
    });
  });

  it('never lets a failing sink break logging', () => {
    const logger = new TeeConsoleLogger({
      host: 'h1',
      write: () => {
        throw new Error('disk on fire');
      },
    });

    expect(() => logger.log('still fine', 'C')).not.toThrow();
    expect(stdout).toHaveBeenCalled();
  });
});
