import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import type { DirectoryUser, IUserDirectory, UserRole } from '@nexuspuppet/contracts';
import { oidcConfigFromEnv, resolveOidcRole, type OidcConfig } from '../src/oidc/config';
import { OidcDirectory, type OidcHttp } from '../src/oidc/discovery';
import type { JsonWebKey } from '../src/oidc/id-token';
import { OidcAuthProvider, type TokenExchange } from '../src/oidc/oidc-auth.provider';

/**
 * The OIDC provider end to end, with no network and no clock.
 *
 * The authorization request, the PKCE binding, the callback, and the decision
 * about who someone is once their token checks out. Signatures are real; only
 * the transport is substituted.
 */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'nexuspuppet';
const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const now = () => NOW;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'key-1', use: 'sig' };

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

class FakeHttp implements OidcHttp {
  document: Record<string, unknown> = { ...DISCOVERY };
  keys: JsonWebKey[] = [jwk];
  getCount = 0;

  async getJson(url: string): Promise<unknown> {
    this.getCount += 1;
    if (url.endsWith('/.well-known/openid-configuration')) return this.document;
    if (url === DISCOVERY.jwks_uri) return { keys: this.keys };
    throw new Error(`unexpected GET ${url}`);
  }
  async postForm(): Promise<unknown> {
    throw new Error('not used');
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function idToken(claims: Record<string, unknown>, kid = 'key-1'): string {
  const body = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
  const signer = createSign('sha256');
  signer.update(body);
  return `${body}.${signer.sign(privateKey, 'base64url')}`;
}

class FakeExchange implements TokenExchange {
  lastVerifier: string | null = null;
  respond: { id_token?: string; access_token?: string } = {};
  fail: string | null = null;

  async redeem(params: { tokenEndpoint: string; code: string; verifier: string }) {
    if (this.fail !== null) throw new Error(this.fail);
    this.lastVerifier = params.verifier;
    return this.respond;
  }
}

class FakeDirectoryUsers implements IUserDirectory {
  readonly readOnly = false;
  users = new Map<string, DirectoryUser>();
  logins: Array<{ userId: string; role: UserRole; displayName: string }> = [];
  failRecordLogin = false;

  async findByEmail(email: string): Promise<DirectoryUser | null> {
    return this.users.get(email.toLowerCase()) ?? null;
  }
  async findById(userId: string): Promise<DirectoryUser | null> {
    return [...this.users.values()].find((u) => u.userId === userId) ?? null;
  }
  async recordLogin(userId: string, patch: { role: UserRole; displayName: string }): Promise<void> {
    if (this.failRecordLogin) throw new Error('database unavailable');
    this.logins.push({ userId, ...patch });
  }
  async list(): Promise<{ users: DirectoryUser[]; total: number }> {
    const users = [...this.users.values()];
    return { users, total: users.length };
  }
}

const silentLogger = { log: () => undefined, warn: () => undefined };

const config = (over: Partial<OidcConfig> = {}): OidcConfig => ({
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: 'https://nexuspuppet.example.com/api/auth/callback',
  scopes: ['profile', 'email'],
  emailClaim: 'email',
  displayNameClaim: 'name',
  groupsClaim: 'groups',
  roleMappings: [{ group: 'puppet-admins', role: 'ADMIN' }],
  timeoutMs: 10_000,
  clockSkewSeconds: 60,
  ...over,
});

function build(
  over: Partial<OidcConfig> = {},
  seams: {
    settings?: { resolve(source: string): Promise<unknown | null> };
    directoryFor?: (config: OidcConfig) => OidcDirectory;
    exchangeFor?: (config: OidcConfig) => FakeExchange;
    /** Capture what the provider says, for the refusals that exist to explain themselves. */
    logger?: { log(m: string): void; warn(m: string): void };
  } = {},
) {
  const http = new FakeHttp();
  const exchange = new FakeExchange();
  const identities = new FakeDirectoryUsers();
  const directory = new OidcDirectory(ISSUER, http, 10_000, now);
  const provider = new OidcAuthProvider({
    config: config(over),
    directory,
    identities,
    logger: seams.logger ?? silentLogger,
    exchange,
    now,
    ...(seams.settings === undefined ? {} : { settings: seams.settings }),
    ...(seams.directoryFor === undefined ? {} : { directoryFor: seams.directoryFor }),
    ...(seams.exchangeFor === undefined ? {} : { exchangeFor: seams.exchangeFor }),
  });
  return { provider, http, exchange, identities, directory };
}

const ACCOUNT: DirectoryUser = {
  userId: 'u-1',
  email: 'alice@example.com',
  displayName: 'Alice (stale)',
  role: 'VIEWER',
  isActive: true,
  authSource: 'oidc',
};

const claimsFor = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: 'idp-subject-1',
  aud: CLIENT_ID,
  exp: Math.floor(NOW / 1000) + 300,
  iat: Math.floor(NOW / 1000) - 5,
  email: 'alice@example.com',
  name: 'Alice Ng',
  groups: ['puppet-admins'],
  ...over,
});

