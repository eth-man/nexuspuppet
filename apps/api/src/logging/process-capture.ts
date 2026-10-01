import type { EventEmitter } from 'node:events';
import { formatRecord } from './pure/log-record';
import type { LogLineSink } from './tee-console-logger';

/**
 * Copy what Node itself writes to stderr into the local log history
 * (ADR-0028), without changing what Node does.
 *
 * The file is fed by TeeConsoleLogger, so it only ever saw lines that went
 * through Nest's logger. Node's own output does not: a runtime warning, and —
 * the one support actually needs — the stack trace of the crash that killed
 * the process. Found by comparing a real bundle from staging with `docker
 * logs` of the same container: 122 of 124 lines matched, and the two missing
 * were Node's DeprecationWarning, printed by Node straight to stderr.
 *
 * OBSERVE, NEVER HANDLE. `warning` listeners leave Node's default printing in
 * place, and `uncaughtExceptionMonitor` exists precisely to see a fatal error
 * before Node's default handling runs — printing the stack and exiting
 * non-zero, exactly as today. Listening to `uncaughtException` instead would
 * suppress the exit and leave a broken process serving requests. The sink
 * writes synchronously, so the line is on disk before the process is gone.
 *
 * Raw `console.*` from dependencies is still not captured; nothing in the API
 * writes that way except the bootstrap-failure path, which main.ts copies
 * explicitly.
 */
export function captureProcessOutput(sink: LogLineSink, proc: EventEmitter = process): void {
  proc.on('warning', (warning: Error) => {
    record(sink, 'warn', `${warning.name}: ${warning.message}`, warning.stack);
  });

  proc.on('uncaughtExceptionMonitor', (error: unknown, origin: string) => {
    const message = error instanceof Error ? error.message : String(error);
    record(
      sink,
      'fatal',
      `${origin}: ${message}`,
      error instanceof Error ? error.stack : undefined,
    );
  });
}

/** One line in the file, in the same shape the logger writes. */
export function record(
  sink: LogLineSink,
  level: 'warn' | 'fatal',
  message: string,
  stack: string | undefined,
): void {
  // Never allowed to turn a warning — or a crash — into a different crash.
  try {
    sink.write(
      formatRecord({
        ts: new Date().toISOString(),
        level,
        context: 'Process',
        message,
        pid: process.pid,
        host: sink.host,
        ...(stack === undefined || stack === '' ? {} : { stack }),
      }),
    );
  } catch {
    // The sink disables itself on its own failures; this guards formatting.
  }
}
