import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AuthProviderDescription,
  AuthResult,
  AuthenticatedPrincipal,
  Credentials,
  IAuthProvider,
  IAuthProviderSettings,
  IUserDirectory,
  ProviderVerification,
  RedirectChallenge,
} from '@nexuspuppet/contracts';
import type { OidcConfig } from './config';
import { oidcConfigSchema, resolveOidcRole } from './config';
import type { OidcDirectory } from './discovery';
import {
  groupOverageEndpoint,
  groupsFromClaim,
  peekHeader,
  verifyIdToken,
  type IdTokenClaims,
} from './id-token';

/** Anything with a log method; core passes a Nest Logger. */
interface LoggerLike {
  log(message: string): void;
  warn(message: string): void;
}

interface PendingLogin {
  /** PKCE verifier. Never leaves this process until the token exchange. */
  verifier: string;
  /** Replay defence, checked against the ID token's claim. */
  nonce: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
/** Bounds memory if something floods /auth/redirect. */
const PENDING_MAX = 1_000;

export interface OidcAuthProviderOptions {
  config: OidcConfig;
  directory: OidcDirectory;
  identities: IUserDirectory;
  logger: LoggerLike;
  exchange: TokenExchange;
  now?: () => number;
  /**
   * Core's reader for what an operator saved (ADR-0016 §4, #113).
   *
   * Absent means today's behaviour: the boot configuration governs and nothing
   * is read per login.
   */
  settings?: IAuthProviderSettings;
  /**
   * Build a discovery client and a token exchange for a configuration other
   * than the one this was constructed with.
   *
   * Needed because an OIDC configuration change moves MORE than a hostname: the
   * discovery cache, the JWKS, and the token endpoint credentials all belong to
   * the issuer, so a stored configuration naming a different one must not reuse
   * any of them. Injected so tests need no network.
   */
  directoryFor?: (config: OidcConfig) => OidcDirectory;
  exchangeFor?: (config: OidcConfig) => TokenExchange;
}

/** The configuration in force for one login leg, and the clients built for it. */
interface EffectiveOidc {
  config: OidcConfig;
  directory: OidcDirectory;
  exchange: TokenExchange;
}

/** Swaps an authorization code for tokens. Injected so tests need no network. */
export interface TokenExchange {
  redeem(params: {
    tokenEndpoint: string;
    code: string;
    verifier: string;
  }): Promise<{ id_token?: string; access_token?: string }>;
}

/**
 * OpenID Connect authentication, authorization-code flow with PKCE.
 *
 * REDIRECT MODE, which is why core's /auth/redirect and /auth/callback exist.
 * A credentials interface cannot express this flow: the password is never seen
 * here, and authentication happens in a browser at another origin.
 *
 * The division of responsibility with core is deliberate. Core correlates the
 * two legs — it holds the state cookie and refuses a callback from a browser
 * that did not begin the login. This provider validates what the identity
 * provider asserts. Neither can do the other's job: core does not know what an
 * ID token is, and this has no access to cookies.
 */
export class OidcAuthProvider implements IAuthProvider {
  readonly source = 'oidc';
  readonly mode = 'redirect' as const;

  private readonly pending = new Map<string, PendingLogin>();

  /** Last stored configuration and the clients built for it, keyed by value. */
  private effectiveCache: { key: string; effective: EffectiveOidc } | null = null;