describe('OidcAuthProvider — beginning a login', () => {
  it('builds an authorization request with the required parameters', async () => {
    const { provider } = build();

    const challenge = await provider.beginRedirect('/nodes');
    const url = new URL(challenge.location);

    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(config().redirectUri);
    expect(url.searchParams.get('state')).toBe(challenge.state);
    expect(url.searchParams.get('nonce')).not.toBeNull();
  });

  /** `openid` is what makes this OIDC rather than plain OAuth. */
  it('always requests the openid scope', async () => {
    const { provider } = build({ scopes: ['email'] });

    const url = new URL((await provider.beginRedirect('/')).location);

    expect(url.searchParams.get('scope')?.split(' ')).toContain('openid');
  });

  /**
   * S256, never `plain`. A plain challenge IS the verifier, so anyone who can
   * read the authorization request can complete the exchange.
   */
  it('uses S256 PKCE and sends only the challenge', async () => {
    const { provider } = build();

    const url = new URL((await provider.beginRedirect('/')).location);

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier itself must not appear anywhere in the request.
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });

  it('mints a distinct state and nonce per login', async () => {
    const { provider } = build();

    const a = await provider.beginRedirect('/');
    const b = await provider.beginRedirect('/');

    expect(a.state).not.toBe(b.state);
    expect(new URL(a.location).searchParams.get('nonce')).not.toBe(
      new URL(b.location).searchParams.get('nonce'),
    );
  });
});

/**
 * A saved configuration taking effect without a restart (#106 on #113's seam).
 *
 * The property under test is which ISSUER an assertion is validated against —
 * getting it wrong would accept a token minted by a provider nobody chose.
 */
