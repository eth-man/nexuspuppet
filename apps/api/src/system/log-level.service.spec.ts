import { LogLevelService, LOG_LEVEL_KEY } from './log-level.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfiguredLogLevel } from './pure/log-levels';

function build(
  options: {
    stored?: unknown;
    env?: ConfiguredLogLevel;
    environmentWins?: boolean;
  } = {},
) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(options.stored === undefined ? null : { value: { level: options.stored } });
  const upsert = jest.fn().mockResolvedValue(undefined);
  const deleteMany = jest.fn().mockResolvedValue(undefined);

  const prisma = { appSetting: { findUnique, upsert, deleteMany } } as unknown as PrismaService;
  const applied: ConfiguredLogLevel[] = [];

  const service = new LogLevelService(
    prisma,
    options.env ?? 'info',
    (level) => applied.push(level),
    options.environmentWins ?? false,
    0, // no timer in tests
  );

  return { service, applied, findUnique, upsert, deleteMany };
}

describe('LogLevelService', () => {
  it('uses the environment when nothing is stored', async () => {
    const { service } = build({ env: 'warn' });
    await service.onModuleInit();

    expect(service.describe()).toEqual({ level: 'warn', source: 'environment', locked: false });
  });

  it('applies a stored level over the environment', async () => {
    const { service, applied } = build({ env: 'info', stored: 'debug' });
    await service.onModuleInit();

    expect(applied).toContain('debug');
    expect(service.describe()).toMatchObject({ level: 'debug', source: 'database' });
  });

  /*
   * Inferring the source by comparing values would report a STORED level as
   * coming from the environment whenever the two agree — telling an operator
   * their saved setting is not in effect while it is.
   */
  it('reports a stored level as stored even when it equals the environment', async () => {
    const { service } = build({ env: 'info', stored: 'info' });
    await service.onModuleInit();

    expect(service.describe().source).toBe('database');
  });

  it('changes the level, and applies it immediately', async () => {
    const { service, applied, upsert } = build({ env: 'info' });
    await service.onModuleInit();

    // The store now returns the new value, as it would after the write.
    (
      service as unknown as { prisma: { appSetting: { findUnique: jest.Mock } } }
    ).prisma.appSetting.findUnique.mockResolvedValue({ value: { level: 'debug' } });
    await service.set('debug');

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: LOG_LEVEL_KEY } }));
    expect(applied).toContain('debug');
  });

  it('returns to the environment when the stored value is cleared', async () => {
    const { service, deleteMany } = build({ env: 'warn', stored: 'debug' });
    await service.onModuleInit();

    (
      service as unknown as { prisma: { appSetting: { findUnique: jest.Mock } } }
    ).prisma.appSetting.findUnique.mockResolvedValue(null);
    await service.clear();

    expect(deleteMany).toHaveBeenCalled();
    expect(service.describe()).toMatchObject({ level: 'warn', source: 'environment' });
  });

  /*
   * SETTINGS_SOURCE=env is the escape hatch that lets an operator override the
   * console from the host (ADR-0016 §2). A stored level must not defeat it —
   * and the console must SAY the control is inert rather than accept a change
   * that will never take effect.
   */
  describe('when SETTINGS_SOURCE=env', () => {
    it('ignores the stored level entirely', async () => {
      const { service, findUnique } = build({
        env: 'error',
        stored: 'debug',
        environmentWins: true,
      });
      await service.onModuleInit();

      expect(findUnique).not.toHaveBeenCalled();
      expect(service.describe()).toEqual({ level: 'error', source: 'environment', locked: true });
    });
  });

  /*
   * A malformed row must not silence the logs — the console would then report a
   * level nothing is honouring.
   */
  it('falls back to the environment when the stored value is not a level', async () => {
    const { service } = build({ env: 'info', stored: 'chatty' });
    await service.onModuleInit();

    expect(service.describe()).toMatchObject({ level: 'info', source: 'environment' });
  });

  it('applies the current level as soon as bootstrap binds an applier', () => {
    const { service } = build({ env: 'warn' });
    const applied: ConfiguredLogLevel[] = [];

    service.bind((level) => applied.push(level));

    expect(applied).toEqual(['warn']);
  });
});