  constructor(private readonly options: OidcAuthProviderOptions) {}

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Rejected, always. A redirect provider has no password to check, and
   * accepting anything here would be an authentication bypass.
   */
  async authenticate(_credentials: Credentials): Promise<AuthResult> {
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  async beginRedirect(_returnTo: string): Promise<RedirectChallenge> {
    // Resolved here AND at the callback. A configuration saved between the two
    // legs means the challenge was minted against one issuer and the assertion
    // is validated against another, so that login fails and the next succeeds —
    // which is the correct outcome for "the operator repointed the directory".
    const { config, directory } = await this.effective();
    const document = await directory.document();

    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    // 96 bytes -> 128 base64url chars, the RFC 7636 maximum. The verifier is the
    // secret that proves this exchange belongs to the browser that started it.
    const verifier = randomBytes(96).toString('base64url');

    this.remember(state, { verifier, nonce, expiresAt: this.now + PENDING_TTL_MS });

    const url = new URL(document.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', ['openid', ...config.scopes].join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    // S256, never `plain`. A plain challenge is the verifier, so anyone who can
    // read the authorization request can complete the exchange.
    url.searchParams.set(
      'code_challenge',
      createHash('sha256').update(verifier).digest('base64url'),
    );
    url.searchParams.set('code_challenge_method', 'S256');

    return { location: url.toString(), state };
  }

  async completeRedirect(params: Record<string, string>): Promise<AuthResult> {
    const { identities, logger } = this.options;
    const { config, directory, exchange } = await this.effective();

    // The identity provider refused. Its reason is logged, not surfaced: it can
    // distinguish "no such user" from "access denied", and relaying that would
    // make this endpoint an account-enumeration oracle.
    if (typeof params['error'] === 'string') {
      logger.log(
        `OIDC login refused by the identity provider: ${params['error']}` +
          (params['error_description'] === undefined ? '' : ` (${params['error_description']})`),
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const state = params['state'];
    const code = params['code'];
    if (typeof state !== 'string' || typeof code !== 'string') {
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    // Consumed, so a code cannot be presented twice.
    const login = this.take(state);
    if (login === null) {
      logger.log('OIDC callback presented an unknown or expired state.');
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    try {
      const document = await directory.document();
      const tokens = await exchange.redeem({
        tokenEndpoint: document.token_endpoint,
        code,
        verifier: login.verifier,
      });

      const idToken = tokens.id_token;
      if (typeof idToken !== 'string' || idToken.length === 0) {
        // An OAuth response without an ID token is not an OIDC response, and
        // treating an access token as proof of identity is the classic
        // OAuth-as-authentication mistake.
        logger.warn('OIDC token response contained no id_token; refusing the login.');
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      const key = await directory.signingKey(peekHeader(idToken).kid);
      const claims = verifyIdToken(idToken, key, {
        issuer: config.issuer,
        audience: config.clientId,
        nonce: login.nonce,
        clockSkewSeconds: config.clockSkewSeconds,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });

      return await this.principalFor(claims, config, identities, logger);
    } catch (error) {
      // Every validation failure lands here and answers the same way. The detail
      // goes to the log, where an operator can see it and an attacker cannot.
      logger.warn(`OIDC login failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }
  }

  private async principalFor(
    claims: IdTokenClaims,
    config: OidcConfig,
    identities: IUserDirectory,
    logger: LoggerLike,
  ): Promise<AuthResult> {
    const email = claims[config.emailClaim];
    if (typeof email !== 'string' || email.length === 0) {
      logger.warn(
        `OIDC login refused: the ID token has no "${config.emailClaim}" claim. ` +
          'Check the scopes requested and the claim mapping at the identity provider.',
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const groups = groupsFromClaim(claims[config.groupsClaim]);
    const resolved = resolveOidcRole(groups, config);
    if (resolved === null) {
      /*
       * "No mapped group" and "the provider sent no groups" are different
       * failures with the same shape, and only one of them is about mappings
       * (nexuspuppet#105).
       *
       * Entra drops the groups claim past ~150 memberships and refers us to
       * Graph instead. Reporting that as an unmapped user sends the operator to
       * audit mappings that are correct, for the one account — a senior
       * administrator, who is why they are in 150 groups — that cannot sign in.
       */
      const overage = groups.length === 0 ? groupOverageEndpoint(claims, config.groupsClaim) : null;

      if (overage !== null) {
        logger.warn(
          `OIDC login refused for ${email}: the identity provider signalled a GROUP OVERAGE — ` +
            `it sent no "${config.groupsClaim}" claim and referred us to ${overage} instead. ` +
            'Your role mappings are not the problem. Entra ID does this past roughly 150 group ' +
            'memberships, so it hits administrators first. Configure the app registration to ' +
            'emit only groups assigned to the application, or set OIDC_DEFAULT_ROLE.',
        );
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      logger.log(
        `OIDC login refused for ${email}: authenticated, but in no mapped group. ` +
          'Set OIDC_ROLE_MAPPINGS, or OIDC_DEFAULT_ROLE to admit everyone.',
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    // Provisioning stays administrator-driven, as it is for LDAP: authenticating
    // against the identity provider does not create an account here. An estate
    // decides who may reach it; the directory only decides who they are.
    const identity = await identities.findByEmail(email);
    if (identity === null) {
      logger.log(
        `OIDC login refused for ${email}: no NexusPuppet account exists. ` +
          'Create one with authSource "oidc".',
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    if (!identity.isActive) return { ok: false, reason: 'ACCOUNT_DISABLED' };

    const claimedName = claims[config.displayNameClaim];
    const displayName = typeof claimedName === 'string' ? claimedName : identity.displayName;

    // Cached so a refreshed token agrees with the login. A failure here must not
    // fail an otherwise valid authentication.
    try {
      // The PRIMARY only. The store holds one role per user, so a person whose
      // mappings union several is recorded under the one shown in the console;
      // `roles` on the principal is what authorization reads.
      await identities.recordLogin(identity.userId, { role: resolved.primary, displayName });
    } catch (error) {
      logger.warn(
        `Could not persist OIDC login state for ${email}: ` +
          `${error instanceof Error ? error.message : String(error)}. Session continues.`,
      );
    }

    return {
      ok: true,
      principal: {
        userId: identity.userId,
        email: identity.email,
        displayName,
        role: resolved.primary,
        // Only when more than one applies, so the common case carries nothing
        // extra and reads exactly as it did before.
        ...(resolved.all.length > 1 ? { roles: resolved.all } : {}),
        authSource: this.source,
      },
    };
  }

  async resolve(userId: string): Promise<AuthenticatedPrincipal | null> {
    const identity = await this.options.identities.findById(userId);
    if (identity === null || !identity.isActive) return null;
    return {
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      role: identity.role,
      authSource: this.source,
    };
  }

  /**
   * What an administrator may see. No client secret, no token, no endpoint
   * credentials — this is rendered in a browser.
   */
  describe(): AuthProviderDescription {
    return {
      source: this.source,
      roleMappings: this.options.config.roleMappings,
      refusesUnmappedUsers: this.options.config.defaultRole === undefined,
      // Connection facts an administrator needs to recognise a
      // misconfiguration — never a secret. No client secret, no token.
      details: [
        { label: 'Issuer', value: this.options.config.issuer },
        { label: 'Client ID', value: this.options.config.clientId },
        { label: 'Groups claim', value: this.options.config.groupsClaim },
      ],
    };
  }

  /**
   * What this provider was built from, for the settings screen (ADR-0016 §2).
   *
   * Core cannot read `OIDC_*` — those variables belong to this package's parser
   * and ADR-0002 keeps core out of it — so the only way an administrator sees
   * the configuration in force is for the provider to report it.
   *
   * NO SECRETS. `clientSecret` is deliberately absent: this is rendered in a
   * browser. Core strips known secret fields as a backstop, and that backstop
   * is not permission to return one here.
   */
  currentConfiguration(): Record<string, unknown> {
    const { config } = this.options;
    return {
      issuer: config.issuer,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      emailClaim: config.emailClaim,
      displayNameClaim: config.displayNameClaim,
      groupsClaim: config.groupsClaim,
      roleMappings: config.roleMappings,
      ...(config.defaultRole === undefined ? {} : { defaultRole: config.defaultRole }),
      timeoutMs: config.timeoutMs,
      clockSkewSeconds: config.clockSkewSeconds,
    };
  }

  /**
   * Check the configuration in force against the identity provider.
   *
   * WHAT THIS CAN AND CANNOT ESTABLISH, because the difference matters to
   * somebody reading a green tick: a login happens in a browser at another
   * origin, so nothing here can prove that a person will be able to sign in.
   * What it proves is that the issuer answers, that its discovery document
   * describes the issuer we asked about rather than a substituted one, and that
   * its signing keys parse. Those are the failures that present as a redirect
   * loop or an opaque refusal, and they are worth catching from a screen rather
   * than from the login page.
   *
   * The candidate parameter is accepted for interface compatibility and
   * ignored: nothing can store an OIDC configuration yet, so testing one that
   * cannot be saved would answer a question nobody asked.
   */
  async verifyConfiguration(_candidate?: unknown): Promise<ProviderVerification> {
    const { config, directory } = this.options;

    try {
      const document = await directory.document();
      // Forces a JWKS fetch and parse. A key set that cannot be read means no
      // token will ever verify, which otherwise surfaces as "sign-in refused".
      const keys = await directory.signingKeyCount();

      return {
        ok: true,
        message: 'The identity provider answered and its configuration is consistent.',
        details: [
          { label: 'Issuer', value: document.issuer },
          { label: 'Authorization endpoint', value: document.authorization_endpoint },
          { label: 'Signing keys', value: String(keys) },
          {
            label: 'Ends sessions',
            value:
              document.end_session_endpoint === undefined
                ? 'not advertised'
                : document.end_session_endpoint,
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        message: `The identity provider at ${config.issuer} could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * The configuration this login leg should use, and clients for it.
   *
   * Mirrors the LDAP provider (#113), with one difference worth stating: a
   * changed OIDC configuration invalidates MORE than a connection. The
   * discovery document, the JWKS cache and the token-endpoint credentials all
   * belong to the issuer, so a stored configuration gets its own directory and
   * exchange rather than reusing the boot ones.
   *
   * Rebuilt only when the configuration actually changes: discovery is cached
   * per client, and rebuilding per login would refetch the document and key set
   * on every sign-in — turning the identity provider into a hard dependency of
   * every login, which is exactly what that cache exists to prevent.
   */
  private async effective(): Promise<EffectiveOidc> {
    const { config, directory, exchange, settings } = this.options;
    const boot: EffectiveOidc = { config, directory, exchange };

    if (settings === undefined) return boot;

    const stored = await settings.resolve(this.source);
    if (stored === null || stored === undefined) return boot;

    /*
     * A saved configuration carries no clientSecret when the operator did not
     * retype one — it is write-only, so the settings view never had it to send
     * back. Inheriting the boot secret is what makes "change the groups claim"
     * possible without also re-entering the credential.
     */
    const merged =
      typeof stored === 'object' &&
      (stored as { clientSecret?: unknown }).clientSecret === undefined &&
      config.clientSecret !== undefined
        ? { ...(stored as object), clientSecret: config.clientSecret }
        : stored;

    const parsed = oidcConfigSchema.safeParse(merged);
    if (!parsed.success) {
      // Refuse rather than fall back, as LDAP does: the boot configuration may
      // be precisely what the operator replaced, and completing a login against
      // it would accept an assertion from an issuer nobody chose.
      throw new Error(
        'The stored OIDC configuration does not match this build’s schema ' +
          `(${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}). ` +
          'Directory logins are refused until it is corrected or discarded; local accounts ' +
          'are unaffected.',
      );
    }

    const key = JSON.stringify(parsed.data);
    if (this.effectiveCache?.key !== key) {
      this.options.logger.log('OIDC configuration changed; rebuilding the issuer clients.');
      const next = parsed.data;
      this.effectiveCache = {
        key,
        effective: {
          config: next,
          directory: this.options.directoryFor?.(next) ?? directory,
          exchange: this.options.exchangeFor?.(next) ?? exchange,
        },
      };
    }
    return this.effectiveCache.effective;
  }

  private remember(state: string, login: PendingLogin): void {
    this.sweep();
    if (this.pending.size >= PENDING_MAX) {
      // Oldest first. Dropping a login in flight costs someone a retry; letting
      // this grow without bound costs the process.
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(state, login);
  }

  /**
   * Look up and consume, comparing in constant time.
   *
   * A plain Map.get leaks whether a state exists through timing. The window is
   * small and the payoff is large — a valid state is a login someone else began.
   */
  private take(state: string): PendingLogin | null {
    this.sweep();
    const candidate = Buffer.from(state);
    for (const [known, login] of this.pending) {
      const a = Buffer.from(known);
      if (a.length !== candidate.length) continue;
      if (!timingSafeEqual(a, candidate)) continue;
      this.pending.delete(known);
      return login.expiresAt > this.now ? login : null;
    }
    return null;
  }

  private sweep(): void {
    const now = this.now;
    for (const [state, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(state);
    }
  }
}
