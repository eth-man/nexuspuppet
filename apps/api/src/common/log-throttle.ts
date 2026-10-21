/**
 * At most `limit` lines per window, and a count of what was swallowed.
 *
 * For log lines an unauthenticated caller can cause. The login limiter keys on
 * `${ip}|${email}`, so varying the address buys a fresh bucket per request; a
 * line written once per refused sign-in is then a line a stranger can write as
 * often as they like. A log that can be driven by a stranger is a disk-full
 * incident with extra steps.
 *
 * Several lines per window rather than one: an operator trying two or three
 * people in a row, to see why each is refused, must see every reason. The
 * suppressed count rides on the next line that is written, so the throttle
 * reports a flood instead of hiding one.
 */
export class LogThrottle {
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private written = 0;
  private suppressed = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Write `line` through `write` if this window has room, with the count of
   * lines swallowed since the last one appended.
   */
  emit(write: (line: string) => void, line: string): void {
    const now = this.now();
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.written = 0;
    }

    if (this.written >= this.limit) {
      this.suppressed += 1;
      return;
    }

    this.written += 1;
    const swallowed = this.suppressed > 0 ? ` (${String(this.suppressed)} similar suppressed)` : '';
    this.suppressed = 0;
    write(`${line}${swallowed}`);
  }
}

/** A logger whose every line goes through one shared throttle. */
export function throttledLogger(
  logger: { log(m: string): void; warn(m: string): void; error(m: string): void },
  throttle: LogThrottle,
): { log(m: string): void; warn(m: string): void; error(m: string): void } {
  return {
    log: (m) => throttle.emit((line) => logger.log(line), m),
    warn: (m) => throttle.emit((line) => logger.warn(line), m),
    error: (m) => throttle.emit((line) => logger.error(line), m),
  };
}
