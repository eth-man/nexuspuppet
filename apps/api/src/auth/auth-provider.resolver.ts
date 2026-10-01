import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_PROVIDERS,
  type AuthResult,
  type AuthSourceDescriptor,
  type AuthenticatedPrincipal,
  type Credentials,
  type IAuthProvider,
  type ProvisionableAuthSource,
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
 * How often the "no account exists" warning may repeat.
 *
 * A minute is short enough that an operator configuring a directory sees it
 * immediately, and long enough that a stranger cannot drive the log.
 */
const NO_ACCOUNT_WARN_INTERVAL_MS = 60_000;

/**
 * Dispatch a login to the one provider that owns the account (ADR-0015).
 *
 * `authSource` on the account decides, and nothing chains or falls back. The
 * alternative — try local, then the directory — means anybody who can create a
 * local account can shadow a directory identity and bypass whatever conditional
 * access, MFA or offboarding that directory enforces. Account creation would
 * become an authentication bypass.
 *
 * The local provider is always present. A directory provider is contributed
 * alongside it, never instead of it, so a misconfigured or disabled directory
 * cannot lock an administrator out of their own console.
 *
 * REGISTERED IS NOT CONFIGURED (ADR-0029). Both directory providers are
 * registered on every deployment so a directory can be enabled from the
 * console without a restart. One with nothing to point at is DORMANT: it is
 * not offered on the login page, it is not the redirect provider, and its
 * accounts are refused with the same answer as a wrong password — inside the
 * timing floor, so dormancy is no more of an oracle than anything else.
 * Whether a provider is configured is asked per request, because saving or
 * discarding settings changes the answer while the process runs.
 */
@Injectable()
export class AuthProviderResolver {
  private readonly logger = new Logger(AuthProviderResolver.name);

  /** Throttle state for the no-account warning; see warnNoAccount. */
  private warnMutedUntil = 0;
  private warnSuppressed = 0;

  /** source -> provider. Built once; the set cannot change after boot. */
  private readonly bySource = new Map<string, IAuthProvider>();

  /**
   * Dormant sources already warned about, so the warning is said once per
   * state change rather than once per login attempt. Cleared for a source the
   * moment it is seen configured, so a directory that is enabled and later
   * discarded is reported again.
   */
  private readonly dormantWarned = new Set<string>();

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

  /**
   * Every REGISTERED source, configured or dormant.
   *
   * What an account may be created for (ADR-0029 §2). An administrator can
   * provision directory accounts before enabling the directory, so a dormant
   * source is a valid `authSource` — its accounts simply cannot sign in until
   * it is configured. A source nothing registers is still refused.
   */
  sources(): string[] {
    return [...this.bySource.keys()].sort();
  }

  /**
   * Whether a provider has anything to authenticate against right now.
   *
   * Absent means configured, so local and every test double need nothing. A
   * provider whose check throws despite the contract is treated as configured:
   * it then answers `authenticate` itself and fails loudly there, which is
   * better than quietly vanishing from the login page.
   */
  async isConfigured(provider: IAuthProvider): Promise<boolean> {
    if (provider.isConfigured === undefined) return true;

    let configured: boolean;
    try {
      configured = await provider.isConfigured();
    } catch (error) {
      this.logger.warn(
        `The "${provider.source}" provider could not say whether it is configured: ` +
          `${error instanceof Error ? error.message : String(error)}. Treating it as configured.`,
      );
      configured = true;
    }

    if (configured) this.dormantWarned.delete(provider.source);
    return configured;
  }

