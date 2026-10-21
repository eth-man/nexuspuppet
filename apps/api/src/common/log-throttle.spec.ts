import { LogThrottle, throttledLogger } from './log-throttle';

describe('LogThrottle', () => {
  it('writes up to the limit per window, then counts what it swallows onto the next line', () => {
    let now = 0;
    const throttle = new LogThrottle(2, 1000, () => now);
    const out: string[] = [];
    const write = (line: string): void => {
      out.push(line);
    };

    throttle.emit(write, 'a');
    throttle.emit(write, 'b');
    throttle.emit(write, 'c');
    throttle.emit(write, 'd');
    expect(out).toEqual(['a', 'b']);

    now = 1000;
    throttle.emit(write, 'e');
    expect(out).toEqual(['a', 'b', 'e (2 similar suppressed)']);
  });

  it('shares one throttle across every level of a throttled logger', () => {
    const throttle = new LogThrottle(2, 60_000, () => 0);
    const seen: string[] = [];
    const logger = throttledLogger(
      {
        log: (m) => seen.push(`log ${m}`),
        warn: (m) => seen.push(`warn ${m}`),
        error: (m) => seen.push(`error ${m}`),
      },
      throttle,
    );

    logger.log('1');
    logger.warn('2');
    logger.error('3');

    expect(seen).toEqual(['log 1', 'warn 2']);
  });
});