describe('OidcAuthProvider with a settings reader', () => {
  it('uses its boot configuration when nothing is stored', async () => {
    const rebuilt = jest.fn();
    const { provider } = build(
      {},
      {
        settings: { resolve: async () => null },
        directoryFor: rebuilt as never,
      },
    );

    await provider.beginRedirect('/');

    expect(rebuilt).not.toHaveBeenCalled();
  });

  it('builds the authorization request from the STORED configuration', async () => {
    const stored = { ...config(), clientId: 'stored-client' };
    const made: OidcDirectory[] = [];
    const { provider, directory } = build(
      {},
      {
        settings: { resolve: async () => stored },
        directoryFor: () => {
          made.push(directory);
          return directory;
        },
      },
    );

    const challenge = await provider.beginRedirect('/');

    expect(new URL(challenge.location).searchParams.get('client_id')).toBe('stored-client');
    expect(made).toHaveLength(1);
  });

  it('rebuilds the issuer clients only when the configuration changes', async () => {
    let stored = { ...config(), clientId: 'one' };
    let made = 0;
    const { provider, directory } = build(
      {},
      {
        settings: { resolve: async () => stored },
        directoryFor: () => {
          made += 1;
          return directory;
        },
      },
    );

    await provider.beginRedirect('/');
    await provider.beginRedirect('/');
    expect(made).toBe(1);

    stored = { ...stored, clientId: 'two' };
    await provider.beginRedirect('/');
    // Discovery and JWKS are cached per client, so rebuilding per login would
    // refetch both on every sign-in.
    expect(made).toBe(2);
  });

  it('refuses rather than falling back when the stored configuration is unusable', async () => {
    const { provider } = build(
      {},
      { settings: { resolve: async () => ({ issuer: 'not-a-url' }) } },
    );

    // Completing against the boot issuer would accept an assertion from a
    // provider the operator has replaced.
    await expect(provider.beginRedirect('/')).rejects.toThrow(/does not match/);
  });

  it('inherits the client secret when a saved configuration omits it', async () => {
    const seen: Array<string | undefined> = [];
    const { provider, directory, exchange } = build(
      { clientSecret: 'boot-secret' },
      {
        // Write-only, so the console never had it to send back.
        settings: { resolve: async () => ({ ...config(), clientId: 'edited' }) },
        directoryFor: () => directory,
        exchangeFor: (c) => {
          seen.push(c.clientSecret);
          return exchange;
        },
      },
    );

    await provider.beginRedirect('/');

    expect(seen).toEqual(['boot-secret']);
  });
});