  /** The providers that are configured, in registration order. */
  private async configuredProviders(): Promise<IAuthProvider[]> {
    const providers = [...this.bySource.values()];
    const flags = await Promise.all(providers.map((provider) => this.isConfigured(provider)));
    return providers.filter((_, index) => flags[index] === true);
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
  /*
   * ONLY CONFIGURED SOURCES (ADR-0029). A dormant directory is registered but
   * has nothing to point at; a button or a label for it on the login page is
   * a dead end, and on a deployment that never configured a directory it
   * would be a feature nobody switched on announcing itself to strangers.
   */
  async descriptors(): Promise<AuthSourceDescriptor[]> {
    return (await this.configuredProviders()).map(describeSource).sort(bySourceName);
  }

  /**
   * Every registered source, with whether it is configured — for the
   * create-user dialog, which may provision an account for a dormant
   * directory and should say so rather than hide it (ADR-0029 §2).
   */
  async provisionableSources(): Promise<ProvisionableAuthSource[]> {
    const providers = [...this.bySource.values()];
    const flags = await Promise.all(providers.map((provider) => this.isConfigured(provider)));
    return providers
      .map((provider, index) => ({
        ...describeSource(provider),
        configured: flags[index] === true,
      }))
      .sort(bySourceName);
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
   *
   * A DORMANT redirect provider is not returned (ADR-0029): beginning a login
   * against an identity provider nobody configured can only end in an error
   * page, so the redirect endpoints answer as they would on a deployment
   * without one.
   */
  async redirectProvider(): Promise<IAuthProvider | null> {
    for (const provider of this.bySource.values()) {
      if (provider.mode === 'redirect' && (await this.isConfigured(provider))) return provider;
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
   *
   * Only a CONFIGURED provider is worth describing: a dormant one would report
   * an empty mapping table that reads as "everybody is refused".
   */
  async describableProvider(): Promise<IAuthProvider | null> {
    for (const provider of await this.configuredProviders()) {
      if (provider.describe !== undefined) return provider;
    }
    return [...this.bySource.values()][0] ?? null;
  }

  /** Configured providers that authenticate from a submitted email and password. */
  async credentialProviders(): Promise<IAuthProvider[]> {
    return (await this.configuredProviders()).filter(
      (p) => (p.mode ?? 'credentials') === 'credentials',
    );
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
      /*
       * The ANSWER stays identical to every other refusal — the padding above
       * makes this early return indistinguishable from a full provider round
       * trip, and without that this branch is the enumeration oracle.
       *
       * The LOG is a different question, and it was wrong to have none.
       *
       * There is no auto-provisioning (ADR-0015 §5), so a directory user with
       * no account row is refused HERE: the directory provider is never asked,
       * and nothing was written anywhere. Somebody who has just configured LDAP
       * sees a correct-looking bind, a correct-looking search base, and a login
       * that fails exactly as a wrong password does. That cost hours during the
       * 2026-08-09 AD switch-over and would have cost minutes with this line.
       *
       * Only when a DIRECTORY is configured — not merely registered, which
       * every deployment's are (ADR-0029). Without one an unknown address is a
       * typo, and warning about every one of them is noise that teaches
       * operators to ignore the log.
       *
       * A log is not an oracle: it reaches an operator reading the host, not
       * the caller guessing addresses.
       */
      const directories = (await this.configuredProviders())
        .map((provider) => provider.source)
        .filter((source) => source !== 'local')
        .sort();
      if (directories.length > 0) this.warnNoAccount(email, directories);

      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const provider = this.forSource(account.authSource);

    if (provider === null) {
      // The account names a provider this deployment no longer has — say,
      // LDAP_URL unset after the account was provisioned for LDAP.
      // Refuse, and say so in the log rather than to the caller.
      this.logger.warn(
        `Login refused for an account whose authSource "${account.authSource}" has no provider. ` +
          `Configured sources: ${this.sources().join(', ') || 'none'}.`,
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    /*
     * A DORMANT provider (ADR-0029): registered, nothing to point at. Typically
     * an account provisioned before its directory was enabled, or one whose
     * directory settings were discarded.
     *
     * Refused HERE, with the generic answer and inside the floor that
     * `authenticate` applies around this method — so a dormant directory looks
     * exactly like a wrong password from outside. The log says why, once per
     * change of state, because "configured LDAP, user still refused" is the
     * question an operator will be asking.
     */
    if (!(await this.isConfigured(provider))) {
      this.warnDormant(provider.source, 'Login');
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    return provider.authenticate(credentials);
  }

  /**
   * Re-resolve a principal, e.g. on refresh.
   *
   * Fails closed when the source is gone: the session ends rather than the
   * request throwing (ADR-0015 §3). The access token already issued is left to
   * expire on its own — killing sessions mid-request the instant a directory
   * is switched off would be needlessly abrupt.
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

    // A directory whose settings were discarded ends its sessions at the next
    // refresh, exactly as a deregistered one does (ADR-0015 §3, ADR-0029).
    if (!(await this.isConfigured(provider))) {
      this.warnDormant(provider.source, 'Refresh');
      return null;
    }

    return provider.resolve(userId);
  }

  /**
   * Say it once a minute, and say how many were swallowed.
   *
   * THROTTLED BECAUSE THE RATE LIMITER DOES NOT BOUND THIS. The login limiter
   * keys on `${ip}|${email}`, so ten attempts buys ten tries PER ADDRESS — an
   * unauthenticated caller varying the address gets a fresh bucket every
   * request, and an unthrottled warning here would emit one line per request,
   * for as long as they cared to keep going. A log that can be driven by a
   * stranger is a disk-full incident with extra steps.
   *
   * One line the moment it starts is all an operator configuring a directory
   * needs; the suppressed count is what stops the throttle hiding a flood
   * instead of reporting it.
   */
  private warnNoAccount(email: string, directories: string[]): void {
    const now = Date.now();

    if (now < this.warnMutedUntil) {
      this.warnSuppressed += 1;
      return;
    }

    const swallowed =
      this.warnSuppressed > 0 ? ` (${String(this.warnSuppressed)} similar suppressed)` : '';
    this.warnSuppressed = 0;
    this.warnMutedUntil = now + NO_ACCOUNT_WARN_INTERVAL_MS;

    /*
     * JSON.stringify, not a bare interpolation.
     *
     * `credentialsSchema` is `z.string().min(1).max(255)` with NO `.email()`,
     * and correctly so: an AD deployment logs in with a username, which is what
     * `identifierLabel` exists to say. `trim()` strips the ends, so an interior
     * newline survives — and a raw interpolation would let an unauthenticated
     * caller write whatever they liked into the log, forging entries beneath a
     * line that looks like ours.
     *
     * Escaping here rather than tightening the schema: `.email()` would reject
     * every legitimate AD username.
     */
    this.logger.warn(
      `Login refused for ${JSON.stringify(email)}: no account exists. Directory users are ` +
        'not provisioned automatically (ADR-0015 §5) — create the account with ' +
        `authSource set to one of: ${directories.join(', ')}.${swallowed}`,
    );
  }

  /**
   * Say that a dormant source refused somebody — once per change of state.
   *
   * Not throttled by time like the no-account warning, and it does not need to
   * be: only an account that EXISTS with this source reaches here, so a
   * stranger varying addresses cannot drive it, and the set is cleared only
   * when the provider is seen configured again.
   */
  private warnDormant(source: string, what: 'Login' | 'Refresh'): void {
    if (this.dormantWarned.has(source)) return;
    this.dormantWarned.add(source);

    this.logger.warn(
      `${SOURCE_NAMES[source] ?? source} sign-in is not configured. ${what} refused for an ` +
        `account with authSource "${source}". Configure it under Settings, Directory / Auth; ` +
        'local accounts are unaffected. (Said once until the configuration changes.)',
    );
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

/** How the log names a source. Anything else is named by its source string. */
const SOURCE_NAMES: Record<string, string> = { ldap: 'LDAP', oidc: 'OIDC' };

function describeSource(provider: IAuthProvider): AuthSourceDescriptor {
  return {
    source: provider.source,
    mode: provider.mode ?? 'credentials',
    identifierLabel: provider.identifierLabel ?? 'Email',
  };
}

/**
 * Sorted, so two deployments with the same providers answer identically and a
 * login page cannot reorder its own buttons between polls.
 */
function bySourceName(a: { source: string }, b: { source: string }): number {
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}
