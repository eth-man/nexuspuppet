import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_PROVIDERS,
  type AuthResult,
  type AuthSourceDescriptor,
  type AuthenticatedPrincipal,
  type Credentials,
  type IAuthProvider,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long a refused login takes, whichever provider refused it.
 *
 * Configured rather than probed (ADR-0015). Measuring the slowest provider at
 * boot would make startup depend on a directory that may be slow, unreachable,
 * or not yet running — an unpredictable boot in exactly the environments where
 * predictable boot matters.
 *
 * 1500ms sits comfortably above a scrypt verification (~100ms) and above a
 * healthy LDAP round trip, while staying low enough that a mistyped password
 * does not feel like a hang.
 */
const DEFAULT_LOGIN_FLOOR_MS = 1500;

/**
 * Dispatch a login to the one provider that owns the account (ADR-0015).
 *
 * `authSource` on the account decides, and nothing chains or falls back. The
 * alternative — try local, then the directory — means anybody who can create a
 * local account can shadow a directory identity and bypass whatever conditional
 * access, MFA or offboarding that directory enforces. Account creation would
 * become an authentication bypass.
 *
 * Core's local provider is always present. An enterprise directory provider is
 * contributed alongside it, never instead of it, so a misconfigured or expired
 * directory cannot lock an administrator out of their own console.
 */
@Injectable()
export class AuthProviderResolver {
  private readonly logger = new Logger(AuthProviderResolver.name);

  /** source -> provider. Built once; the set cannot change after boot. */
  private readonly bySource = new Map<string, IAuthProvider>();

  constructor(
    @Inject(AUTH_PROVIDERS) providers: readonly IAuthProvider[],
    private readonly prisma: PrismaService,
    private readonly floorMs: number = DEFAULT_LOGIN_FLOOR_MS,
  ) {
    for (const provider of providers) {
      const existing = this.bySource.get(provider.source);
      if (existing !== undefined) {
        // Two providers claiming one source is a build error, not a runtime
        // condition to paper over — a login would dispatch to whichever won a
        // Map insertion race, which is nobody's intent.
        throw new Error(
          `Two authentication providers both claim source "${provider.source}". ` +
            'Each source must be owned by exactly one provider.',
        );
      }
      this.bySource.set(provider.source, provider);
    }

    this.logger.log(`Authentication sources: ${[...this.bySource.keys()].sort().join(', ')}`);
  }

  /** Sources this deployment can authenticate against. */
  sources(): string[] {
    return [...this.bySource.keys()].sort();
  }

  /**
   * Every source, described well enough for a login page to render it.
   *
   * This is what `GET /auth/mode` answers with, and it comes from HERE rather
   * than from the `AUTH_PROVIDER` token (ADR-0023 §3). That token is bound to
   * core's local provider and the registry refuses to let anything replace it
   * (ADR-0015 §3) — so a deployment describing itself through it always
   * reported `local`, whatever directory it was actually running.
   *
   * Sorted, so two deployments with the same providers answer identically and
   * a login page cannot reorder its own buttons between polls.
   */
  descriptors(): AuthSourceDescriptor[] {
    return [...this.bySource.values()]
      .map((provider) => ({
        source: provider.source,
        mode: provider.mode ?? 'credentials',
        identifierLabel: provider.identifierLabel ?? 'Email',
      }))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  }

  /**
   * The provider for a source, or null when nothing owns it.
   *
   * Null rather than a throw: a refresh token issued before a provider was
   * deregistered names a source that no longer exists, and that must end the
   * session cleanly rather than crash the request (ADR-0015).
   */
  forSource(source: string): IAuthProvider | null {
    return this.bySource.get(source) ?? null;
  }

  /**
   * The one provider that logs in by redirect, if this deployment has one.
   *
   * Redirect-mode providers (OIDC) are not dispatched by `authSource` — the
   * user has not named an account yet when the flow begins, which is the whole
   * point of a redirect. So the redirect endpoints ask for it by mode.
   *
   * Hybrid changes what the login page should offer: an email form for local
   * and directory credentials AND a button for the redirect provider, rather
   * than one or the other. That UX is deliberately not in this change — see the
   * follow-up noted in the ADR.
   */
  redirectProvider(): IAuthProvider | null {
    for (const provider of this.bySource.values()) {
      if (provider.mode === 'redirect') return provider;
    }
    return null;
  }