describe('OidcAuthProvider — completing a login', () => {
  const succeed = async (
    over: Record<string, unknown> = {},
    mutate?: (b: ReturnType<typeof build>) => void,
  ) => {
    const built = build();
    built.identities.users.set(ACCOUNT.email, { ...ACCOUNT });
    mutate?.(built);

    const challenge = await built.provider.beginRedirect('/nodes');
    const nonce = new URL(challenge.location).searchParams.get('nonce') as string;
    built.exchange.respond = { id_token: idToken(claimsFor({ nonce, ...over })) };

    const result = await built.provider.completeRedirect({
      state: challenge.state,
      code: 'auth-code',
    });
    return { ...built, result, challenge };
  };

  it('authenticates and maps the group to a role', async () => {
    const { result } = await succeed();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.email).toBe('alice@example.com');
    expect(result.principal.role).toBe('ADMIN');
    expect(result.principal.authSource).toBe('oidc');
  });

  /**
   * The wiring the unit tests above cannot see: a union has to survive onto the
   * principal, because `roles` is what authorization actually reads.
   */
  it('carries every unioned role onto the principal', async () => {
    const built = build({
      roleMappings: [
        { group: 'puppet-admins', role: 'ADMIN' },
        { group: 'auditors', role: 'auditor' },
      ],
    });
    built.identities.users.set(ACCOUNT.email, { ...ACCOUNT });

    const challenge = await built.provider.beginRedirect('/');
    const nonce = new URL(challenge.location).searchParams.get('nonce') as string;
    built.exchange.respond = {
      id_token: idToken(claimsFor({ nonce, groups: ['puppet-admins', 'auditors'] })),
    };

    const result = await built.provider.completeRedirect({
      state: challenge.state,
      code: 'auth-code',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.role).toBe('ADMIN');
    expect(result.principal.roles).toEqual(['ADMIN', 'auditor']);
  });

  /** The common case must read exactly as it did before roles could union. */
  it('carries no roles array when one role applies', async () => {
    const { result } = await succeed();

    expect(result.ok && result.principal.roles).toBeUndefined();
  });

  /** The identity provider is authoritative for the name. */
  it('prefers the identity provider display name over the stored one', async () => {
    const { result } = await succeed();

    expect(result.ok && result.principal.displayName).toBe('Alice Ng');
  });

  it('sends the PKCE verifier only at the token exchange', async () => {
    const { exchange, challenge } = await succeed();

    expect(exchange.lastVerifier).not.toBeNull();
    // And it is the pre-image of what was published in the authorization URL.
    const published = new URL(challenge.location).searchParams.get('code_challenge');
    expect(
      createHash('sha256')
        .update(exchange.lastVerifier as string)
        .digest('base64url'),
    ).toBe(published);
  });

  it('caches the resolved role so a refreshed token agrees with the login', async () => {
    const { identities } = await succeed();

    expect(identities.logins).toEqual([{ userId: 'u-1', role: 'ADMIN', displayName: 'Alice Ng' }]);
  });

  /**
   * A caching failure must not fail an authentication that is otherwise valid:
   * the person proved who they are and belongs to the right group.
   */
  it('still authenticates when the login cannot be cached', async () => {
    const { result } = await succeed({}, (b) => {
      b.identities.failRecordLogin = true;
    });

    expect(result.ok).toBe(true);
  });

  describe('refusals', () => {
    const refuse = async (
      mutate: (b: ReturnType<typeof build>) => void,
      over: Record<string, unknown> = {},
      opts: { skipAccount?: boolean } = {},
    ) => {
      const built = build();
      if (opts.skipAccount !== true) built.identities.users.set(ACCOUNT.email, { ...ACCOUNT });
      mutate(built);
      const challenge = await built.provider.beginRedirect('/');
      const nonce = new URL(challenge.location).searchParams.get('nonce') as string;
      // Only supply a valid token when the test has not deliberately set an
      // invalid response — checking `id_token === undefined` clobbered the
      // access-token-only case this suite exists to cover.
      if (Object.keys(built.exchange.respond).length === 0 && built.exchange.fail === null) {
        built.exchange.respond = { id_token: idToken(claimsFor({ nonce, ...over })) };
      }
      return built.provider.completeRedirect({ state: challenge.state, code: 'auth-code' });
    };

    /**
     * Provisioning stays administrator-driven, as for LDAP. Authenticating
     * against the identity provider does not create an account: the estate
     * decides who may reach it, the directory only decides who they are.
     */
    it('refuses someone with no NexusPuppet account', async () => {
      const result = await refuse(() => undefined, {}, { skipAccount: true });

      expect(result.ok).toBe(false);
    });

    it('reports a disabled account distinctly', async () => {
      const result = await refuse((b) =>
        b.identities.users.set(ACCOUNT.email, { ...ACCOUNT, isActive: false }),
      );

      expect(result).toEqual({ ok: false, reason: 'ACCOUNT_DISABLED' });
    });

    /**
     * Refusing is the default deliberately. Granting a role to everyone the
     * identity provider knows is, for most directories, the whole company.
     */
    it('refuses someone in no mapped group', async () => {
      const result = await refuse(() => undefined, { groups: ['unrelated'] });

      expect(result.ok).toBe(false);
    });

    /**
     * Entra ID group overage (nexuspuppet#105).
     *
     * Past ~150 memberships Entra sends no groups claim at all and refers the
     * relying party to Graph. That is indistinguishable from "in no mapped
     * group" unless someone looks — and it lands on administrators first,
     * because they are who accumulate 150 groups. Reporting it as unmapped
     * sends the operator to audit mappings that are correct.
     */
    describe('a group overage', () => {
      const OVERAGE = {
        // Absent, not empty — JSON.stringify drops an undefined value, which is
        // exactly what Entra sends: no groups claim at all.
        groups: undefined,
        _claim_names: { groups: 'src1' },
        _claim_sources: {
          src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/u1/getMemberObjects' },
        },
      };

      const refuseCapturing = async (over: Record<string, unknown>) => {
        const said: string[] = [];
        const logger = {
          log: (m: string) => said.push(m),
          warn: (m: string) => said.push(m),
        };
        const built = build({}, { logger });
        built.identities.users.set(ACCOUNT.email, { ...ACCOUNT });
        const challenge = await built.provider.beginRedirect('/');
        const nonce = new URL(challenge.location).searchParams.get('nonce') as string;
        built.exchange.respond = { id_token: idToken(claimsFor({ nonce, ...over })) };
        const result = await built.provider.completeRedirect({
          state: challenge.state,
          code: 'auth-code',
        });
        return { result, said: said.join('\n') };
      };

      it('is named as an overage, not as an unmapped user', async () => {
        const { result, said } = await refuseCapturing(OVERAGE);

        expect(result.ok).toBe(false);
        expect(said).toContain('GROUP OVERAGE');
        expect(said).toContain('graph.microsoft.com');
        // The sentence that would otherwise send them to the wrong place.
        expect(said).not.toContain('in no mapped group');
      });

      it('says the mappings are not the problem, and what to do instead', async () => {
        const { said } = await refuseCapturing(OVERAGE);

        expect(said).toContain('role mappings are not the problem');
        expect(said).toMatch(/assigned to the application|OIDC_DEFAULT_ROLE/);
      });

      /*
       * The ordinary unmapped user must keep its own message — the overage
       * branch is not allowed to swallow the common case.
       */
      it('leaves a genuinely unmapped user reading as unmapped', async () => {
        const { said } = await refuseCapturing({ groups: ['unrelated'] });

        expect(said).toContain('in no mapped group');
        expect(said).not.toContain('GROUP OVERAGE');
      });

      /*
       * An overage reference alongside real groups is not an overage: the
       * provider sent what it had, and a refusal there IS about mappings.
       */
      it('is not claimed when groups arrived anyway', async () => {
        const { said } = await refuseCapturing({ ...OVERAGE, groups: ['unrelated'] });

        expect(said).toContain('in no mapped group');
        expect(said).not.toContain('GROUP OVERAGE');
      });
    });

    it('admits an unmapped user when a default role is configured', async () => {
      const built = build({ defaultRole: 'VIEWER' });
      built.identities.users.set(ACCOUNT.email, { ...ACCOUNT });
      const challenge = await built.provider.beginRedirect('/');
      const nonce = new URL(challenge.location).searchParams.get('nonce') as string;
      built.exchange.respond = { id_token: idToken(claimsFor({ nonce, groups: ['unrelated'] })) };

      const result = await built.provider.completeRedirect({ state: challenge.state, code: 'c' });

      expect(result.ok && result.principal.role).toBe('VIEWER');
    });

    it('refuses a token with no email claim', async () => {
      const result = await refuse(() => undefined, { email: undefined });

      expect(result.ok).toBe(false);
    });

    /**
     * OAuth-as-authentication, the classic mistake. An access token says a
     * client may call an API; it asserts nothing about who the user is.
     */
    it('refuses a token response carrying no id_token', async () => {
      const result = await refuse((b) => {
        b.exchange.respond = { access_token: 'at' };
      });

      expect(result.ok).toBe(false);
    });

    it('refuses a callback whose state it never issued', async () => {
      const { provider } = build();

      const result = await provider.completeRedirect({ state: 'never-issued', code: 'c' });

      expect(result.ok).toBe(false);
    });

    /** A state is consumed on use, so a captured callback cannot be replayed. */
    it('refuses a state that has already been used', async () => {
      const { provider, challenge } = await succeed();

      const replay = await provider.completeRedirect({ state: challenge.state, code: 'auth-code' });

      expect(replay.ok).toBe(false);
    });

    it('refuses when the identity provider reports an error', async () => {
      const { provider } = build();
      const challenge = await provider.beginRedirect('/');

      const result = await provider.completeRedirect({
        state: challenge.state,
        error: 'access_denied',
        error_description: 'user cancelled',
      });

      expect(result.ok).toBe(false);
    });

    it('refuses when the token exchange fails', async () => {
      const result = await refuse((b) => {
        b.exchange.fail = 'connect ECONNREFUSED';
      });

      expect(result.ok).toBe(false);
    });

    /** Nonce binding: a token from a different login must not be accepted. */
    it('refuses a token whose nonce came from another login', async () => {
      const result = await refuse(() => undefined, { nonce: 'a-different-login' });

      expect(result.ok).toBe(false);
    });
  });

  /** Password login must be impossible against a redirect provider. */
  it('rejects credentials authentication outright', async () => {
    const { provider } = build();

    expect(
      await provider.authenticate({ email: 'alice@example.com', password: 'anything' }),
    ).toEqual({
      ok: false,
      reason: 'INVALID_CREDENTIALS',
    });
  });
});

