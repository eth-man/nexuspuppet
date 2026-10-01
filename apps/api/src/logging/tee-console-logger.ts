import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { inspect } from 'node:util';
import { formatRecord } from './pure/log-record';

/** The one thing the logger needs from a sink. */
export interface LogLineSink {
  readonly host: string;
  write(line: string): void;
}

/**
 * Nest's ConsoleLogger, unchanged on stdout, with every printed line ALSO
 * written to the local log history (ADR-0028).
 *
 * A SUBCLASS, not a wrapper, so main.ts's live level mechanism keeps working
 * exactly as before: `setLogLevels()` is inherited, and Nest only reaches
 * `printMessages` for a level that is enabled. The file therefore records what
 * stdout records — never more, never less — which is what makes "raise the
 * level to debug, reproduce, download a bundle" behave the way it reads.
 */
export class TeeConsoleLogger extends ConsoleLogger {
  constructor(private readonly sink: LogLineSink) {
    super();
  }

  protected override printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    super.printMessages(messages, context, logLevel, writeStreamType, errorStack);

    // Never allowed to break logging to stdout, which has already happened.
    try {
      const ts = new Date().toISOString();
      for (const message of messages) {
        this.sink.write(
          formatRecord({
            ts,
            level: logLevel,
            context,
            message: plain(message),
            pid: process.pid,
            host: this.sink.host,
            ...(typeof errorStack === 'string' && errorStack !== '' ? { stack: errorStack } : {}),
          }),
        );
      }
    } catch {
      // The sink disables itself on its own failures; this guards formatting.
    }
  }
}

/** The message as text, without colour — the file is read by people, later. */
function plain(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.stack ?? message.message;
  // Nest prints a class by its name and CALLS a plain function; calling it a
  // second time here could repeat a side effect, so both are named instead.
  if (typeof message === 'function') return `[${message.name || 'function'}]`;
  return inspect(message, { colors: false, depth: 5, breakLength: Infinity });
}
