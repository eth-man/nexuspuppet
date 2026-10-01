import { EventEmitter } from 'node:events';
import { captureProcessOutput, record } from './process-capture';
import type { LogLineSink } from './tee-console-logger';

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

describe('captureProcessOutput', () => {
  let proc: EventEmitter;
  let sink: MemorySink;

  beforeEach(() => {
    proc = new EventEmitter();
    sink = new MemorySink();
    captureProcessOutput(sink, proc);
  });

  it('records a Node warning, which never passes through the logger', () => {
    const warning = new Error(
      'Calling client.query() when the client is already executing a query is deprecated',
    );
    warning.name = 'DeprecationWarning';

    proc.emit('warning', warning);

    expect(sink.records()).toEqual([
      expect.objectContaining({
        level: 'warn',
        context: 'Process',
        message:
          'DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated',
        host: 'h1',
        stack: expect.stringContaining('DeprecationWarning') as unknown,
      }),
    ]);
  });

  it('records the crash with its stack and where it came from', () => {
    const error = new Error('boom');

    proc.emit('uncaughtExceptionMonitor', error, 'unhandledRejection');

    const [line] = sink.records();
    expect(line).toMatchObject({
      level: 'fatal',
      context: 'Process',
      message: 'unhandledRejection: boom',
    });
    expect(line?.['stack']).toContain('Error: boom');
  });

  it('records a thrown non-Error without a stack', () => {
    proc.emit('uncaughtExceptionMonitor', 'a string', 'uncaughtException');

    const [line] = sink.records();
    expect(line).toMatchObject({ message: 'uncaughtException: a string' });
    expect(line).not.toHaveProperty('stack');
  });

  it('observes the crash rather than handling it', () => {
    // A listener on `uncaughtException` would stop Node exiting. Only the
    // monitor may be used, so the process still dies as it did before.
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1);
  });

  it('writes lines the support bundle can read: ts first, ISO, UTC', () => {
    proc.emit('warning', new Error('w'));

    expect(sink.lines[0]).toMatch(/^\{"ts":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);
  });

  it('never turns a failing sink into a second crash', () => {
    const broken: LogLineSink = {
      host: 'h1',
      write: () => {
        throw new Error('disk gone');
      },
    };

    expect(() => {
      record(broken, 'fatal', 'x', undefined);
    }).not.toThrow();
  });
});
