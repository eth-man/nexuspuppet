import { randomBytes } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsStore, SettingsStoreError } from '../src/settings/settings.store';

/**
 * The settings store against a REAL PostgreSQL (ADR-0016 §2).
 *
 * The rules under test are the two that are easy to state and easy to get
 * wrong: a configuration resolves entirely from one source, and the escape
 * hatch beats everything. Both exist because getting them wrong locks an
 * operator out of their own console.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const KEY = randomBytes(32).toString('base64');

interface LdapConfig {
  url: string;
  searchBase?: string;
  bindPassword?: string;
}

describe('settings store (integration)', () => {
  let prisma: PrismaService;

  const ENV: LdapConfig = { url: 'ldaps://from-env.example.test', searchBase: 'ou=env' };
  const fromEnv = () => ENV;
  const noEnv = () => null;

  const store = (opts: { key?: string | undefined; source?: 'db' | 'env' } = {}) =>
    new SettingsStore(prisma, 'key' in opts ? opts.key : KEY, opts.source ?? 'db');

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.providerSetting.deleteMany();
  });

  describe('precedence', () => {
    it('falls back to the environment when nothing is stored', async () => {
      const resolved = await store().resolve<LdapConfig>('auth.ldap', fromEnv);

      expect(resolved.source).toBe('environment');
      expect(resolved.config?.url).toBe('ldaps://from-env.example.test');
    });

    it('reports unset when neither source has anything', async () => {
      const resolved = await store().resolve<LdapConfig>('auth.ldap', noEnv);

      expect(resolved.source).toBe('unset');
      expect(resolved.config).toBeNull();
    });

    it('a stored row wins over the environment', async () => {
      await store().save('auth.ldap', { url: 'ldaps://from-db.example.test' }, [], 'a@example.com');

      const resolved = await store().resolve<LdapConfig>('auth.ldap', fromEnv);

      expect(resolved.source).toBe('database');
      expect(resolved.config?.url).toBe('ldaps://from-db.example.test');
    });

    it('does NOT merge the two per field', async () => {
      // The rule that stops a state nobody can reproduce from either source.
      // The stored row omits searchBase; the environment has one. The result
      // must not quietly acquire it.
      await store().save('auth.ldap', { url: 'ldaps://from-db.example.test' }, [], 'a@example.com');

      const resolved = await store().resolve<LdapConfig>('auth.ldap', fromEnv);

      expect(resolved.config?.searchBase).toBeUndefined();
    });

    it('SETTINGS_SOURCE=env ignores a stored row entirely', async () => {
      // The escape hatch. Without it a bad saved config cannot be overridden.
      await store().save('auth.ldap', { url: 'ldaps://from-db.example.test' }, [], 'a@example.com');

      const resolved = await store({ source: 'env' }).resolve<LdapConfig>('auth.ldap', fromEnv);

      expect(resolved.source).toBe('environment');
      expect(resolved.config?.url).toBe('ldaps://from-env.example.test');
    });

    it('a disabled row does not fall back to the environment', async () => {
      // Disabled means "off", not "use the other source". Falling back would
      // resurrect exactly what the operator switched off.
      await store().save('auth.ldap', { url: 'ldaps://from-db.example.test' }, [], 'a@example.com');
      await store().setEnabled('auth.ldap', false, 'a@example.com');

      const resolved = await store().resolve<LdapConfig>('auth.ldap', fromEnv);

      expect(resolved.disabled).toBe(true);
      expect(resolved.config).toBeNull();
    });

    it('clearing a row restores the environment', async () => {
      await store().save('auth.ldap', { url: 'ldaps://from-db.example.test' }, [], 'a@example.com');
      await store().clear('auth.ldap');

      expect((await store().resolve<LdapConfig>('auth.ldap', fromEnv)).source).toBe('environment');
    });
  });

  describe('secrets', () => {
    it('round-trips a secret for server-side use', async () => {
      await store().save(
        'auth.ldap',
        { url: 'ldaps://d.example.test', bindPassword: 'a-secret' },
        ['bindPassword'],
        'a@example.com',
      );

      const resolved = await store().resolve<LdapConfig>('auth.ldap', noEnv);

      expect(resolved.config?.bindPassword).toBe('a-secret');
      expect(resolved.secretsHeld).toEqual(['bindPassword']);
    });

    it('describe() never returns the value', async () => {
      // The method the API layer uses. A boolean flag deciding this would be
      // one careless call site away from leaking a credential.
      await store().save(
        'auth.ldap',
        { url: 'ldaps://d.example.test', bindPassword: 'a-secret' },
        ['bindPassword'],
        'a@example.com',
      );

      const described = await store().describe<LdapConfig>('auth.ldap', noEnv);

      expect(described.config?.bindPassword).toBeUndefined();
      // But it still says one is HELD, so the UI can show "set" rather than
      // implying the field is empty.
      expect(described.secretsHeld).toEqual(['bindPassword']);
      expect(described.config?.url).toBe('ldaps://d.example.test');
    });

    it('is not stored in clear anywhere in the row', async () => {
      await store().save(
        'auth.ldap',
        { url: 'ldaps://d.example.test', bindPassword: 'correct-horse' },
        ['bindPassword'],
        'a@example.com',
      );

      const row = await prisma.providerSetting.findUnique({ where: { kind: 'auth.ldap' } });

      expect(JSON.stringify(row?.config)).not.toContain('correct-horse');
      expect(Buffer.from(row?.secrets ?? []).toString('utf8')).not.toContain('correct-horse');
    });

    it('an omitted secret keeps the stored one rather than clearing it', async () => {
      // The console never sends back a value it was not given, so a save that
      // changes only the URL must not wipe the password.
      await store().save(
        'auth.ldap',
        { url: 'ldaps://one.example.test', bindPassword: 'keep-me' },
        ['bindPassword'],
        'a@example.com',
      );
      await store().save(
        'auth.ldap',
        { url: 'ldaps://two.example.test' },
        ['bindPassword'],
        'b@example.com',
      );

      const resolved = await store().resolve<LdapConfig>('auth.ldap', noEnv);

      expect(resolved.config?.url).toBe('ldaps://two.example.test');
      expect(resolved.config?.bindPassword).toBe('keep-me');
    });

    it('refuses to save a secret with no key configured', async () => {
      await expect(
        store({ key: undefined }).save(
          'auth.ldap',
          { url: 'ldaps://d.example.test', bindPassword: 'x' },
          ['bindPassword'],
          'a@example.com',
        ),
      ).rejects.toThrow(/CONFIG_ENCRYPTION_KEY is not set/);
    });

    it('refuses to READ stored secrets with the wrong key, rather than continuing without them', async () => {
      // The important failure. Silently resolving without a bind password means
      // binding anonymously to a directory the operator believes is
      // authenticated.
      await store().save(
        'auth.ldap',
        { url: 'ldaps://d.example.test', bindPassword: 'a-secret' },
        ['bindPassword'],
        'a@example.com',
      );

      const wrongKey = store({ key: randomBytes(32).toString('base64') });

      await expect(wrongKey.resolve<LdapConfig>('auth.ldap', noEnv)).rejects.toThrow(
        SettingsStoreError,
      );
    });

    it('refuses to read stored secrets with no key at all', async () => {
      await store().save(
        'auth.ldap',
        { url: 'ldaps://d.example.test', bindPassword: 'a-secret' },
        ['bindPassword'],
        'a@example.com',
      );

      await expect(
        store({ key: undefined }).resolve<LdapConfig>('auth.ldap', noEnv),
      ).rejects.toThrow(/CONFIG_ENCRYPTION_KEY is not set/);
    });
  });

  it('records who changed a configuration', async () => {
    await store().save('auth.ldap', { url: 'ldaps://d.example.test' }, [], 'operator@example.com');

    const resolved = await store().resolve<LdapConfig>('auth.ldap', noEnv);

    expect(resolved.updatedByEmail).toBe('operator@example.com');
    expect(resolved.updatedAt).toBeInstanceOf(Date);
  });
});
