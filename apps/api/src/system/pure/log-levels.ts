import type { LogLevel } from '@nestjs/common';

/**
 * A configured level to the set of Nest levels it enables.
 *
 * Pure, and extracted from main.ts so that the level applied at boot and the
 * level applied later by an operator come from the SAME mapping. Two copies
 * would eventually disagree, and the symptom — "debug shows different things
 * depending on whether you set it before or after start" — is one nobody would
 * guess at.
 *
 * Nest takes a LIST of enabled levels rather than a threshold, so this encodes
 * the ordering: choosing `warn` means warn and error, never warn alone.
 */
export const CONFIGURABLE_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type ConfiguredLogLevel = (typeof CONFIGURABLE_LEVELS)[number];

export function isConfiguredLogLevel(value: unknown): value is ConfiguredLogLevel {
  return typeof value === 'string' && (CONFIGURABLE_LEVELS as readonly string[]).includes(value);
}

/**
 * `verbose` and `fatal` are deliberately absent from the configurable set.
 *
 * `verbose` is noisier than `debug` and nothing in this codebase emits it;
 * offering it would be a control that appears to do nothing. `fatal` above
 * `error` would let an operator hide the errors that matter.
 */
export function levelsFor(level: ConfiguredLogLevel): LogLevel[] {
  switch (level) {
    case 'debug':
      return ['debug', 'log', 'warn', 'error'];
    case 'info':
      return ['log', 'warn', 'error'];
    case 'warn':
      return ['warn', 'error'];
    case 'error':
      return ['error'];
  }
}
