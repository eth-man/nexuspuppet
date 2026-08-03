import type { Permission } from '@nexuspuppet/contracts';
import { RoleRegistry } from './role-registry';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type {
  AuthResult,
  AuthenticatedPrincipal,
  Credentials,
  IAuthProvider,
  RedirectChallenge,
} from '@nexuspuppet/contracts';
import { AuthController } from './auth.controller';

/**
 * The external-login routes, exercised through the controller directly.
 *
 * These existed only as a link on the login screen and two optional methods on
 * IAuthProvider: the button pointed at `/auth/redirect`, and no such route was
 * mounted. A redirect-mode provider could not be used at all.
 *
 * What is under test is the half core owns. A provider validates the assertion
 * — signature, issuer, audience, nonce. Core validates that the browser
 * completing a login is the one that began it, and that the place it is sent
 * afterwards is on this origin. Those two are where a redirect flow is
 * classically attacked, and neither depends on which protocol the provider
 * speaks.
 *
 * Driven through the controller rather than over HTTP because the logic is all
 * here; an HTTP harness would test express's routing, which is not ours.
 */

const PRINCIPAL: AuthenticatedPrincipal = {
  userId: '00000000-0000-0000-0000-0000000000aa',
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'ADMIN',
  authSource: 'oidc',
};

class StubRedirectProvider implements IAuthProvider {
  readonly source = 'oidc';
  readonly mode = 'redirect' as const;

  state = 'state-from-provider';
  beganWith: string[] = [];
  completedWith: Array<Record<string, string>> = [];
  accept = true;

  async authenticate(_credentials: Credentials): Promise<AuthResult> {
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }
  async resolve(): Promise<AuthenticatedPrincipal | null> {
    return PRINCIPAL;
  }
  async beginRedirect(returnTo: string): Promise<RedirectChallenge> {
    this.beganWith.push(returnTo);
    return { location: `https://idp.example.com/authorize?state=${this.state}`, state: this.state };
  }
  async completeRedirect(params: Record<string, string>): Promise<AuthResult> {
    this.completedWith.push(params);
    return this.accept
      ? { ok: true, principal: PRINCIPAL }
      : { ok: false, reason: 'INVALID_CREDENTIALS' };
  }
}

/** A credentials provider, to prove the routes refuse to run for one. */
class StubCredentialsProvider implements IAuthProvider {
  readonly source = 'local';
  async authenticate(): Promise<AuthResult> {
    return { ok: true, principal: PRINCIPAL };
  }
  async resolve(): Promise<AuthenticatedPrincipal | null> {
    return PRINCIPAL;
  }
}

interface RecordedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** Just enough of express's Response to observe what the controller does. */
function fakeResponse() {
  const cookies: RecordedCookie[] = [];
  const cleared: string[] = [];
  let redirectedTo: string | null = null;

  return {
    cookies,
    cleared,
    get redirectedTo() {
      return redirectedTo;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.push({ name, value, options });
    },
    clearCookie(name: string) {
      cleared.push(name);
    },
    redirect(location: string) {
      redirectedTo = location;
    },
  };
}

/**
 * A request shaped like the ones this application actually receives.
 *
 * The cookie arrives as a HEADER, because NexusPuppet registers no
 * cookie-parser middleware and parses the header itself. An earlier version of
 * this double supplied a `cookies` object instead — which express would only
 * populate with that middleware — so the tests passed against a request shape
 * the server never sees, and the route could not work in production. A double
 * that agrees with the code rather than with the system proves nothing.
 */
const fakeRequest = (cookies: Record<string, string> = {}) => {
  const header = Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
  return {
    ip: '10.0.0.1',
    headers: header.length > 0 ? { cookie: header } : {},
    socket: {},
    get: () => undefined,
  };
};

const STATE_COOKIE = 'nexuspuppet_redirect_state';

const stubRoles = {
  permissionsFor: () => new Set<Permission>(['inventory:read']),
  knownRoles: () => ['VIEWER'],
} as unknown as RoleRegistry;

