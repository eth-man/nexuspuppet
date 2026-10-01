import type {
  AuthProviderDescription,
  AuthResult,
  AuthenticatedPrincipal,
  Credentials,
  DirectoryUser,
  IAuthProvider,
  IAuthProviderSettings,
  ProviderVerification,
} from '@nexuspuppet/contracts';
import { type LdapConfig, ldapConfigSchema } from './config';
import { buildFilter } from './filter';
import {
  LdapUnavailableError,
  LdaptsDirectory,
  type LdapDirectory,
  type LdapEntry,
} from './ldap-client';
import { resolveRoles } from './role-mapping';

/**
 * Identity lookup this provider needs from the host application.
 *
 * LDAP owns CREDENTIALS and GROUP MEMBERSHIP. It does not own the user's
 * identity within NexusPuppet, because `AuthenticatedPrincipal.userId` must be
 * a row in `users` — refresh_tokens and audit_logs both carry a foreign key to
 * it. A principal with an invented id would fail at session issuance, or worse,
 * detach the audit trail from the person who acted.
 *
 * So accounts are provisioned in NexusPuppet (with authSource 'ldap' and no
 * password hash) and the directory decides whether the person may log in and
 * with what role.
 */
export interface LdapIdentityStore {
  findByEmail(email: string): Promise<StoredIdentity | null>;
  findById(userId: string): Promise<StoredIdentity | null>;
  /**
   * Persist what the directory said at login: the role derived from group
   * membership, and the current display name.
   *
   * Without this, `resolve()` on token refresh would read a role the directory
   * may have changed hours ago, and the two paths would disagree about what a
   * user may do. Writing it at login makes the stored row a cache of the
   * directory with a well-defined refresh point.
   */
  /**
   * `role` is a NAME, not the built-in enum (ADR-0018). A deployment may map a
   * group to a role it defined itself, and this is the primary of those.
   */
  recordLogin(userId: string, update: { role: string; displayName: string }): Promise<void>;
}

/**
 * Exactly `DirectoryUser` from contracts 0.3.0. Aliased rather than redeclared:
 * a parallel structural copy would drift, and the field that would drift first
 * is `isActive` — whose absence silently denies every login.
 */
export type StoredIdentity = DirectoryUser;

export interface LdapAuthProviderDeps {
  /**
   * The ENVIRONMENT baseline, or null when `LDAP_URL` is not set (ADR-0029).
   *
   * Null is an ordinary state: the provider is registered on every deployment,
   * and with nothing stored either it is DORMANT — not offered at login, and
   * refusing its accounts — until somebody configures it from the console.
   */
  config: LdapConfig | null;
  /**
   * A client for `config`. Built at boot from the environment so an unreadable
   * CA bundle fails the boot rather than a login; optional, and built on first
   * use when absent.
   */
  directory?: LdapDirectory | null;
  identities: LdapIdentityStore;
  logger?: { log(m: string): void; warn(m: string): void; error(m: string): void };
  /**
   * Builds a directory client for a CANDIDATE configuration, used only by
   * verifyConfiguration.
   *
   * A factory rather than a second client, because the contract says a test
   * must not disturb the directory the deployment is currently using: the
   * candidate gets its own connection, and the live one is never touched.
   * Injected so the test path can be exercised without a real server.
   */
  directoryFor?: (config: LdapConfig) => LdapDirectory;
  /**
   * Core's reader for what an operator saved (ADR-0016 §4, #113).
   *
   * Optional, and absent means exactly today's behaviour: the boot
   * configuration governs and nothing is read per login. Supplied, a stored
   * configuration takes precedence and takes effect on the next login without
   * a restart — which is what the settings screen has always appeared to do.
   */
  settings?: IAuthProviderSettings;
}

/** The configuration in force for one authentication, and its client. */
interface EffectiveDirectory {
  config: LdapConfig;
  directory: LdapDirectory;
}

