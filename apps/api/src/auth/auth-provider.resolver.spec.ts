import { Logger } from '@nestjs/common';
import type { AuthResult, Credentials, IAuthProvider } from '@nexuspuppet/contracts';
import { AuthProviderResolver } from './auth-provider.resolver';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Dispatch by `authSource`, and refuse in constant time (ADR-0015).
 *
 * The behaviour under test is what stops enabling a directory from locking
 * every local account out — the defect that shipped in v1.0.0 and was found by
 * enabling LDAP on a real VM.
 */

const principal = (email: string, source: string) => ({
  userId: 'u-' + email,
  email,
  displayName: email,
  role: 'ADMIN' as const,
  authSource: source,
});

/** A provider that succeeds for one password and costs a fixed amount of time. */
function stub(source: string, password: string, costMs = 0): IAuthProvider {
  return {
    source,
    async authenticate(credentials: Credentials): Promise<AuthResult> {
      if (costMs > 0) await new Promise((r) => setTimeout(r, costMs));
      return credentials.password === password
        ? { ok: true, principal: principal(credentials.email, source) }
        : { ok: false, reason: 'INVALID_CREDENTIALS' };
    },
    async resolve(userId: string) {
      return principal(userId, source);
    },
  };
}

/** Only the two lookups the resolver performs. */
function fakePrisma(accounts: Record<string, string>): PrismaService {
  return {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        const key = where.email ?? where.id ?? '';
        const authSource = accounts[key];
        return authSource === undefined ? null : { authSource };
      },
    },
  } as unknown as PrismaService;
}