  /**
   * The provider worth describing to an administrator.
   *
   * With two providers live, "describe the provider" is ambiguous. The useful
   * answer is the one with something to say: core's local provider has no group
   * mappings and no directory URL, so a deployment with a directory should show
   * the directory's configuration rather than an empty local description.
   *
   * Falls back to the first provider so the endpoint always answers — the UI
   * decides to render nothing, rather than handling an error.
   */
  describableProvider(): IAuthProvider | null {
    for (const provider of this.bySource.values()) {
      if (provider.describe !== undefined) return provider;
    }
    return [...this.bySource.values()][0] ?? null;
  }

  /** Providers that authenticate from a submitted email and password. */
  credentialProviders(): IAuthProvider[] {
    return [...this.bySource.values()].filter((p) => (p.mode ?? 'credentials') === 'credentials');
  }

  /**
   * Authenticate, taking the same wall-clock time whatever the outcome.
   *
   * WHY THE FLOOR IS HERE AND NOT IN EACH PROVIDER. A local refusal costs one
   * scrypt, roughly 100ms. A directory refusal costs a network round trip —
   * single-digit milliseconds on a good LAN, seconds on a bad day. Without a
   * shared floor an attacker learns which of "no account", "local account" and
   * "directory account" they are looking at purely from response timing,
   * without ever guessing a password: a live map of who is provisioned where.
   *
   * The local provider already defends its own timing — it verifies an absent
   * user against a dummy hash so a missing account and a wrong password cost
   * the same. That defence stops working the moment a second provider with a
   * different cost profile sits beside it, so the resolver owns it instead.
   */
  async authenticate(credentials: Credentials): Promise<AuthResult> {
    const startedAt = Date.now();

    try {
      return await this.dispatch(credentials);
    } finally {
      await this.padTo(startedAt);
    }
  }

  private async dispatch(credentials: Credentials): Promise<AuthResult> {
    const email = credentials.email.trim().toLowerCase();

    // Resolve the account BEFORE choosing a provider. The account's authSource
    // is the only thing that decides, so an unknown address cannot be steered
    // at a provider of the caller's choosing.
    const account = await this.prisma.user.findUnique({
      where: { email },
      select: { authSource: true },
    });

    if (account === null) {
      // Deliberately identical to every other refusal. The padding above makes
      // the early return here indistinguishable from a full provider round
      // trip; without it this branch would be the enumeration oracle.
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const provider = this.forSource(account.authSource);

    if (provider === null) {
      // The account names a provider this deployment no longer has — an
      // enterprise layer removed, a licence expired, a directory disabled.
      // Refuse, and say so in the log rather than to the caller.
      this.logger.warn(
        `Login refused for an account whose authSource "${account.authSource}" has no provider. ` +
          `Configured sources: ${this.sources().join(', ') || 'none'}.`,
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    return provider.authenticate(credentials);
  }

  /**
   * Re-resolve a principal, e.g. on refresh.
   *
   * Fails closed when the source is gone: the session ends rather than the
   * request throwing (ADR-0015 §3). The access token already issued is left to
   * expire on its own — killing sessions mid-request the instant a licence
   * lapses is the abrupt behaviour ADR-0014 §2 exists to avoid.
   */
  async resolve(userId: string): Promise<AuthenticatedPrincipal | null> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { authSource: true },
    });

    if (account === null) return null;

    const provider = this.forSource(account.authSource);
    if (provider === null) {
      this.logger.warn(
        `Refresh refused: authSource "${account.authSource}" has no provider in this deployment.`,
      );
      return null;
    }

    return provider.resolve(userId);
  }

  private async padTo(startedAt: number): Promise<void> {
    const remaining = this.floorMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      // Over budget. Worth knowing about — a directory this slow is an
      // operations problem — but never a reason to refuse a valid login.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
