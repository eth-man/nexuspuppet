import 'reflect-metadata';
import {
  AUDIT_SINK,
  CAPABILITY_TOKENS,
  CORE_AUDIT_SINK,
  capabilityTokenName,
} from '@nexuspuppet/contracts';

/**
 * Every capability seam, checked structurally (ADR-0002).
 *
 * A token, an interface and a core default do not by themselves make a seam
 * work. If a consumer injects the concrete class instead of the token, the
 * enterprise layer can register a replacement, the container will hold it, and
 * nothing will ever call it. The seam looks present in the source and is inert
 * at runtime — and nothing fails, which is what makes it dangerous.
 *
 * Three of those had shipped here before this suite existed: AUTH_PROVIDER,
 * ENC_FILE_WRITER, and AUDIT_SINK — the last meaning an enterprise SIEM sink
 * would have missed every user-administration and classification event, the
 * two things an auditor actually asks for.
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
const FACTORY_BACKED: ReadonlyArray<{ token: symbol; module: string; className: string }> = [
  {
    token: Symbol.for('nexuspuppet.PuppetDbClient'),
    module: '../puppetdb/puppetdb.client',
    className: 'PuppetDbClient',
  },
  {
    token: Symbol.for('nexuspuppet.EncFileWriter'),
    module: '../materialization/posix-enc-storage',
    className: 'PosixEncStorage',
  },
];

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

    const { AppModule } = await import('../app.module');
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
   * A seam may alias a token rather than name a class — AUDIT_SINK aliases
   * CORE_AUDIT_SINK so an enterprise sink can compose over the core one. Without
   * following the chain the alias looks like an unidentifiable seam, and this
   * suite would demand it be declared factory-backed, which would be a lie.
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
     * Core is a complete product on its own (ADR-0002). A token with no core
     * default would mean a deployment without the enterprise layer cannot
     * resolve the injector at all — the API would refuse to boot.
     */
    it.each(CAPABILITY_TOKENS.map((t) => [capabilityTokenName(t), t] as const))(
      '%s has exactly one core default',
      (_name, token) => {
        const owners = registrations.filter((r) => r.token === token);
        expect(owners).toHaveLength(1);
      },
    );

    /**
     * Two registrations of the same token would make the effective
     * implementation depend on array order — the enterprise override could win
     * or lose depending on where it was spliced in.
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
    it.each(CAPABILITY_TOKENS.map((t) => [capabilityTokenName(t), t] as const))(
      '%s exposes an implementation this test can identify',
      (name, token) => {
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
      },
    );
  });

  /**
   * CORE_AUDIT_SINK is not a capability — the enterprise layer does not replace
   * it, it DEPENDS on it. A composing sink injects it to perform the
   * transactional Postgres write it cannot perform itself (ADR-0002 keeps Prisma
   * out of the enterprise package).
   *
   * That makes it part of the enterprise contract even though it is not in
   * CAPABILITY_TOKENS: removing or renaming it would break a layer this
   * repository cannot see, and nothing else here would notice.
   */
  describe('the core audit sink, which enterprise composes over', () => {
    it('is registered and resolves to a concrete implementation', () => {
      const resolved = resolveImplementation(CORE_AUDIT_SINK);
      expect(resolved).not.toBeNull();
      expect(resolved?.cls.name).toBe('PrismaAuditSink');
    });

    it('is what AUDIT_SINK resolves to when no enterprise layer is installed', () => {
      // Core behaviour must be unchanged by the existence of the seam: with
      // nothing installed, the audit sink is still the Postgres one.
      expect(resolveImplementation(AUDIT_SINK)?.cls).toBe(
        resolveImplementation(CORE_AUDIT_SINK)?.cls,
      );
    });

    it('is aliased rather than constructed twice', () => {
      // useClass here would build a SECOND PrismaAuditSink, so an enterprise
      // sink delegating to CORE_AUDIT_SINK and core code using AUDIT_SINK would
      // be writing through different instances.
      expect(registrationFor(AUDIT_SINK)?.kind).toBe('useExisting');
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

          if (consumer.dependencies.includes(cls)) {
            violations.push(
              `${nameOf(consumer.token)} injects ${cls.name} directly instead of ` +
                `${capabilityTokenName(token)} (registered ${kind}) — an enterprise ` +
                `override would be registered and never called`,
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
