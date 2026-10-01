import 'reflect-metadata';
import {
  AUDIT_DELIVERY_OUTBOX,
  AUDIT_FORWARDING_SETTINGS,
  AUDIT_SINK,
  AUDIT_TRANSPORT,
  AUTH_PROVIDERS,
  CAPABILITY_TOKENS,
  CORE_AUDIT_SINK,
  capabilityTokenName,
} from '@nexuspuppet/contracts';

/**
 * Every seam, checked structurally.
 *
 * A token and an interface do not by themselves make a seam work. If a
 * consumer injects the concrete class instead of the token, it reaches around
 * whatever the token is bound to: the seam looks present in the source and is
 * inert at runtime — and nothing fails, which is what makes it dangerous.
 *
 * Three of those had shipped here before this suite existed: AUTH_PROVIDER,
 * ENC_FILE_WRITER, and AUDIT_SINK — the last meaning the forwarding sink would
 * have missed every user-administration and classification event, the two
 * things an auditor actually asks for.
 *
 * So these assert over CAPABILITY_TOKENS rather than over a list written here.
 * A token added to contracts is covered the day it is added, with no change to
 * this file. That is the point: the next decorative seam should fail a test
 * rather than wait to be noticed.
 */

/**
 * AppModule.bootstrap() validates the whole environment before it builds
 * anything. Supplied explicitly rather than inherited — relying on the
 * developer's shell having sourced .env is how a test passes locally and fails
 * in CI, which is exactly what happened here once already.
 *
 * Placeholders. Nothing is connected to: bootstrap() returns a provider
 * descriptor and every factory in it is lazy, so no certificate is read, no
 * ENC directory is created and no database is reached.
 */
const REQUIRED_ENV: Record<string, string> = {
  JWT_SECRET: 'x'.repeat(48),
  DATABASE_URL:
    'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public',
  PUPPETDB_URL: 'https://puppetdb.invalid:8081',
  PUPPETDB_CERT_PATH: '/dev/null',
  PUPPETDB_KEY_PATH: '/dev/null',
  PUPPETDB_CA_PATH: '/dev/null',
  ENC_OUTPUT_DIR: '/tmp/nexuspuppet-wiring-test',
};

/**
 * Where Nest records constructor dependencies.
 *
 * `design:paramtypes` is emitted by TypeScript for any decorated class;
 * `self:paramtypes` is what @Inject() writes, and it wins per index because an
 * explicit token overrides the declared type. Reading both is what lets this
 * see a token injection and a class injection as the same kind of fact.
 */
const DESIGN_PARAMTYPES = 'design:paramtypes';
const SELF_PARAMTYPES = 'self:paramtypes';

type Ctor = new (...args: never[]) => unknown;
type ProviderRecord = Record<string, unknown>;

interface Registration {
  /** What the container is asked for. */
  token: unknown;
  /** What it constructs or aliases, where that is statically knowable. */
  implementation: Ctor | null;
  /** How the implementation is reached: relevant because the rules differ. */
  kind: 'class' | 'useClass' | 'useExisting' | 'useFactory' | 'useValue';
  /** Tokens this registration itself depends on. */
  dependencies: unknown[];
}

const isCtor = (value: unknown): value is Ctor => typeof value === 'function';

const nameOf = (value: unknown): string =>
  isCtor(value)
    ? value.name
    : typeof value === 'symbol'
      ? capabilityTokenName(value)
      : String(value);

/** Constructor dependencies of a decorated class, @Inject() overrides applied. */
function classDependencies(cls: Ctor): unknown[] {
  const declared = (Reflect.getMetadata(DESIGN_PARAMTYPES, cls) as unknown[]) ?? [];
  const injected =
    (Reflect.getMetadata(SELF_PARAMTYPES, cls) as Array<{ index: number; param: unknown }>) ?? [];

  const deps = [...declared];
  for (const { index, param } of injected) deps[index] = param;
  return deps;
}

