import type { PrismaService } from '../prisma/prisma.service';
import { AuthSettingsResolver } from './auth-settings.resolver';
import { SettingsStore } from './settings.store';

const KEY = Buffer.alloc(32, 3).toString('base64');

interface Row {
  kind: string;
  config: object;
  secrets: Uint8Array | null;
  enabled: boolean;
  updatedAt: Date;
  updatedByEmail: string | null;
}

/** Enough Prisma for the store; anything else is a wrong turn worth crashing on. */
class FakePrisma {
  readonly rows = new Map<string, Row>();

  readonly providerSetting = {
    findUnique: async ({ where }: { where: { kind: string } }): Promise<Row | null> =>
      this.rows.get(where.kind) ?? null,
    upsert: async ({
      where,
      create,
    }: {
      where: { kind: string };
      create: { kind: string; config: object; secrets: Buffer | null; updatedByEmail: string };
    }): Promise<Row> => {
      const row: Row = {
        kind: where.kind,
        config: create.config,
        secrets: create.secrets,
        enabled: true,
        updatedAt: new Date('2026-08-05T00:00:00Z'),
        updatedByEmail: create.updatedByEmail,
      };
      this.rows.set(where.kind, row);
      return row;
    },
    update: async (): Promise<Row> => {
      throw new Error('not used');
    },
    deleteMany: async (): Promise<{ count: number }> => ({ count: 0 }),
  };
}

function build(forcedSource: 'db' | 'env' = 'db'): {
  resolver: AuthSettingsResolver;
  store: SettingsStore;
  prisma: FakePrisma;
} {
  const prisma = new FakePrisma();
  const store = new SettingsStore(prisma as unknown as PrismaService, KEY, forcedSource);
  return { resolver: new AuthSettingsResolver(store), store, prisma };
}

describe('AuthSettingsResolver', () => {
  it('answers null when nothing is stored, so the provider keeps its boot configuration', async () => {
    const { resolver } = build();

    expect(await resolver.resolve('ldap')).toBeNull();
  });

  it('answers null for a source it has no setting kind for', async () => {
    const { resolver } = build();

    // A provider core has never heard of must not make this throw; it simply
    // has nothing stored.
    expect(await resolver.resolve('kerberos')).toBeNull();
  });

  it('returns a stored configuration INCLUDING its secrets, because a bind needs them', async () => {
    const { resolver, store } = build();
    await store.save(
      'auth.ldap',
      { url: 'ldaps://dc.example.test:636', bindPassword: 'super-secret' },
      ['bindPassword'],
      'op@example.test',
    );

    const resolved = (await resolver.resolve('ldap')) as Record<string, unknown>;

    expect(resolved['url']).toBe('ldaps://dc.example.test:636');
    // The redacted view is a DIFFERENT method. This one feeds a directory bind.
    expect(resolved['bindPassword']).toBe('super-secret');
  });

  /**
   * ADR-0016 §2's escape hatch has to reach here too: an operator who set
   * SETTINGS_SOURCE=env to recover from a bad saved configuration must not
   * find the provider still using it.
   */
  it('ignores stored rows under SETTINGS_SOURCE=env', async () => {
    const { prisma, store } = build();
    await store.save('auth.ldap', { url: 'ldaps://stored.example.test' }, [], 'op@example.test');

    const forced = new SettingsStore(prisma as unknown as PrismaService, KEY, 'env');

    expect(await new AuthSettingsResolver(forced).resolve('ldap')).toBeNull();
  });

  /**
   * Fails LOUD, unlike the mapping sources which fail open. The difference is
   * what the answer is used for: a mapping source informs a warning, this
   * decides which directory a password is sent to.
   */
  it('propagates a store failure rather than reporting nothing stored', async () => {
    const { resolver, store } = build();
    jest.spyOn(store, 'resolve').mockRejectedValue(new Error('database is down'));

    await expect(resolver.resolve('ldap')).rejects.toThrow('database is down');
  });
});