/**
 * LDAP / Active Directory authentication (ADR-0006, ADR-0015, ADR-0029).
 *
 * Registered on EVERY deployment, ALONGSIDE the local provider in
 * AUTH_PROVIDERS, and dispatched to for accounts whose `authSource` is `ldap`
 * (see app.module.ts). What it authenticates against is resolved per login:
 * a configuration saved in the console, else the `LDAP_*` environment, else
 * nothing — in which case it is dormant and `isConfigured()` says so. Nothing downstream changes: guards, RBAC, session
 * issuance and audit consume only AuthenticatedPrincipal, and this class knows
 * nothing about JWTs, cookies, or refresh rotation — by design, so that
 * adding the provider cannot alter any of them.
 *
 * The flow is the standard two-bind pattern:
 *
 *   1. bind as the service account (or anonymously) and SEARCH for the user,
 *      to discover their DN — you cannot construct a DN reliably from an email;
 *   2. bind AS THAT DN with the supplied password. A successful bind is the
 *      authentication. The password is never compared by this code and never
 *      leaves the process except to the directory over TLS.
 */
export class LdapAuthProvider implements IAuthProvider {
  readonly source = 'ldap';
  readonly mode = 'credentials' as const;

  /** The environment baseline, or null. See LdapAuthProviderDeps.config. */
  private readonly config: LdapConfig | null;
  /** A client for the baseline, built on first use if boot did not supply one. */
  private bootDirectory: LdapDirectory | null;
  private readonly identities: LdapIdentityStore;
  private readonly logger: NonNullable<LdapAuthProviderDeps['logger']>;
  private readonly directoryFor: (config: LdapConfig) => LdapDirectory;
  private readonly settings: IAuthProviderSettings | undefined;

  /**
   * The last stored configuration and the client built for it.
   *
   * Keyed by the configuration itself so a client is rebuilt only when
   * something actually changed. `LdaptsDirectory` reads its CA bundle at
   * construction, so building one per login would turn every sign-in into a
   * file read for no benefit.
   */
  private effectiveCache: { key: string; effective: EffectiveDirectory } | null = null;

  /**
   * The configuration the last resolution found in force, or null when the
   * provider was dormant. What `identifierLabel` and `describe()` report, since
   * both are synchronous and the configuration is not.
   */
  private current: LdapConfig | null;

  constructor(deps: LdapAuthProviderDeps) {
    this.config = deps.config;
    this.bootDirectory = deps.directory ?? null;
    this.settings = deps.settings;
    this.identities = deps.identities;
    this.logger = deps.logger ?? console;
    this.directoryFor = deps.directoryFor ?? ((config) => new LdaptsDirectory(config, this.logger));
    this.current = deps.config;

    if (this.config !== null) warnAbout(this.config, this.logger);
  }

  /**
   * 'Username' for AD, 'Email' otherwise — see the dialect defaults.
   *
   * Follows the configuration in force, so switching the dialect to Active
   * Directory from the console relabels the login form at the next page load.
   * The resolver asks `isConfigured()` first, which refreshes it.
   */
  get identifierLabel(): string {
    return this.current?.identifierLabel ?? 'Email';
  }

  /**
   * Whether there is anything to authenticate against (ADR-0029).
   *
   * Dormant only when NOTHING is stored and the environment configured
   * nothing. A stored configuration that cannot be read or parsed counts as
   * configured: the login path then refuses loudly with a reason in the log,
   * which is the existing fail-closed behaviour, rather than the directory
   * silently vanishing from the login page.
   */
  async isConfigured(): Promise<boolean> {
    try {
      return (await this.effective()) !== null;
    } catch {
      return true;
    }
  }