describe('OidcDirectory', () => {
  it('refuses a discovery document that declares a different issuer', async () => {
    const http = new FakeHttp();
    http.document = { ...DISCOVERY, issuer: 'https://evil.test' };

    await expect(new OidcDirectory(ISSUER, http, 1_000, now).document()).rejects.toThrow(
      /mismatch/,
    );
  });

  it('caches discovery rather than fetching per login', async () => {
    const http = new FakeHttp();
    const directory = new OidcDirectory(ISSUER, http, 1_000, now);

    await directory.document();
    await directory.document();

    expect(http.getCount).toBe(1);
  });

  /**
   * Key rotation, and the cooldown that bounds it.
   *
   * A miss refetches, which is how a rotated key is picked up without a
   * restart. Refetching on EVERY miss would let a token bearing a kid that will
   * never exist hammer the identity provider, so there is a cooldown — and the
   * honest consequence is that a rotation is picked up within that window
   * rather than instantly. Logins signed by the new key fail until it elapses.
   */
  it('refetches the key set after a rotation, once the cooldown elapses', async () => {
    let clock = NOW;
    const http = new FakeHttp();
    const directory = new OidcDirectory(ISSUER, http, 1_000, () => clock);
    await directory.signingKey('key-1');
    const afterFirst = http.getCount;

    http.keys = [{ ...jwk, kid: 'key-2' }];
    clock += 61_000;

    await expect(directory.signingKey('key-2')).resolves.toMatchObject({ kid: 'key-2' });
    expect(http.getCount).toBeGreaterThan(afterFirst);
  });

  /** The bound: repeated misses inside the window do not reach the provider. */
  it('does not refetch again for a kid that will never exist', async () => {
    const http = new FakeHttp();
    const directory = new OidcDirectory(ISSUER, http, 1_000, now);
    await directory.signingKey('key-1');
    const afterFirst = http.getCount;

    for (let i = 0; i < 5; i += 1) {
      await expect(directory.signingKey('bogus')).rejects.toThrow(/no OIDC signing key/);
    }

    expect(http.getCount).toBe(afterFirst);
  });

  /**
   * Without a kid the key is only unambiguous when there is one. Trying keys
   * until one verifies is indistinguishable from not checking which key signed.
   */
  it('refuses to guess when several keys exist and the token names none', async () => {
    const http = new FakeHttp();
    http.keys = [jwk, { ...jwk, kid: 'key-2' }];
    const directory = new OidcDirectory(ISSUER, http, 1_000, now);

    await expect(directory.signingKey(undefined)).rejects.toThrow(/no OIDC signing key/);
  });
});

