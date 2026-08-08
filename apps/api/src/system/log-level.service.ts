import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isConfiguredLogLevel, levelsFor, type ConfiguredLogLevel } from './pure/log-levels';

/**
 * The log level, changeable without a restart.
 *
 * `LOG_LEVEL` was read once by `loadEnv()` and baked into
 * `NestFactory.create({ logger })`, so changing it meant restarting the API —
 * which is the one thing an operator cannot do while diagnosing the incident
 * that made them want debug logging.
 *
 * SURVIVES MULTIPLE REPLICAS, which is the whole difficulty. A per-process
 * variable would leave one replica at debug and the others at info, and an
 * operator watching an aggregated log would see it half work. So the value is
 * stored, and every replica re-reads it on a timer — the same shape
 * `RoleRegistry` uses for permissions, and for the same reason: a change made
 * on one replica has to reach the others without a restart or a message bus.
 */

export const LOG_LEVEL_KEY = 'log.level';

/** How long a change takes to reach another replica. */
export const REFRESH_INTERVAL_MS = 15_000;

@Injectable()
export class LogLevelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogLevelService.name);
  private timer: NodeJS.Timeout | undefined;
  private applied: ConfiguredLogLevel;
  /**
   * Tracked, not inferred.
   *
   * Comparing the applied value to the environment's would report a STORED
   * level as coming from the environment whenever the two happen to be equal —
   * so the console would tell an operator their saved setting was not in
   * effect, while it was.
   */
  private appliedSource: 'environment' | 'database' = 'environment';

  constructor(
    private readonly prisma: PrismaService,
    /** The boot value. Also the fallback whenever nothing is stored. */
    private readonly fromEnvironment: ConfiguredLogLevel,
    /**
     * Applies the level to the running logger.
     *
     * Optional at construction and supplied by `bind()` from main.ts, because
     * the logger instance belongs to bootstrap and the DI container is built
     * after it. A service holding the Nest app would not be unit-testable; a
     * service holding a one-line callback is.
     */
    private apply: (level: ConfiguredLogLevel) => void = () => undefined,
    /**
     * True when `SETTINGS_SOURCE=env`, in which case a stored value is ignored
     * entirely (ADR-0016 §2). That escape hatch exists so an operator can
     * always override the console from the host — and a log level saved by
     * somebody else is exactly the kind of thing they may need to override.
     */
    private readonly environmentWins: boolean,
    private readonly refreshIntervalMs: number = REFRESH_INTERVAL_MS,
  ) {
    this.applied = fromEnvironment;
  }

  /**
   * Supply the applier, and immediately honour whatever is already stored.
   *
   * Called from bootstrap before the app listens, so a deployment whose stored
   * level differs from its environment starts at the stored one rather than
   * spending its first refresh interval at the wrong level.
   */
  bind(apply: (level: ConfiguredLogLevel) => void): void {
    this.apply = apply;
    apply(this.applied);
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();

    if (this.environmentWins || this.refreshIntervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        // Keep the current level rather than falling back. A database blip
        // must not silently turn an operator's debug logging back off in the
        // middle of the incident they turned it on for.
        this.logger.warn(`Could not refresh the log level: ${describe(error)}`);
      });
    }, this.refreshIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /** The level in force, and where it came from. */
  describe(): { level: ConfiguredLogLevel; source: 'environment' | 'database'; locked: boolean } {
    return {
      level: this.applied,
      source: this.appliedSource,
      // SETTINGS_SOURCE=env: the console must say the control is inert rather
      // than accept a change that will never take effect.
      locked: this.environmentWins,
    };
  }

  async set(level: ConfiguredLogLevel): Promise<void> {
    await this.prisma.appSetting.upsert({
      where: { key: LOG_LEVEL_KEY },
      create: { key: LOG_LEVEL_KEY, value: { level } },
      update: { value: { level } },
    });

    // Applied here as well as by the timer, so the replica handling the
    // request reflects the change immediately rather than up to one refresh
    // later. The others catch up on their own.
    await this.refresh();
  }

  /** Return to the environment's value by removing the stored one. */
  async clear(): Promise<void> {
    await this.prisma.appSetting.deleteMany({ where: { key: LOG_LEVEL_KEY } });
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const resolved = this.environmentWins
      ? { level: this.fromEnvironment, source: 'environment' as const }
      : await this.stored();

    this.appliedSource = resolved.source;
    if (resolved.level === this.applied) return;

    this.apply(resolved.level);
    this.applied = resolved.level;

    /*
     * Logged at WARN deliberately. A level change is exactly the kind of thing
     * that gets left on after an incident, and at `error` this notice would be
     * the one message an operator does not see explaining why their logs are
     * empty.
     */
    this.logger.warn(`Log level is now "${resolved.level}".`);
  }

  private async stored(): Promise<{
    level: ConfiguredLogLevel;
    source: 'environment' | 'database';
  }> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: LOG_LEVEL_KEY } });
    const value = (row?.value as { level?: unknown } | undefined)?.level;

    if (value === undefined) return { level: this.fromEnvironment, source: 'environment' };

    if (!isConfiguredLogLevel(value)) {
      // A malformed row must not silence the logs. Fall back, and say so —
      // otherwise the console would report a level nothing is honouring.
      this.logger.warn(
        `Stored log level ${JSON.stringify(value)} is not valid; using the environment.`,
      );
      return { level: this.fromEnvironment, source: 'environment' };
    }

    return { level: value, source: 'database' };
  }
}

/** Builds the applier main.ts hands in, keeping Nest's API in one place. */
export function loggerApplier(setLevels: (levels: ReturnType<typeof levelsFor>) => void) {
  return (level: ConfiguredLogLevel): void => setLevels(levelsFor(level));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
