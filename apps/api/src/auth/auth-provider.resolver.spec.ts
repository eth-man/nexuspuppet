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
    it('describes every registered source, not just the local one', () => {
      expect(resolver().descriptors()).toEqual([
        { source: 'ldap', mode: 'credentials', identifierLabel: 'Email' },
        { source: 'local', mode: 'credentials', identifierLabel: 'Email' },
      ]);
    });

    it('reports a redirect provider, which is what draws the SSO button', () => {
      const oidc: IAuthProvider = { ...stub('oidc', 'unused'), mode: 'redirect' };
      const withSso = new AuthProviderResolver([local, oidc], fakePrisma(accounts), 0);

      expect(withSso.descriptors()).toEqual([
        { source: 'local', mode: 'credentials', identifierLabel: 'Email' },
        { source: 'oidc', mode: 'redirect', identifierLabel: 'Email' },
      ]);
    });

    it("carries each provider's own identifier label", () => {
      const ad: IAuthProvider = { ...stub('ldap', 'x'), identifierLabel: 'Username' };
      const withAd = new AuthProviderResolver([local, ad], fakePrisma(accounts), 0);

      expect(withAd.descriptors().find((d) => d.source === 'ldap')?.identifierLabel).toBe(
        'Username',
      );
    });

    /*
     * Insertion order is whatever DI happened to produce. A login page that
     * reorders its own buttons between polls is a login page nobody trusts.
     */
    it('is sorted, so the answer does not depend on registration order', () => {
      const forwards = new AuthProviderResolver([local, ldap], fakePrisma(accounts), 0);
      const backwards = new AuthProviderResolver([ldap, local], fakePrisma(accounts), 0);

      expect(forwards.descriptors()).toEqual(backwards.descriptors());
    });

    it('is a list even with one source', () => {
      const alone = new AuthProviderResolver([local], fakePrisma(accounts), 0);

      expect(alone.descriptors()).toHaveLength(1);
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
      // A licence expired, or the directory was disabled. The session must end
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