describe('AuthProviderResolver', () => {
  const local = stub('local', 'local-pw');
  const ldap = stub('ldap', 'ldap-pw');

  const accounts = {
    'admin@example.com': 'local',
    'dave@corp.test': 'ldap',
    'orphan@corp.test': 'saml', // an authSource nothing provides
  };

  // Zero floor for the dispatch tests: timing has its own describe below, and
  // paying 1.5s per case would make this suite take a minute.
  const resolver = () => new AuthProviderResolver([local, ldap], fakePrisma(accounts), 0);

  /**
   * What the login page is rendered from (ADR-0023 §3).
   *
   * The endpoint that answers this used to read the `AUTH_PROVIDER` token,
   * which the registry pins to core's local provider and refuses to let
   * anything replace (ADR-0015 §3) — so every deployment described itself as
   * `local`, whatever it was actually running. These assert the description
   * comes from the registered providers instead.
   */
  describe('descriptors', () => {
    it('describes every registered source, not just the local one', async () => {
      expect(await resolver().descriptors()).toEqual([
        { source: 'ldap', mode: 'credentials', identifierLabel: 'Email' },
        { source: 'local', mode: 'credentials', identifierLabel: 'Email' },
      ]);
    });

    it('reports a redirect provider, which is what draws the SSO button', async () => {
      const oidc: IAuthProvider = { ...stub('oidc', 'unused'), mode: 'redirect' };
      const withSso = new AuthProviderResolver([local, oidc], fakePrisma(accounts), 0);

      expect(await withSso.descriptors()).toEqual([
        { source: 'local', mode: 'credentials', identifierLabel: 'Email' },
        { source: 'oidc', mode: 'redirect', identifierLabel: 'Email' },
      ]);
    });

    it("carries each provider's own identifier label", async () => {
      const ad: IAuthProvider = { ...stub('ldap', 'x'), identifierLabel: 'Username' };
      const withAd = new AuthProviderResolver([local, ad], fakePrisma(accounts), 0);

      expect((await withAd.descriptors()).find((d) => d.source === 'ldap')?.identifierLabel).toBe(
        'Username',
      );
    });

    /*
     * Insertion order is whatever DI happened to produce. A login page that
     * reorders its own buttons between polls is a login page nobody trusts.
     */
    it('is sorted, so the answer does not depend on registration order', async () => {
      const forwards = new AuthProviderResolver([local, ldap], fakePrisma(accounts), 0);
      const backwards = new AuthProviderResolver([ldap, local], fakePrisma(accounts), 0);

      expect(await forwards.descriptors()).toEqual(await backwards.descriptors());
    });

    it('is a list even with one source', async () => {
      const alone = new AuthProviderResolver([local], fakePrisma(accounts), 0);

      expect(await alone.descriptors()).toHaveLength(1);
    });
  });

  /**
   * Registered is not configured (ADR-0029).
   *
   * Both directory providers exist on every deployment so one can be enabled
   * from the console without a restart. With nothing to point at, a provider
   * is DORMANT, and the resolver must treat it as absent everywhere a user can
   * see — and refuse its accounts exactly as it refuses a wrong password.
   */
  describe('a dormant provider', () => {
    /** A provider whose configuration can be switched on and off mid-test. */
    function switchable(source: string, password: string, mode?: 'redirect') {
      const state = { configured: false };
      const provider: IAuthProvider = {
        ...stub(source, password),
        ...(mode === undefined ? {} : { mode }),
        isConfigured: async () => state.configured,
      };
      return { provider, state };
    }

    const warn = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    afterEach(() => jest.restoreAllMocks());

    it('is not offered on the login page', async () => {
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      expect((await r.descriptors()).map((d) => d.source)).toEqual(['local']);
    });

    it('appears on the login page the moment it is configured, with no new resolver', async () => {
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      dormant.state.configured = true;

      expect((await r.descriptors()).map((d) => d.source)).toEqual(['ldap', 'local']);
    });

    it('is still a registered source, so accounts can be provisioned for it', async () => {
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      expect(r.sources()).toEqual(['ldap', 'local']);
      expect(await r.provisionableSources()).toEqual([
        { source: 'ldap', mode: 'credentials', identifierLabel: 'Email', configured: false },
        { source: 'local', mode: 'credentials', identifierLabel: 'Email', configured: true },
      ]);
    });

    it('is never the redirect provider', async () => {
      const sso = switchable('oidc', 'unused', 'redirect');
      const r = new AuthProviderResolver([local, sso.provider], fakePrisma(accounts), 0);

      await expect(r.redirectProvider()).resolves.toBeNull();

      sso.state.configured = true;
      await expect(r.redirectProvider()).resolves.toBe(sso.provider);
    });

    it('is not the provider described to an administrator', async () => {
      const dormant = switchable('ldap', 'ldap-pw');
      const described: IAuthProvider = {
        ...dormant.provider,
        describe: () => ({
          source: 'ldap',
          roleMappings: [],
          refusesUnmappedUsers: true,
          details: [],
        }),
      };
      const r = new AuthProviderResolver([local, described], fakePrisma(accounts), 0);

      await expect(r.describableProvider()).resolves.toBe(local);
    });

    it('refuses its accounts with the SAME answer as a wrong password', async () => {
      warn();
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      // The RIGHT password, which the provider would accept if it were asked.
      const refused = await r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' });
      const wrong = await r.authenticate({ email: 'admin@example.com', password: 'nope' });

      expect(refused).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
      expect(refused).toEqual(wrong);
    });

    it('lets the same login through once it is configured', async () => {
      warn();
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      await expect(
        r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' }),
      ).resolves.toMatchObject({ ok: false });

      dormant.state.configured = true;

      await expect(
        r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('never touches local accounts', async () => {
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      await expect(
        r.authenticate({ email: 'admin@example.com', password: 'local-pw' }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('says why in the log, once per change of state, not once per attempt', async () => {
      const spy = warn();
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      for (let i = 0; i < 5; i += 1) {
        await r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' });
      }
      const dormantLines = () =>
        spy.mock.calls.filter(([line]) => String(line).includes('LDAP sign-in is not configured'));
      expect(dormantLines()).toHaveLength(1);

      // Configured, then discarded again: a NEW state, so it is said again.
      dormant.state.configured = true;
      await r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' });
      dormant.state.configured = false;
      await r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' });

      expect(dormantLines()).toHaveLength(2);
    });

    it('ends its sessions at refresh, as a deregistered one does', async () => {
      warn();
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      await expect(r.resolve('dave@corp.test')).resolves.toBeNull();
      await expect(r.resolve('admin@example.com')).resolves.toMatchObject({ authSource: 'local' });
    });

    it('does not count as a configured directory for the no-account warning', async () => {
      const spy = warn();
      const dormant = switchable('ldap', 'ldap-pw');
      const r = new AuthProviderResolver([local, dormant.provider], fakePrisma(accounts), 0);

      await r.authenticate({ email: 'nobody@corp.test', password: 'x' });

      expect(spy).not.toHaveBeenCalled();
    });

    it('is treated as configured when it cannot say, so it fails loudly rather than vanishing', async () => {
      warn();
      const confused: IAuthProvider = {
        ...stub('ldap', 'ldap-pw'),
        isConfigured: async () => {
          throw new Error('store unreadable');
        },
      };
      const r = new AuthProviderResolver([local, confused], fakePrisma(accounts), 0);

      expect((await r.descriptors()).map((d) => d.source)).toEqual(['ldap', 'local']);
    });
  });

  describe('dispatch', () => {
    it('sends a local account to the local provider', async () => {
      const result = await resolver().authenticate({
        email: 'admin@example.com',
        password: 'local-pw',
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.principal.authSource).toBe('local');
    });

    it('sends a directory account to the directory provider', async () => {
      const result = await resolver().authenticate({
        email: 'dave@corp.test',
        password: 'ldap-pw',
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.principal.authSource).toBe('ldap');
    });

    it('serves both at once — the whole point of the change', async () => {
      const r = resolver();
      const [localResult, ldapResult] = await Promise.all([
        r.authenticate({ email: 'admin@example.com', password: 'local-pw' }),
        r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' }),
      ]);

      expect([localResult.ok, ldapResult.ok]).toEqual([true, true]);
    });

    it('does NOT fall back to another provider when the owner refuses', async () => {
      // The security property. If a directory account could be authenticated by
      // the local provider, anyone able to create a local account could shadow a
      // directory identity and bypass whatever that directory enforces.
      const result = await resolver().authenticate({
        email: 'dave@corp.test',
        password: 'local-pw',
      });

      expect(result.ok).toBe(false);
    });

    it('refuses an account whose authSource has no provider', async () => {
      // The password is one that WOULD work on the local provider. If the
      // resolver ever fell back to "some provider" rather than "the account's
      // provider", this would succeed — and an account belonging to a
      // deregistered directory would be authenticable by whatever remains.
      const result = await resolver().authenticate({
        email: 'orphan@corp.test',
        password: 'local-pw',
      });

      expect(result.ok).toBe(false);
    });

    it('refuses even when another provider would accept the same password', async () => {
      // Direct test of the no-chaining rule: dave is an ldap account, and
      // 'local-pw' is the local provider's password. Chaining after a refusal
      // would let a local credential authenticate a directory identity.
      const chained = new AuthProviderResolver(
        [stub('local', 'shared-pw'), stub('ldap', 'ldap-pw')],
        fakePrisma(accounts),
        0,
      );

      await expect(
        chained.authenticate({ email: 'dave@corp.test', password: 'shared-pw' }),
      ).resolves.toMatchObject({ ok: false });
    });

    it('refuses an unknown address', async () => {
      const result = await resolver().authenticate({
        email: 'nobody@corp.test',
        password: 'anything',
      });

      expect(result.ok).toBe(false);
    });
  });

  /**
   * The silent refusal (2026-08-09).
   *
   * A directory user with no account row is refused before the provider is
   * ever asked, and nothing was logged — so a freshly configured LDAP
   * deployment looked identical to a wrong password. The answer must stay
   * identical; the LOG must not.
   */
  describe('a directory login refused for want of an account', () => {
    const warn = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    afterEach(() => jest.restoreAllMocks());

    it('says so in the log, naming the sources an account could use', async () => {
      const spy = warn();

      await resolver().authenticate({ email: 'nobody@corp.test', password: 'x' });

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('no account exists'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('ldap'));
    });

    /*
     * On core an unknown address is a typo. Warning about every one of them is
     * noise, and noise is what teaches an operator to stop reading the log.
     */
    it('stays quiet when local is the only source', async () => {
      const spy = warn();
      const localOnly = new AuthProviderResolver([local], fakePrisma(accounts), 0);

      await localOnly.authenticate({ email: 'nobody@corp.test', password: 'x' });

      expect(spy).not.toHaveBeenCalled();
    });

    /*
     * `credentialsSchema` is `z.string().min(1).max(255)` with no `.email()`,
     * deliberately: an AD deployment logs in with a username. So a submitted
     * identifier can contain a newline, `trim()` only strips the ends, and a
     * raw interpolation would let an unauthenticated caller forge log entries
     * beneath a line that looks like ours.
     */
    it('cannot be used to forge log lines', async () => {
      const spy = warn();
      const forged = 'x@corp.test\n2026-08-09 ERROR [Bootstrap] Everything is fine';

      await resolver().authenticate({ email: forged, password: 'x' });

      const logged = String(spy.mock.calls[0]?.[0] ?? '');
      // The newline is escaped, so the whole thing stays one line.
      expect(logged).not.toContain('\n');
      expect(logged).toContain('\\n');
      expect(logged.split('\n')).toHaveLength(1);
    });

    /*
     * The login limiter keys on `${ip}|${email}`, so varying the address buys a
     * fresh bucket every request — it does NOT bound this. Without a throttle,
     * an unauthenticated caller writes one log line per request for as long as
     * they like.
     */
    it('cannot be driven by a stranger varying the address', async () => {
      const spy = warn();
      const r = resolver();

      for (let i = 0; i < 50; i += 1) {
        await r.authenticate({ email: `nobody${String(i)}@corp.test`, password: 'x' });
      }

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reports how many it swallowed, so the throttle cannot hide a flood', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-09T12:00:00Z'));
      const spy = warn();
      const r = resolver();

      await r.authenticate({ email: 'a@corp.test', password: 'x' });
      await r.authenticate({ email: 'b@corp.test', password: 'x' });
      await r.authenticate({ email: 'c@corp.test', password: 'x' });

      jest.setSystemTime(new Date('2026-08-09T12:01:30Z'));
      await r.authenticate({ email: 'd@corp.test', password: 'x' });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(expect.stringContaining('2 similar suppressed'));
      jest.useRealTimers();
    });

    it('still refuses identically, so the answer is no oracle', async () => {
      warn();

      const unknown = await resolver().authenticate({ email: 'nobody@corp.test', password: 'x' });
      const wrongPassword = await resolver().authenticate({
        email: 'dave@corp.test',
        password: 'wrong',
      });

      expect(unknown).toEqual(wrongPassword);
    });
  });

  describe('refresh fails closed', () => {
    it('resolves a principal while the provider exists', async () => {
      await expect(resolver().resolve('dave@corp.test')).resolves.toMatchObject({
        authSource: 'ldap',
      });
    });

    it('returns null when the provider is gone, rather than throwing', async () => {
      // The directory was switched off. The session must end
      // cleanly — a throw here is a 500 on every refresh (ADR-0015 §3).
      const withoutLdap = new AuthProviderResolver([local], fakePrisma(accounts), 0);

      await expect(withoutLdap.resolve('dave@corp.test')).resolves.toBeNull();
    });

    it('local sessions survive the directory disappearing', async () => {
      const withoutLdap = new AuthProviderResolver([local], fakePrisma(accounts), 0);

      await expect(withoutLdap.resolve('admin@example.com')).resolves.toMatchObject({
        authSource: 'local',
      });
    });
  });

  describe('a refusal takes the same time whoever refused it', () => {
    /**
     * The enumeration oracle this floor exists to close.
     *
     * A local refusal costs a scrypt; a directory refusal costs a network round
     * trip. Left alone, the difference tells an attacker which of "no account",
     * "local account" and "directory account" they are looking at without ever
     * guessing a password.
     *
     * Asserted as a floor rather than an equality: timers are not exact, and a
     * test demanding equal milliseconds would be flaky forever.
     */
    const FLOOR = 300;

    const timed = async (email: string): Promise<number> => {
      // Providers with wildly different costs, which is the realistic case.
      const fast = stub('local', 'local-pw', 0);
      const slow = stub('ldap', 'ldap-pw', 120);
      const r = new AuthProviderResolver([fast, slow], fakePrisma(accounts), FLOOR);

      const startedAt = Date.now();
      await r.authenticate({ email, password: 'wrong' });
      return Date.now() - startedAt;
    };

    it.each([
      ['an unknown address', 'nobody@corp.test'],
      ['a local account', 'admin@example.com'],
      ['a directory account', 'dave@corp.test'],
      ['an account whose provider is gone', 'orphan@corp.test'],
    ])('%s takes at least the floor', async (_label, email) => {
      // -20ms of slack: setTimeout may fire fractionally early, and a test that
      // fails on timer jitter teaches people to rerun CI rather than to look.
      expect(await timed(email)).toBeGreaterThanOrEqual(FLOOR - 20);
    });

    /*
     * A dormant directory answers without any network round trip at all —
     * the fastest refusal there is, and so the most tempting oracle. The floor
     * must cover it like every other path (ADR-0029 §2).
     */
    it('an account whose directory is dormant takes at least the floor', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const dormant: IAuthProvider = {
        ...stub('ldap', 'ldap-pw', 0),
        isConfigured: async () => false,
      };
      const r = new AuthProviderResolver(
        [stub('local', 'local-pw', 0), dormant],
        fakePrisma(accounts),
        FLOOR,
      );

      const startedAt = Date.now();
      const result = await r.authenticate({ email: 'dave@corp.test', password: 'ldap-pw' });

      expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FLOOR - 20);
      jest.restoreAllMocks();
    });

    it('does not pad a SUCCESSFUL login beyond the floor either', async () => {
      // Otherwise the padding itself leaks: a success that returns immediately
      // while every failure waits is the same oracle in reverse.
      const fast = stub('local', 'local-pw', 0);
      const r = new AuthProviderResolver([fast], fakePrisma(accounts), FLOOR);

      const startedAt = Date.now();
      const result = await r.authenticate({ email: 'admin@example.com', password: 'local-pw' });

      expect(result.ok).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FLOOR - 20);
    });
  });

  it('refuses to start when two providers claim one source', () => {
    // A build error, not a runtime condition: a login would dispatch to
    // whichever won a Map insertion race.
    expect(() => new AuthProviderResolver([local, stub('local', 'x')], fakePrisma({}), 0)).toThrow(
      /both claim source/i,
    );
  });
});