  /**
   * Explain this provider to an administrator (contracts 0.4.0).
   *
   * THE BIND PASSWORD IS NEVER INCLUDED, and neither is anything else that
   * could authenticate on its own. What is here — the URL, the search base and
   * filter, the bind DN — is what someone needs to recognise a
   * misconfiguration, and all of it is already visible to anyone who can read
   * the deployment's environment. The password is not, and this response is
   * rendered in a browser, where it would end up in screenshots and support
   * tickets.
   *
   * The bind DN is included deliberately while its password is not: knowing
   * WHICH account searches the directory is diagnostic, knowing its secret is
   * an escalation.
   */
  /**
   * The configuration this provider is running with, for the settings form to
   * open on (ADR-0016 §3).
   *
   * Distinct from describe(): that produces labelled prose for a human to read,
   * this produces the settings shape for a form to be populated from. A
   * deployment configured through LDAP_* variables has no stored row, and
   * without this the console shows an empty form to an operator whose directory
   * is demonstrably working.
   *
   * The bind password is excluded — the result is rendered in a browser. Core
   * strips it as well, but the omission belongs here first: this method knows it
   * is a secret, core only guesses from the field name.
   *
   * `attributes` and `caPath` are not returned. They have no field in the
   * settings schema, so core would discard them; sending them would only invite
   * the impression that the form round-trips them.
   *
   * Null when the environment configures no directory — there is no baseline,
   * and the console opens an empty form (ADR-0029).
   */
  currentConfiguration(): Record<string, unknown> | null {
    const config = this.config;
    if (config === null) return null;
    return {
      url: config.url,
      bindDn: config.bindDn,
      dialect: config.dialect,
      searchBase: config.searchBase,
      groupSearchBase: config.groupSearchBase,
      searchFilter: config.searchFilter,
      nestedGroups: config.nestedGroups,
      roleMappings: config.roleMappings.map((mapping) => ({
        groupDn: mapping.groupDn,
        role: mapping.role,
      })),
      timeoutMs: config.timeoutMs,
      tlsRejectUnauthorized: config.tlsRejectUnauthorized,
    };
  }

  /**
   * Try a CANDIDATE configuration without adopting it (ADR-0016 §4).
   *
   * Builds its own client for the candidate and never touches the live one, so
   * an operator testing a typo cannot disturb the directory the deployment is
   * currently authenticating against.
   *
   * The probe is a search for an identifier nothing can match. That one call
   * exercises everything worth knowing before saving — DNS, TCP, TLS and its
   * trust chain, the bind credentials, and whether the search base exists —
   * while reading no real user and changing nothing. A search that finds
   * nothing is a PASS: "no such user" is the expected answer, and only a
   * transport or protocol failure throws.
   *
   * Never throws. "I could not reach that directory" is an ordinary answer to
   * "does this work", and an operator needs the detail rather than a 500.
   */
  async verifyConfiguration(candidate: unknown): Promise<ProviderVerification> {
    const parsed = ldapConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      const where = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return { ok: false, message: `That configuration is not usable — ${where}` };
    }

    /*
     * THE CANDIDATE INHERITS THE DEPLOYMENT'S CA.
     *
     * `caPath` is deliberately not a field the console can send: a CA is a
     * mounted file (see the note on `caPath` in config.ts), so the settings
     * form has no way to express one and never will. Parsing a candidate
     * therefore always produced `caPath: undefined` — and a test against a
     * directory with a private CA failed with "unable to verify the first
     * certificate" while real logins through that same directory succeeded.
     *
     * That is the worst shape a diagnostic can have. Test Connection exists to
     * answer "is this configuration usable", and it was answering no about a
     * configuration that demonstrably worked, with an error pointing at TLS
     * rather than at the button. An operator following it would disable
     * verification to make the test pass — turning a correct deployment into an
     * interceptable one to satisfy a broken check.
     *
     * Absent means UNSPECIFIED, not "no CA": the form cannot say either. So the
     * candidate is tested with the trust material this deployment actually has.
     * A candidate that names its own path still wins, which is what a non-UI
     * caller supplying one means by it.
     *
     * Since ADR-0029 the form CAN carry a CA, as pasted PEM — and a candidate
     * carrying one is tested with exactly that and nothing inherited. With no
     * environment baseline there is nothing to inherit either, and the test
     * runs against the system trust store, which is what a save would do.
     */
    const bootCaPath = this.config?.caPath;
    const inheritedCa =
      parsed.data.caPem === undefined &&
      parsed.data.caPath === undefined &&
      bootCaPath !== undefined;
    const config: LdapConfig = inheritedCa ? { ...parsed.data, caPath: bootCaPath } : parsed.data;

    const details: ProviderVerification['details'] = [
      { label: 'Directory', value: config.url },
      { label: 'Bind account', value: config.bindDn ?? 'anonymous' },
      { label: 'Search base', value: config.searchBase },
      { label: 'TLS verification', value: describeTls(config, inheritedCa) },
    ];

