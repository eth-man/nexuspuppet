import type { JsonWebKey } from './id-token';

/**
 * Discovery and key material for an OIDC issuer.
 *
 * Both are cached: discovery rarely changes, and JWKS is fetched on every login
 * otherwise, which turns the identity provider into a hard dependency of every
 * request rather than of every key rotation.
 *
 * Bounded and refetched on an unknown `kid`, which is what makes rotation work
 * without a restart — a provider that rotates signing keys publishes the new
 * one before using it, so the first token signed by it triggers exactly one
 * refetch.
 */

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface OidcHttp {
  getJson(url: string, timeoutMs: number): Promise<unknown>;
  postForm(
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<unknown>;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Short, because a refetch is what recovers from a rotation gone wrong. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;

export class OidcDirectory {
  private discovery: { document: DiscoveryDocument; fetchedAt: number } | null = null;
  private jwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
  /**
   * When a MISS last caused a refetch — not when the key set was last fetched.
   *
   * The distinction matters. Rate-limiting on the fetch time would suppress the
   * refetch that handles a rotation happening shortly after a fetch, so logins
   * would fail for the whole window for no reason. Rate-limiting on the last
   * miss-driven refetch handles a rotation immediately and still bounds a flood
   * of tokens bearing kids that will never exist.
   */
  private lastMissRefetchAt = 0;

  constructor(
    private readonly issuer: string,
    private readonly http: OidcHttp,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async document(): Promise<DiscoveryDocument> {
    if (this.discovery !== null && this.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discovery.document;
    }

    // Per OIDC Discovery: the well-known path is appended to the issuer, which
    // may itself contain a path. A naive new URL() would discard that path.
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const raw = await this.http.getJson(url, this.timeoutMs);

    const document = raw as DiscoveryDocument;
    for (const field of [
      'issuer',
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
    ] as const) {
      if (typeof document?.[field] !== 'string' || document[field].length === 0) {
        throw new Error(`OIDC discovery document from ${url} has no ${field}`);
      }
    }

    // The document must claim the issuer we asked about. Without this check a
    // redirected or substituted document could point token and key endpoints at
    // an attacker while every later issuer comparison still passes.
    if (document.issuer !== this.issuer) {
      throw new Error(
        `OIDC discovery mismatch: configured issuer ${this.issuer}, document declares ${document.issuer}`,
      );
    }

    this.discovery = { document, fetchedAt: this.now() };
    return document;
  }

  /**
   * The signing key for a token, by `kid`.
   *
   * A miss refetches once — that is key rotation — but no more often than
   * JWKS_MIN_REFETCH_MS, so a token bearing a `kid` that will never exist
   * cannot be used to hammer the identity provider.
   */
  async signingKey(kid: string | undefined): Promise<JsonWebKey> {
    const found = this.findKey(kid);
    if (found !== null) return found;

    if (this.lastMissRefetchAt !== 0 && this.now() - this.lastMissRefetchAt < JWKS_MIN_REFETCH_MS) {
      throw new Error(`no OIDC signing key matches kid ${String(kid)}`);
    }
    this.lastMissRefetchAt = this.now();
    await this.fetchJwks();

    const refreshed = this.findKey(kid);
    if (refreshed === null) throw new Error(`no OIDC signing key matches kid ${String(kid)}`);
    return refreshed;
  }

  /**
   * Fetch and parse the key set, answering how many signing keys it holds.
   *
   * For the settings screen's check, which needs to know that the keys can be
   * READ — a JWKS that does not parse means no token will ever verify, and that
   * otherwise surfaces as an opaque "sign-in refused" at the login page.
   *
   * Deliberately NOT rate-limited by `lastMissRefetchAt`: that budget exists to
   * stop a flood of tokens bearing unknown kids from hammering the provider,
   * and an administrator pressing a button is not that.
   */
  async signingKeyCount(): Promise<number> {
    return (await this.fetchJwks()).length;
  }

  private async fetchJwks(): Promise<JsonWebKey[]> {
    const { jwks_uri } = await this.document();
    const raw = (await this.http.getJson(jwks_uri, this.timeoutMs)) as { keys?: JsonWebKey[] };
    if (!Array.isArray(raw?.keys)) throw new Error(`OIDC JWKS at ${jwks_uri} has no keys`);

    // Signature keys only. A JWKS may also carry encryption keys, and verifying
    // with one would be a category error even where it happened to work.
    const keys = raw.keys.filter((k) => k.use === undefined || k.use === 'sig');
    this.jwks = { keys, fetchedAt: this.now() };
    return keys;
  }

  private findKey(kid: string | undefined): JsonWebKey | null {
    const keys = this.jwks?.keys ?? [];
    if (keys.length === 0) return null;
    if (kid !== undefined) return keys.find((k) => k.kid === kid) ?? null;
    // No kid: only unambiguous when the issuer publishes exactly one key.
    // Guessing among several would mean trying keys until one verifies, which
    // is indistinguishable from not checking which key signed the token.
    return keys.length === 1 ? (keys[0] as JsonWebKey) : null;
  }
}