describe('configuration', () => {
  it('returns null when OIDC is not configured', () => {
    expect(oidcConfigFromEnv({})).toBeNull();
  });

  it('rejects a partial configuration rather than starting without SSO', () => {
    expect(() => oidcConfigFromEnv({ OIDC_ISSUER: ISSUER })).toThrow(/Invalid OIDC configuration/);
  });

  it('parses role mappings in the same syntax as LDAP', () => {
    const parsed = oidcConfigFromEnv({
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_REDIRECT_URI: 'https://np.example.com/api/auth/callback',
      OIDC_ROLE_MAPPINGS: 'puppet-admins=ADMIN;ops=OPERATOR',
    });

    expect(parsed?.roleMappings).toEqual([
      { group: 'puppet-admins', role: 'ADMIN' },
      { group: 'ops', role: 'OPERATOR' },
    ]);
  });

  /**
   * Was "rejects a mapping to a role that does not exist", asserting the
   * three-value enum. Once roles are rows a name this build has never heard of
   * may be one the deployment defined, so it is accepted here and resolves
   * against the roles table later (ADR-0018 §5).
   */
  it('accepts a mapping to a custom role, preserving the case it was written in', () => {
    const parsed = oidcConfigFromEnv({
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_REDIRECT_URI: 'https://np.example.com/api/auth/callback',
      OIDC_ROLE_MAPPINGS: 'auditors=auditor;ops=operator',
    });

    // `auditor` stays as written — upper-casing it would match no role row and
    // the mapping would silently grant nothing. `operator` IS a built-in, so it
    // folds, because it always has.
    expect(parsed?.roleMappings).toEqual([
      { group: 'auditors', role: 'auditor' },
      { group: 'ops', role: 'OPERATOR' },
    ]);
  });

  it('still refuses a role name that could never match a role', () => {
    expect(() =>
      oidcConfigFromEnv({
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_REDIRECT_URI: 'https://np.example.com/api/auth/callback',
        OIDC_ROLE_MAPPINGS: 'ops=not a role',
      }),
    ).toThrow(/not a usable role name/);
  });

  it('refuses a mapping whose role half is missing', () => {
    expect(() =>
      oidcConfigFromEnv({
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_REDIRECT_URI: 'https://np.example.com/api/auth/callback',
        OIDC_ROLE_MAPPINGS: 'ops=',
      }),
    ).toThrow(/the role is empty/);
  });

  it('applies the first matching mapping, so the most privileged goes first', () => {
    const c = config({
      roleMappings: [
        { group: 'admins', role: 'ADMIN' },
        { group: 'ops', role: 'OPERATOR' },
      ],
    });

    // Unchanged behaviour, deliberately. LDAP resolves highest-wins; switching
    // OIDC to match would promote anyone whose deployment listed a lower role
    // first, with no diff to review (ADR-0018 §5).
    expect(resolveOidcRole(['ops', 'admins'], c)?.primary).toBe('ADMIN');
    expect(resolveOidcRole(['ops', 'admins'], c)?.all).toEqual(['ADMIN']);
  });

  it('unions the roles once any matched mapping names a custom one', () => {
    const c = config({
      roleMappings: [
        { group: 'admins', role: 'ADMIN' },
        { group: 'auditors', role: 'auditor' },
      ],
    });

    // Ordering cannot rank `auditor` against `ADMIN`, so both apply and
    // authorization unions their permissions.
    const resolved = resolveOidcRole(['admins', 'auditors'], c);
    expect(resolved?.all).toEqual(['ADMIN', 'auditor']);
    // Display and storage only — the first the operator wrote.
    expect(resolved?.primary).toBe('ADMIN');
  });

  it('does not union when every matched mapping is a built-in', () => {
    const c = config({
      roleMappings: [
        { group: 'ops', role: 'OPERATOR' },
        { group: 'viewers', role: 'VIEWER' },
      ],
    });

    // The upgrade-safety rule: an existing deployment must resolve exactly as
    // it did before custom roles existed.
    expect(resolveOidcRole(['ops', 'viewers'], c)?.all).toEqual(['OPERATOR']);
  });

  it('refuses an unmapped user unless a default role is set', () => {
    expect(resolveOidcRole(['nobody'], config())).toBeNull();
    expect(resolveOidcRole(['nobody'], config({ defaultRole: 'VIEWER' }))?.primary).toBe('VIEWER');
  });

  it('allows the default role to be a custom one', () => {
    const resolved = resolveOidcRole(['nobody'], config({ defaultRole: 'auditor' }));
    expect(resolved?.primary).toBe('auditor');
    expect(resolved?.all).toEqual(['auditor']);
  });
});

describe('describe()', () => {
  /** Rendered in a browser: it must never carry a secret. */
  it('exposes connection facts and no secret', () => {
    const { provider } = build({ clientSecret: 'super-secret-value' });

    const described = provider.describe();
    const serialised = JSON.stringify(described);

    expect(serialised).not.toContain('super-secret-value');
    expect(described.roleMappings).toEqual([{ group: 'puppet-admins', role: 'ADMIN' }]);
    expect(described.refusesUnmappedUsers).toBe(true);
  });
});