    try {
      // An identifier no directory can hold. The point is to complete a bind
      // and a search, not to find anybody.
      const filter = buildFilter(
        config.searchFilter,
        `nexuspuppet-connectivity-probe-${Date.now()}`,
      );
      const found = await this.directoryFor(config).findEntry(filter);

      details.push({
        label: 'Probe search',
        value: found === null ? 'completed, matched nothing (expected)' : 'completed',
      });

      return {
        ok: true,
        message: `Connected to ${config.url}, bound as ${config.bindDn ?? 'anonymous'}, and searched ${config.searchBase}.`,
        details,
      };
    } catch (error) {
      return {
        ok: false,
        // The directory's own words. A message invented here would describe a
        // guess about the failure rather than the failure.
        message: describeError(error),
        details,
      };
    }
  }

  describe(): AuthProviderDescription {
    const config = this.current;
    if (config === null) {
      // Dormant. The resolver does not pick a dormant provider to describe,
      // so this is for a direct caller: say so rather than throw.
      return {
        source: this.source,
        roleMappings: [],
        refusesUnmappedUsers: true,
        details: [{ label: 'Status', value: 'not configured' }],
      };
    }

    return {
      source: this.source,
      roleMappings: config.roleMappings.map((mapping) => ({
        group: mapping.groupDn,
        role: mapping.role,
      })),
      // Always true for this provider: resolveRole returns null for an
      // unmapped user and authenticate() refuses on null. There is no default
      // role and no configuration that introduces one.
      refusesUnmappedUsers: true,
      details: [
        { label: 'Dialect', value: config.dialect },
        { label: 'Directory', value: config.url },
        { label: 'Search base', value: config.searchBase },
        { label: 'Search filter', value: config.searchFilter },
        {
          label: 'Bind account',
          value: config.bindDn ?? 'anonymous',
        },
        {
          label: 'TLS verification',
          value: describeTls(config),
        },
        {
          label: 'Group resolution',
          value: config.nestedGroups
            ? `nested (${config.groupSearchBase})`
            : 'direct membership only',
        },
        // Stated explicitly because it changes what the mapping table means: a
        // referred user is invisible, not absent.
        { label: 'Referrals', value: 'not followed' },
      ],
    };
  }

  async authenticate(credentials: Credentials): Promise<AuthResult> {
    // An LDAP bind with a DN and an EMPTY password is an "unauthenticated
    // bind" (RFC 4513 §5.1.2): the server MAY treat it as success while
    // granting nothing, so forwarding a blank password can authenticate
    // anybody.
    //
    // Whether it is accepted is a SERVER SETTING, which is the point. OpenLDAP
    // refuses it unless `allow bind_anon_dn` is configured; other directories
    // accept it out of the box, and an operator can enable it by accident.
    // Rejecting here — before any bind is attempted — makes the outcome
    // independent of a setting this application does not control.
    //
    // Verified against an OpenLDAP deliberately configured to accept it: the
    // server says yes to an empty password and this still says no.
    if (credentials.password.length === 0) {
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const email = credentials.email.trim().toLowerCase();

    try {
      // Resolved per login, which is what makes a saved change take effect
      // without a restart (ADR-0016 §4). A store that cannot be read throws
      // out of here into the catch below and refuses, rather than quietly
      // binding against a directory the operator has replaced.
      const effective = await this.effective();

      // Dormant: nothing stored, nothing in the environment (ADR-0029). The
      // resolver normally refuses before getting here; a direct caller gets
      // the same generic answer, never an attempt against nothing.
      if (effective === null) {
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }
      const { config, directory } = effective;

      const filter = buildFilter(config.searchFilter, email);
      const entry = await directory.findEntry(filter);

      // No such entry. Deliberately the same outcome as a wrong password: any
      // observable difference makes login a user-enumeration oracle against
      // the corporate directory, which is a considerably richer target than
      // this application's own user table.
      if (entry === null || entry.dn === '') {
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      const bound = await directory.verifyCredentials(entry.dn, credentials.password);
      if (!bound) {
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      // --- Authenticated. Everything below is authorization. ---------------

      // Direct membership from the entry, plus transitive membership when the
      // directory can compute it. Resolved AFTER the bind: this is an extra
      // query, and running it for someone who failed authentication would let
      // an unauthenticated caller drive load against the directory.
      const groupDns = config.nestedGroups
        ? await this.resolveNestedGroups(entry, directory)
        : entry.groupDns;

      const resolved = resolveRoles(groupDns, config);
      if (resolved === null) {
        // Correct credentials, no mapped group. Logged at info because this is
        // the message an operator needs when someone reports "my password
        // works everywhere else": their account is fine, their group is not
        // mapped.
        this.logger.log(
          `LDAP login refused for ${email}: authenticated, but member of no mapped group.`,
        );
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      const identity = await this.identities.findByEmail(entry.email ?? email);
      if (identity === null) {
        this.logger.log(
          `LDAP login refused for ${email}: authenticated against the directory, but no ` +
            'NexusPuppet account exists. Create one with authSource "ldap".',
        );
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      // Checked after the bind so a disabled account is indistinguishable from
      // a wrong password to anyone who does not already know the password.
      if (!identity.isActive) {
        return { ok: false, reason: 'ACCOUNT_DISABLED' };
      }

      // The directory is authoritative for the display name; it changes when
      // someone changes team or name, and nobody updates it here by hand.
      const displayName = entry.displayName ?? identity.displayName;

      // Cache the directory's answer so refresh agrees with login. A failure
      // here must not fail an otherwise valid authentication — the person
      // typed the right password and belongs to the right group.
      try {
        // The PRIMARY only. The store holds one role per user, so a person
        // whose mappings union several is recorded under the one shown in the
        // console; `roles` on the principal is what authorization reads.
        await this.identities.recordLogin(identity.userId, {
          role: resolved.primary,
          displayName,
        });
      } catch (error) {
        this.logger.warn(
          `Could not persist LDAP login state for ${email}: ${describeError(error)}. ` +
            'Session continues; refreshed tokens may carry the previous role.',
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
    } catch (error) {
      // An unreachable or misconfigured directory must NEVER be reported as
      // invalid credentials, and must never fall through to another provider.
      // Failing closed with a distinct reason is what stops a directory outage
      // from looking like an estate-wide password change.
      this.logger.error(
        `LDAP authentication error for ${email}: ${
          error instanceof LdapUnavailableError || error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
      return { ok: false, reason: 'PROVIDER_ERROR' };
    }
  }

  /**
   * Direct groups plus every group that transitively contains the user.
   *
   * A failure here is NOT fatal. The direct memberships are still a valid
   * answer, and refusing a login because an optional enrichment query failed
   * would turn a slow group subtree into an outage. It is logged loudly,
   * because the visible symptom otherwise is that someone who should be an
   * administrator quietly is not.
   */
  /**
   * The configuration this login should use, and a client for it — or null
   * when there is none and the provider is DORMANT (ADR-0029).
   *
   * Four outcomes, in precedence order (ADR-0016 §2):
   *
   * - **A stored configuration** — it governs, and takes effect on this login.
   * - **Nothing stored, an environment baseline** — the boot configuration.
   * - **Nothing stored, no baseline** — null. Dormant: not offered at login,
   *   and its accounts are refused generically by the resolver.
   * - **Unreadable, or stored but unusable** — throws. The caller turns that
   *   into PROVIDER_ERROR, which is the existing fail-closed path for a
   *   misconfigured directory. Falling back to the boot configuration would
   *   bind against a directory the operator has replaced, and report success.
   *
   * `caPath` is INHERITED from the boot configuration when the stored one has
   * neither a path nor pasted PEM, because it names a file on the host that a
   * settings screen cannot set. `verifyConfiguration` does the same for a
   * candidate; the same reasoning applies to a saved one.
   */
  private async effective(): Promise<EffectiveDirectory | null> {
    const stored = this.settings === undefined ? null : await this.settings.resolve(this.source);

    if (stored === null || stored === undefined) {
      this.current = this.config;
      if (this.config === null) return null;
      this.bootDirectory ??= this.directoryFor(this.config);
      return { config: this.config, directory: this.bootDirectory };
    }

    const bootCaPath = this.config?.caPath;
    const merged =
      typeof stored === 'object' &&
      (stored as { caPath?: unknown }).caPath === undefined &&
      (stored as { caPem?: unknown }).caPem === undefined &&
      bootCaPath !== undefined
        ? { ...(stored as object), caPath: bootCaPath }
        : stored;

    const parsed = ldapConfigSchema.safeParse(merged);
    if (!parsed.success) {
      // The row was validated when it was saved, so a mismatch here means the
      // stored shape and this build's schema have diverged. Loud, because the
      // alternative is authenticating against something nobody chose.
      throw new Error(
        'The stored LDAP configuration does not match this build’s schema ' +
          `(${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}). ` +
          'Directory logins are refused until it is corrected or discarded; local accounts ' +
          'are unaffected.',
      );
    }

    const key = JSON.stringify(parsed.data);
    if (this.effectiveCache?.key !== key) {
      this.logger.log('LDAP configuration changed; rebuilding the directory client.');
      // Said once per change, as the boot configuration's warnings are said
      // once per boot: a stored configuration deserves the same scrutiny.
      warnAbout(parsed.data, this.logger);
      this.effectiveCache = {
        key,
        effective: { config: parsed.data, directory: this.directoryFor(parsed.data) },
      };
    }
    this.current = this.effectiveCache.effective.config;
    return this.effectiveCache.effective;
  }

  private async resolveNestedGroups(entry: LdapEntry, directory: LdapDirectory): Promise<string[]> {
    try {
      const nested = await directory.findGroupsContaining(entry.dn);
      // Union: AD returns the nested closure, but the entry's own memberOf can
      // include groups from another domain that the chain query did not reach.
      return [...new Set([...entry.groupDns, ...nested])];
    } catch (error) {
      this.logger.error(
        `Nested group resolution failed for ${entry.dn}: ${describeError(error)}. ` +
          'Falling back to direct membership only — a user whose role comes from a nested ' +
          'group will be refused or under-privileged until this is fixed.',
      );
      return entry.groupDns;
    }
  }

  /**
   * Re-resolve on refresh, so a deactivation takes effect within one access
   * token lifetime rather than at the end of the refresh window.
   *
   * The role is NOT re-read from the directory here: refresh runs on every
   * token rotation and a directory round trip on that path would make session
   * continuity depend on directory availability. Group changes take effect at
   * next login, which is the conventional trade and is documented for
   * operators.
   */
  async resolve(userId: string): Promise<AuthenticatedPrincipal | null> {
    const identity = await this.identities.findById(userId);
    if (identity === null || !identity.isActive) return null;

    return {
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      // Written by recordLogin at the last successful authentication.
      role: identity.role,
      authSource: this.source,
    };
  }
}

/**
 * Say what the connection is actually trusting, not merely that it verifies.
 *
 * "enforced" alone does not tell an administrator WHICH trust store is in play,
 * and the usual on-prem failure is a directory signed by an internal CA that
 * nobody remembered to mount — where the honest answer is that verification is
 * running against the system store and will therefore fail.
 */
/**
 * @param inherited the CA came from the running deployment, not the candidate.
 *
 * Said out loud, because otherwise the line claims the tested configuration
 * carries a CA it does not contain — and the next operator to move that
 * configuration to a host without the file would find the test still passing
 * here and the directory unreachable there.
 */
function describeTls(config: LdapConfig, inherited = false): string {
  if (!config.url.startsWith('ldaps://')) return 'not applicable (cleartext ldap://)';
  if (!config.tlsRejectUnauthorized) return 'DISABLED';
  if (config.caPem !== undefined) return 'enforced (CA certificate saved in the console)';
  if (config.caPath === undefined) return 'enforced (system trust store)';
  return inherited
    ? `enforced (CA bundle ${config.caPath}, from this deployment)`
    : `enforced (CA bundle ${config.caPath})`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The three configurations worth a warning whenever they come into force:
 * at boot for the environment, and on each change for a stored one.
 */
function warnAbout(config: LdapConfig, logger: { warn(message: string): void }): void {
  if (!config.tlsRejectUnauthorized) {
    logger.warn(
      'LDAP TLS certificate verification is DISABLED. Every credential submitted to ' +
        'this console is interceptable by anyone on the network path. Do not run this ' +
        'outside initial bootstrapping.',
    );
  }
  if (config.url.startsWith('ldap://')) {
    logger.warn('The LDAP URL uses ldap:// — binds send the password in cleartext. Use ldaps://.');
  }
  if (config.roleMappings.length === 0) {
    logger.warn(
      'No LDAP role mappings configured. Every login will be refused, because a user ' +
        'in no mapped group is not granted a default role.',
    );
  }
}