/** One provider entry, in whichever of Nest's five shapes it was written. */
function describeProvider(provider: unknown): Registration {
  if (isCtor(provider)) {
    return {
      token: provider,
      implementation: provider,
      kind: 'class',
      dependencies: classDependencies(provider),
    };
  }

  const p = provider as ProviderRecord;
  const token = p['provide'];

  if (isCtor(p['useClass'])) {
    const impl = p['useClass'];
    return { token, implementation: impl, kind: 'useClass', dependencies: classDependencies(impl) };
  }
  if (p['useExisting'] !== undefined) {
    const target = p['useExisting'];
    // An alias depends on its target, which is a legitimate reference to the
    // class and the one exception the bypass rule has to make.
    return {
      token,
      implementation: isCtor(target) ? target : null,
      kind: 'useExisting',
      dependencies: [target],
    };
  }
  if (p['useFactory'] !== undefined) {
    return {
      token,
      implementation: null,
      kind: 'useFactory',
      dependencies: (p['inject'] as unknown[]) ?? [],
    };
  }
  return { token, implementation: null, kind: 'useValue', dependencies: [] };
}

/**
 * Implementations reached through a factory, which cannot be derived.
 *
 * A factory returns an instance; the class it constructs is invisible to the
 * container, so unlike useClass/useExisting there is nothing to read. Listing
 * them here is the one manual step — and the test below asserts every
 * factory-backed token appears in this map, so adding a seam without adding it
 * here fails rather than silently going unchecked.
 */
/**
 * Seams whose value is a LIST of implementations rather than one.
 *
 * The rules below model "one token, one implementation": they resolve a token
 * to a class and then assert nothing reaches that class around the token. That
 * is exactly right for AUDIT_SINK, and wrong for AUTH_PROVIDERS, whose members
 * are individually registered ON PURPOSE — LocalAuthProvider is also bound
 * directly and aliased by AUTH_PROVIDER, because it must exist whatever
 * directories are configured (ADR-0015).
 *
 * Excluded from those rules, and covered instead by the dedicated test below,
 * which asserts the invariant that actually matters for this seam.
 */
const LIST_VALUED: ReadonlySet<symbol> = new Set([Symbol.for('nexuspuppet.AuthProviders')]);

const FACTORY_BACKED: ReadonlyArray<{ token: symbol; module: string; className: string }> = [
  {
    token: Symbol.for('nexuspuppet.PuppetDbClient'),
    module: './puppetdb/puppetdb.client',
    className: 'PuppetDbClient',
  },
  {
    token: Symbol.for('nexuspuppet.EncFileWriter'),
    module: './materialization/posix-enc-storage',
    className: 'PosixEncStorage',
  },
  {
    token: Symbol.for('nexuspuppet.AuditSink'),
    module: './audit-forwarding/forwarding-audit-sink',
    className: 'ForwardingAuditSink',
  },
  {
    token: Symbol.for('nexuspuppet.AuditTransport'),
    module: './audit-forwarding/settings-transport',
    className: 'SettingsAuditTransport',
  },
];

/** Every directory variable, so each case below starts from a clean slate. */
const INTEGRATION_ENV = /^(LDAP_|OIDC_|AUDIT_EXPORT_)/;

const LDAP_ENV: Record<string, string> = {
  LDAP_URL: 'ldaps://directory.example.test:636',
  LDAP_BIND_DN: 'cn=svc,dc=example,dc=test',
  LDAP_BIND_PASSWORD: 'secret',
  LDAP_SEARCH_BASE: 'ou=people,dc=example,dc=test',
};

const OIDC_ENV: Record<string, string> = {
  OIDC_ISSUER: 'https://idp.example.test',
  OIDC_CLIENT_ID: 'nexuspuppet',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_REDIRECT_URI: 'https://console.example.test/auth/callback',
};