describe('external login routes', () => {
  let provider: StubRedirectProvider;
  let controller: AuthController;
  let issued: AuthenticatedPrincipal[];

  beforeEach(() => {
    provider = new StubRedirectProvider();
    issued = [];

    const tokens = {
      issue: async (principal: AuthenticatedPrincipal) => {
        issued.push(principal);
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accessExpiresAt: new Date(Date.now() + 900_000),
          refreshExpiresAt: new Date(Date.now() + 604_800_000),
        };
      },
    };

    // A resolver holding just this provider. The redirect endpoints now ask the
    // resolver for the redirect-mode provider rather than assuming the single
    // configured provider is one (ADR-0015).
    const resolver = {
      redirectProvider: () => provider,
      credentialProviders: () => [],
      authenticate: (credentials: never) => provider.authenticate(credentials),
      forSource: (source: string) => (source === provider.source ? provider : null),
      sources: () => [provider.source],
    };

    controller = new AuthController(
      resolver as never,
      provider,
      tokens as never,
      { consume: () => true, reset: () => undefined } as never,
      stubRoles,
    );
  });

  const begin = async (returnTo?: string) => {
    const res = fakeResponse();
    await controller.beginRedirect(returnTo, fakeRequest() as never, res as never);
    return res;
  };

  describe('beginning a login', () => {
    it('sends the browser to the identity provider', async () => {
      const res = await begin();

      expect(res.redirectedTo).toContain('https://idp.example.com/authorize');
    });

    /**
     * The state cookie binds the callback to this browser. Without it anyone
     * could complete a login in someone else's session.
     */
    it('stores the state in an httpOnly cookie scoped to /auth', async () => {
      const res = await begin();

      const cookie = res.cookies.find((c) => c.name === STATE_COOKIE);
      expect(cookie).toBeDefined();
      expect(cookie?.options['httpOnly']).toBe(true);
      expect(cookie?.options['path']).toBe('/auth');
    });

    /**
     * LAX, never STRICT. The browser arrives at the callback FROM the identity
     * provider's domain; a strict cookie is withheld on that navigation, and
     * every login would fail.
     */
    it('uses SameSite=Lax so the cookie survives the return leg', async () => {
      const res = await begin();

      expect(res.cookies.find((c) => c.name === STATE_COOKIE)?.options['sameSite']).toBe('lax');
    });

    it('passes a safe returnTo through to the provider', async () => {
      await begin('/nodes');

      expect(provider.beganWith).toEqual(['/nodes']);
    });

    it('never carries an off-origin returnTo, even into the provider', async () => {
      await begin('https://evil.test/steal');

      expect(provider.beganWith).toEqual(['/']);
    });

    it('refuses when the deployment does not use an external provider', async () => {
      const credentialsOnly = new StubCredentialsProvider();
      const localResolver = {
        redirectProvider: () => null,
        credentialProviders: () => [credentialsOnly],
        sources: () => [credentialsOnly.source],
      };
      const local = new AuthController(
        localResolver as never,
        credentialsOnly,
        {} as never,
        {} as never,
        stubRoles,
      );

      await expect(
        local.beginRedirect(undefined, fakeRequest() as never, fakeResponse() as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('completing a login', () => {
    const callback = async (params: Record<string, string>, cookie?: string) => {
      const res = fakeResponse();
      await controller.completeRedirect(
        params,
        fakeRequest(cookie === undefined ? {} : { [STATE_COOKIE]: cookie }) as never,
        res as never,
      );
      return res;
    };

    const cookieFor = (returnTo = '/nodes') => `${provider.state}|${returnTo}`;

    it('issues a session and returns the browser to where it started', async () => {
      const res = await callback({ state: provider.state, code: 'abc' }, cookieFor('/nodes'));

      expect(issued).toEqual([PRINCIPAL]);
      expect(res.redirectedTo).toBe('/nodes');
      expect(res.cookies.map((c) => c.name)).toEqual(
        expect.arrayContaining(['nexuspuppet_access', 'nexuspuppet_refresh']),
      );
    });

    it('hands the provider every callback parameter', async () => {
      await callback({ state: provider.state, code: 'abc', session_state: 'xyz' }, cookieFor());

      expect(provider.completedWith[0]).toMatchObject({ code: 'abc', session_state: 'xyz' });
    });

    /**
     * Login CSRF, and the reason the state cookie exists. Without this an
     * attacker begins a login as themselves, hands the victim the resulting
     * callback URL, and the victim's browser ends up signed in as the attacker —
     * with everything they subsequently do recorded against that account.
     */
    it('refuses a callback whose state does not match the cookie', async () => {
      await expect(
        callback({ state: 'attacker-chosen', code: 'abc' }, cookieFor()),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(issued).toEqual([]);
      expect(provider.completedWith).toEqual([]);
    });

    it('refuses a callback with no state cookie at all', async () => {
      await expect(callback({ state: provider.state, code: 'abc' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a callback with no state parameter', async () => {
      await expect(callback({ code: 'abc' }, cookieFor())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    /** Single use: a state surviving one attempt could be replayed. */
    it('clears the state cookie even when the callback fails', async () => {
      await expect(callback({ state: 'wrong', code: 'abc' }, cookieFor())).rejects.toThrow();

      // Cleared BEFORE the state check, so a rejected attempt cannot leave a
      // usable state behind.
      const res = fakeResponse();
      await controller
        .completeRedirect(
          { state: 'wrong' },
          fakeRequest({ [STATE_COOKIE]: cookieFor() }) as never,
          res as never,
        )
        .catch(() => undefined);
      expect(res.cleared).toContain(STATE_COOKIE);
    });

    it('issues no session when the provider refuses', async () => {
      provider.accept = false;

      await expect(
        callback({ state: provider.state, code: 'abc' }, cookieFor()),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(issued).toEqual([]);
    });

    /**
     * The destination comes from the COOKIE, not the callback query — so an
     * attacker able to craft the callback URL still cannot choose where a
     * browser lands once it holds a session.
     */
    it('ignores a returnTo supplied on the callback itself', async () => {
      const res = await callback(
        { state: provider.state, code: 'abc', returnTo: 'https://evil.test' },
        cookieFor('/nodes'),
      );

      expect(res.redirectedTo).toBe('/nodes');
    });

    /** A tampered cookie must not become an open redirect either. */
    it('re-validates the returnTo stored in the cookie', async () => {
      const res = await callback(
        { state: provider.state, code: 'abc' },
        `${provider.state}|https://evil.test/steal`,
      );

      expect(res.redirectedTo).toBe('/');
    });
  });
});