describe('capability wiring', () => {
  const saved: Record<string, string | undefined> = {};

  let registrations: Registration[];
  let controllers: Registration[];
  /** Every registration, since a controller can bypass a seam just as easily. */
  let all: Registration[];

  beforeAll(async () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = process.env[key] ?? value;
    }
    // The graph under test is the one with every optional provider present,
    // so a directory provider injecting around a token is caught too.
    for (const key of Object.keys(process.env)) {
      if (INTEGRATION_ENV.test(key)) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries({ ...LDAP_ENV, ...OIDC_ENV })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    const { AppModule } = await import('./app.module');
    const module = await AppModule.bootstrap();

    registrations = (module.providers ?? []).map(describeProvider);
    controllers = (module.controllers ?? []).map((c) => describeProvider(c));
    all = [...registrations, ...controllers];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The registration that owns a token, for the assertions below. */
  const registrationFor = (token: unknown): Registration | undefined =>
    registrations.find((r) => r.token === token);

  /**
   * Follow `useExisting` aliases to whatever ultimately implements a token.
   *
   * A seam may alias a token rather than name a class — AUTH_PROVIDER aliases
   * LocalAuthProvider. Without following the chain the alias looks like an
   * unidentifiable seam, and this suite would demand it be declared
   * factory-backed, which would be a lie.
   *
   * Depth-bounded: a cycle in the provider graph would otherwise hang the suite
   * rather than fail it.
   */
  const resolveImplementation = (token: unknown, depth = 0): { cls: Ctor; kind: string } | null => {
    if (depth > 8) return null;
    const r = registrationFor(token);
    if (r === undefined) return null;
    if (r.implementation !== null) return { cls: r.implementation, kind: r.kind };
    if (r.kind === 'useExisting') return resolveImplementation(r.dependencies[0], depth + 1);
    return null;
  };

  describe('completeness', () => {
    /**
     * A token with no binding means the injector cannot resolve whatever
     * depends on it — the API would refuse to boot.
     */
    it.each(
      CAPABILITY_TOKENS.filter((t) => !LIST_VALUED.has(t)).map(
        (t) => [capabilityTokenName(t), t] as const,
      ),
    )('%s is bound exactly once', (_name, token) => {
      const owners = registrations.filter((r) => r.token === token);
      expect(owners).toHaveLength(1);
    });

    /**
     * Two registrations of the same token would make the effective
     * implementation depend on array order.
     */
    it('registers no token twice', () => {
      const seen = new Map<unknown, number>();
      for (const r of registrations) seen.set(r.token, (seen.get(r.token) ?? 0) + 1);

      const duplicated = [...seen.entries()]
        .filter(([, count]) => count > 1)
        .map(([t]) => nameOf(t));
      expect(duplicated).toEqual([]);
    });
  });

  describe('every seam is checkable', () => {
    /**
     * The assertion that keeps this suite honest.
     *
     * The bypass rule below can only check a seam whose implementation it can
     * name. useClass and useExisting are readable from the graph; a factory is
     * not, so it must be declared in FACTORY_BACKED. Without this, adding a
     * factory-backed token would quietly opt it out of every check here and the
     * suite would still be green.
     */
    it.each(
      CAPABILITY_TOKENS.filter((t) => !LIST_VALUED.has(t)).map(
        (t) => [capabilityTokenName(t), t] as const,
      ),
    )('%s exposes an implementation this test can identify', (name, token) => {
      const registration = registrationFor(token);
      expect(registration).toBeDefined();

      if (resolveImplementation(token) !== null) return;

      // Named in the failure rather than passed to expect(): Jest's expect
      // takes one argument, and a bare `undefined` here would say nothing
      // about what to do next.
      const declared = FACTORY_BACKED.find((f) => f.token === token);
      const missing = declared
        ? []
        : [
            `${name} is factory-backed, so its implementation cannot be read from ` +
              `the provider graph. Add it to FACTORY_BACKED so the bypass rule can ` +
              `check it.`,
          ];
      expect(missing).toEqual([]);
    });
  });

  /**
   * The forwarding sink COMPOSES over the Postgres sink rather than replacing
   * it (ADR-0016): an estate that gains a SIEM must not lose its local trail.
   */
  describe('audit forwarding composes over the Postgres sink', () => {
    it('binds CORE_AUDIT_SINK to the Postgres sink, constructed once', () => {
      const resolved = resolveImplementation(CORE_AUDIT_SINK);
      expect(resolved?.cls.name).toBe('PrismaAuditSink');
      // useClass, registered nowhere else — see the bypass rules below.
      expect(registrationFor(CORE_AUDIT_SINK)?.kind).toBe('useClass');
    });

    it('builds AUDIT_SINK over CORE_AUDIT_SINK, the outbox, and the transport', () => {
      const registration = registrationFor(AUDIT_SINK);

      expect(registration?.kind).toBe('useFactory');
      expect(registration?.dependencies).toEqual([
        CORE_AUDIT_SINK,
        AUDIT_DELIVERY_OUTBOX,
        AUDIT_TRANSPORT,
      ]);
    });

    it('binds the transport to the settings store, never to the service', () => {
      // The service injects the transport; the transport injecting the
      // service back is a cycle the injector deadlocks on, silently.
      expect(registrationFor(AUDIT_TRANSPORT)?.dependencies).toEqual([AUDIT_FORWARDING_SETTINGS]);
    });
  });

  /**
   * What LIST_VALUED gives up, replaced by what actually matters here.
   *
   * Excluding AUTH_PROVIDERS from the single-implementation rules would leave it
   * less protected than every other seam, and a seam that quietly stops being
   * checked is how the defects this suite exists for got in. The invariant worth
   * guarding is narrower and stronger than anything those rules assert: core's
   * local provider is in the list, so an administrator can always get in.
   */
  describe('AUTH_PROVIDERS keeps local authentication', () => {
    it('always contains LocalAuthProvider', () => {
      const registration = registrationFor(AUTH_PROVIDERS);

      expect(registration).toBeDefined();
      expect(registration?.dependencies.map((d) => (d as Ctor).name)).toContain(
        'LocalAuthProvider',
      );
    });
  });

  describe('no consumer bypasses a token', () => {
    /**
     * Derived, not listed. Every class a capability token constructs or
     * aliases — so a new token registered with useClass or useExisting is
     * protected here automatically.
     */
    const implementationsOfSeams = (): Array<{ cls: Ctor; token: symbol; kind: string }> =>
      CAPABILITY_TOKENS.flatMap((token) => {
        const resolved = resolveImplementation(token);
        return resolved ? [{ cls: resolved.cls, token, kind: resolved.kind }] : [];
      });

    it('has no provider or controller injecting a capability implementation', () => {
      const violations: string[] = [];

      for (const { cls, token, kind } of implementationsOfSeams()) {
        for (const consumer of all) {
          // The token's own registration is how the seam is declared. For
          // useExisting the alias must name its target; that is the mechanism,
          // not a bypass.
          if (consumer.token === token) continue;
          // A class provider naming itself is its own constructor, not a
          // dependency on the seam.
          if (consumer.token === cls) continue;

          // The one deliberate exception, pointing the OPPOSITE way to
          // everything else this rule protects (ADR-0015).
          //
          // Normally, injecting an implementation instead of its token reaches
          // around whatever the token is bound to. Here, going through
          // AUTH_PROVIDER would let a rebinding remove the local provider from
          // the list — and a deployment whose local provider can be unbound is
          // one whose administrators can be locked out by a directory that is
          // merely misconfigured. The direct reference is the fix, not the bug.
          //
          // Narrow on purpose: this one pair, not the token in general.
          if (
            consumer.token === Symbol.for('nexuspuppet.AuthProviders') &&
            cls.name === 'LocalAuthProvider'
          ) {
            continue;
          }

          if (consumer.dependencies.includes(cls)) {
            violations.push(
              `${nameOf(consumer.token)} injects ${cls.name} directly instead of ` +
                `${capabilityTokenName(token)} (registered ${kind}) — it reaches around ` +
                `whatever the token is bound to`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });

    /**
     * Registration is what makes bypass possible. A class that is not in the
     * container cannot be injected by anything, whatever a constructor asks
     * for — Nest fails to resolve instead, loudly, at boot.
     *
     * useExisting is the exception and requires the opposite: it aliases a
     * provider that must already exist, so its target is registered by design.
     */
    it('leaves no useClass implementation separately registered', () => {
      const violations: string[] = [];

      for (const { cls, token, kind } of implementationsOfSeams()) {
        if (kind !== 'useClass') continue;

        const standalone = registrations.find((r) => r.token === cls);
        if (standalone) {
          violations.push(
            `${cls.name} is registered under its own token as well as behind ` +
              `${capabilityTokenName(token)}. useClass builds a SECOND instance, so the ` +
              `two would diverge — and the class stays injectable, which is the bypass ` +
              `route this suite exists to close`,
          );
        }
      }

      expect(violations).toEqual([]);
    });

    /**
     * Factory-backed seams, checked the same way. The class is loaded by name
     * rather than derived, but the rule is identical: nothing may inject it and
     * nothing may register it.
     */
    it('has nothing injecting or registering a factory-backed implementation', async () => {
      const violations: string[] = [];

      for (const { token, module, className } of FACTORY_BACKED) {
        const loaded = (await import(module)) as Record<string, unknown>;
        const cls = loaded[className];
        expect(isCtor(cls)).toBe(true);
        if (!isCtor(cls)) continue;

        if (registrations.some((r) => r.token === cls)) {
          violations.push(
            `${className} is registered in the container as well as behind ` +
              `${capabilityTokenName(token)}, so it can be injected around the token`,
          );
        }

        for (const consumer of all) {
          if (consumer.dependencies.includes(cls)) {
            violations.push(
              `${nameOf(consumer.token)} injects ${className} directly instead of ` +
                `${capabilityTokenName(token)}`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });
});

/**
 * Which directory providers exist: BOTH, whatever the configuration (ADR-0015,
 * ADR-0023, ADR-0029).
 *
 * Until ADR-0029 a provider was registered only when its environment was set,
 * so enabling a directory needed an .env edit and a restart. Now registration
 * is unconditional and configuration only decides whether a provider is
 * dormant — which these cases pin, together with the two rules that did NOT
 * change: local is first and always present, and a malformed environment
 * still stops the boot.
 *
 * Ported from the old enterprise layer's register() suite. One of the
 * behaviours it pinned was load-bearing: with no directory configured the layer
 * used to THROW, which was fatal at boot — so an operator who enabled LDAP,
 * locked themselves out, and backed the change out by unsetting LDAP_URL found
 * the API would not start at all.
 */
describe('directory provider registration', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  const withEnv = (extra: Record<string, string>): void => {
    for (const key of Object.keys(process.env)) {
      if (INTEGRATION_ENV.test(key)) delete process.env[key];
    }
    Object.assign(process.env, REQUIRED_ENV, extra);
  };

  /** The providers AUTH_PROVIDERS is built from, by class name, in order. */
  const authProviders = async (): Promise<string[]> => {
    const { AppModule } = await import('./app.module');
    const module = await AppModule.bootstrap();
    const registration = (module.providers ?? [])
      .map(describeProvider)
      .find((r) => r.token === AUTH_PROVIDERS);
    return (registration?.dependencies ?? []).map((d) => nameOf(d));
  };

  const ALL = ['LocalAuthProvider', 'LdapAuthProvider', 'OidcAuthProvider'];

  /*
   * The case the user report was about: an old core install upgraded with no
   * LDAP_* or OIDC_* in its .env. Both directories must still be registered —
   * dormant — so the console can enable either without a restart.
   */
  it('registers both directories, dormant, when nothing is configured', async () => {
    withEnv({});

    expect(await authProviders()).toEqual(ALL);
  });

  it('registers both, local first, when only LDAP_URL is set', async () => {
    withEnv(LDAP_ENV);

    expect(await authProviders()).toEqual(ALL);
  });

  it('registers both, local first, when only OIDC_ISSUER is set', async () => {
    withEnv(OIDC_ENV);

    expect(await authProviders()).toEqual(ALL);
  });

  /*
   * Both at once (ADR-0023 §1). This used to be refused, on the grounds that
   * two directories were an ambiguity nothing could resolve; ADR-0015's
   * dispatch by `authSource` resolved it.
   */
  it('registers both when both are configured', async () => {
    withEnv({ ...LDAP_ENV, ...OIDC_ENV });

    expect(await authProviders()).toEqual([
      'LocalAuthProvider',
      'LdapAuthProvider',
      'OidcAuthProvider',
    ]);
  });

  /*
   * Validate-at-boot. A guard once read `directoryConfigured && oidc === null`,
   * which skipped LDAP validation whenever OIDC was also set — so a malformed
   * URL reached a login instead of the boot that was supposed to catch it.
   */
  it('refuses to boot on a malformed LDAP_URL, even with OIDC also set', async () => {
    withEnv({ ...LDAP_ENV, ...OIDC_ENV, LDAP_URL: 'not a url' });
    const { AppModule } = await import('./app.module');

    await expect(AppModule.bootstrap()).rejects.toThrow(
      /LDAP is configured but its settings are invalid/,
    );
  });

  it('refuses to boot on a malformed OIDC configuration', async () => {
    withEnv({ ...OIDC_ENV, OIDC_REDIRECT_URI: 'not a url' });
    const { AppModule } = await import('./app.module');

    await expect(AppModule.bootstrap()).rejects.toThrow(
      /OIDC is configured but its settings are invalid/,
    );
  });

  it('refuses to boot on a malformed AUDIT_EXPORT_URL', async () => {
    withEnv({ AUDIT_EXPORT_URL: 'http://collector.example.test/audit' });
    const { AppModule } = await import('./app.module');

    await expect(AppModule.bootstrap()).rejects.toThrow(/Audit export is configured/);
  });
});
