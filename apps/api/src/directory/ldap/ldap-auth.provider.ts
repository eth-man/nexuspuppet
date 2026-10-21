import type {
  AuthProviderDescription,
  AuthResult,
  AuthenticatedPrincipal,
  Credentials,
  DirectoryAccounts,
  DirectoryUser,
  IAuthProvider,
  IAuthProviderSettings,
  LdapDialectName,
  LdapVerification,
  ProviderVerification,
} from '@nexuspuppet/contracts';
import {
  ACCOUNT_DISPLAY_NAME_MAX,
  LDAP_EMAIL_PLACEHOLDER,
  accountEmailSchema,
} from '@nexuspuppet/contracts';
import { LogThrottle, throttledLogger } from '../../common/log-throttle';
import { type LdapConfig, ldapConfigSchema } from './config';
import { dialectDefaults } from './dialect';
import { InvalidUsernameError, buildBindIdentity, isDnPattern } from './dn';
import { buildFilter, escapeFilterValue } from './filter';
import {
  LdapUnavailableError,
  LdaptsDirectory,
  type DialectDetection,
  type LdapDirectory,
  type LdapEntry,
} from './ldap-client';
import { normalizeDn, resolveRoles } from './role-mapping';

/**
 * Identity lookup this provider needs from the host application.
 *
 * LDAP owns CREDENTIALS and GROUP MEMBERSHIP. It does not own the user's
 * identity within NexusPuppet, because `AuthenticatedPrincipal.userId` must be
 * a row in `users` — refresh_tokens and audit_logs both carry a foreign key to
 * it. A principal with an invented id would fail at session issuance, or worse,
 * detach the audit trail from the person who acted.
 *
 * So every directory user has an account in NexusPuppet (authSource 'ldap',
 * no password hash), LINKED to their directory entry by its stable id
 * (ADR-0031), and the directory decides whether the person may sign in and
 * with what role.
 */
export interface LdapIdentityStore {
  findByEmail(email: string): Promise<StoredIdentity | null>;
  findById(userId: string): Promise<StoredIdentity | null>;
  /** The account linked to a directory entry (ADR-0031). */
  findByDirectoryId(directoryId: string): Promise<StoredIdentity | null>;
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

/** A person the directory authenticated. */
interface DirectoryMatch {
  entry: LdapEntry;
  groupDns: string[];
  /**
   * What was typed, normalised — but only when the directory VOUCHED for it:
   * the search matched this entry by it, or a Simple bind bound as it. It may
   * then link an account carrying it as its email. Null when the bind proved
   * only part of it ({username} drops the domain), so it vouches for nothing.
   */
  vouchedIdentifier: string | null;
}

/**
 * How many refusal lines a minute for an identifier NO account has (ADR-0031).
 *
 * Sign-in is directory-first, so anything typed reaches the directory, and
 * each refusal says why. The login limiter keys on address and IP, so it does
 * not bound that across identifiers: the lines are throttled — enough for an
 * operator trying several people in a row, not enough for a stranger to fill
 * a disk.
 */
const UNKNOWN_IDENTIFIER_LINES_PER_MINUTE = 10;

type ProviderLogger = NonNullable<LdapAuthProviderDeps['logger']>;

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
 * For the Regular and Anonymous bind types the flow is the standard two-bind
 * pattern:
 *
 *   1. bind as the service account (or not at all) and SEARCH for the user,
 *      to discover their DN — you cannot construct a DN reliably from an email;
 *   2. bind AS THAT DN with the supplied password. A successful bind is the
 *      authentication. The password is never compared by this code and never
 *      leaves the process except to the directory over TLS.
 *
 * Simple bind (ADR-0030 §3) has no service account: the DN is constructed
 * from a pattern, with the username escaped for DN context, the person binds
 * as it, and their own entry is read as them.
 */
export class LdapAuthProvider implements IAuthProvider {
  readonly source = 'ldap';
  readonly mode = 'credentials' as const;

  /** The environment baseline, or null. See LdapAuthProviderDeps.config. */
  private readonly config: LdapConfig | null;
  /** A client for the baseline, built on first use if boot did not supply one. */
  private bootDirectory: LdapDirectory | null;
  private readonly identities: LdapIdentityStore;
  private readonly logger: ProviderLogger;
  /** The same logger, throttled, for identifiers no account has. See above. */
  private readonly unknownIdentifierLogger: ProviderLogger;
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
    this.unknownIdentifierLogger = throttledLogger(
      this.logger,
      new LogThrottle(UNKNOWN_IDENTIFIER_LINES_PER_MINUTE, 60_000),
    );
    this.directoryFor = deps.directoryFor ?? ((config) => new LdaptsDirectory(config, this.logger));
    this.current = deps.config;

    if (this.config !== null) warnAbout(this.config, this.logger);
  }

  /**
   * 'Username or email' for every dialect — the directory is asked first, so a
   * username finds the person (ADR-0031) — and 'Email' for a Simple pattern
   * built from {email}, which binds as the whole address. 'Email' while
   * dormant: there is nothing to type a username for.
   *
   * Follows the configuration in force, so a save that detects Active
   * Directory (or chooses Simple bind) relabels the login form at the next
   * page load.
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
      host: config.host,
      port: config.port,
      protocol: config.protocol,
      bindType: config.bindType,
      bindDn: config.bindDn,
      userDnPattern: config.userDnPattern,
      // The environment does not detect: this is LDAP_DIALECT, or the default.
      detectedDialect: config.dialect,
      searchBase: config.searchBase,
      groupSearchBase: config.groupSearchBase,
      /*
       * Only a filter somebody CHOSE. The parsed configuration carries the
       * dialect's default as if it had been set, and reporting that froze it:
       * saving a form opened on this baseline stored the default as an
       * explicit filter, so a later, better default never reached that
       * deployment — which is how the AD filter without `mail` would have
       * outlived its fix.
       */
      ...(config.searchFilter === dialectDefaults(config.dialect).searchFilter
        ? {}
        : { searchFilter: config.searchFilter }),
      nestedGroups: config.nestedGroups,
      autoCreateAccounts: config.autoCreateAccounts,
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
  async verifyConfiguration(candidate: unknown): Promise<LdapVerification> {
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
    const { config: candidateConfig, inheritedCa } = this.withInheritedCa(parsed.data);

    const details: NonNullable<ProviderVerification['details']> = [
      { label: 'Server', value: `${candidateConfig.host}:${candidateConfig.port}` },
      { label: 'Protocol', value: describeProtocol(candidateConfig) },
      { label: 'Bind type', value: describeBindType(candidateConfig) },
      { label: 'Search base', value: candidateConfig.searchBase },
      { label: 'TLS verification', value: describeTls(candidateConfig, inheritedCa) },
    ];

    /*
     * FIRST, WHAT IS THIS DIRECTORY (ADR-0030 §4).
     *
     * The RootDSE read is also the connection test: DNS, TCP, the STARTTLS
     * upgrade, the certificate and its name all have to work before it can
     * answer. A failure here is reported in those terms — and, for STARTTLS,
     * with the assurance that no credential went out unencrypted.
     */
    let detection: DialectDetection;
    try {
      detection = await this.directoryFor(candidateConfig).detectDialect();
    } catch (error) {
      return {
        ok: false,
        message: describeError(error),
        details: withDirectoryWords(details, error),
        detectedDialect: null,
      };
    }

    const dialect: LdapDialectName = detection.dialect ?? 'openldap';
    details.push({ label: 'Directory type', value: describeDetection(detection) });

    // Re-parsed rather than patched: the dialect supplies the search filter
    // and the attributes, so the probe below must use the DETECTED one's.
    const reparsed = ldapConfigSchema.safeParse({
      ...(candidate as Record<string, unknown>),
      dialect,
    });
    const config = reparsed.success ? this.withInheritedCa(reparsed.data).config : candidateConfig;

    const unknownNote =
      detection.dialect === null
        ? ' The server would not show its RootDSE, so the directory type is unknown and it is treated as OpenLDAP.'
        : '';

    if (config.bindType === 'simple') {
      details.push({ label: 'Bind account', value: `each user, as ${config.userDnPattern ?? ''}` });
      const pattern = config.userDnPattern ?? '';
      if (!isDnPattern(pattern) && dialect !== 'ad') {
        return {
          ok: false,
          message:
            `A UPN pattern (${pattern}) only works against Active Directory, and this server is ` +
            `not one. Use a DN pattern such as uid={username},ou=people,dc=example,dc=com.${unknownNote}`,
          details,
          detectedDialect: detection.dialect,
        };
      }
      return {
        ok: true,
        message:
          `Connected to ${config.host}:${config.port} over ${describeProtocol(config)} and read ` +
          'its RootDSE. Simple bind has no service account, so the search base and the pattern ' +
          `are first exercised when somebody signs in.${unknownNote}`,
        details,
        detectedDialect: detection.dialect,
      };
    }

    const account = config.bindType === 'regular' ? (config.bindDn ?? '') : 'anonymous';
    details.push({ label: 'Bind account', value: account });

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
        message:
          `Connected to ${config.host}:${config.port} over ${describeProtocol(config)}, bound as ` +
          `${account}, and searched ${config.searchBase}.${unknownNote}`,
        details,
        detectedDialect: detection.dialect,
      };
    } catch (error) {
      return {
        ok: false,
        // The directory's own words — or, where they are opaque (AD's
        // 000004DC), a plain explanation with those words kept beneath it.
        message: describeError(error),
        details: withDirectoryWords(details, error),
        detectedDialect: detection.dialect,
      };
    }
  }

  /**
   * THE CANDIDATE INHERITS THE DEPLOYMENT'S CA — see the note at the top of
   * verifyConfiguration. A save runs verifyConfiguration too, so it detects
   * and checks through the same trust a test does.
   */
  private withInheritedCa(parsed: LdapConfig): { config: LdapConfig; inheritedCa: boolean } {
    const bootCaPath = this.config?.caPath;
    const inheritedCa =
      parsed.caPem === undefined && parsed.caPath === undefined && bootCaPath !== undefined;
    return { config: inheritedCa ? { ...parsed, caPath: bootCaPath } : parsed, inheritedCa };
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
        { label: 'Server', value: `${config.host}:${config.port}` },
        { label: 'Protocol', value: describeProtocol(config) },
        { label: 'Bind type', value: describeBindType(config) },
        { label: 'Search base', value: config.searchBase },
        ...(config.bindType === 'simple'
          ? [{ label: 'User DN pattern', value: config.userDnPattern ?? '' }]
          : [{ label: 'Search filter', value: config.searchFilter }]),
        {
          label: 'Bind account',
          value:
            config.bindType === 'regular'
              ? (config.bindDn ?? '')
              : config.bindType === 'simple'
                ? 'each user'
                : 'anonymous',
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
        // And this changes what it means more: with it on, the mapping table
        // is the list of who may have an account at all (ADR-0031).
        {
          label: 'Accounts',
          value: config.autoCreateAccounts
            ? 'linked at sign-in; created at first sign-in for anyone in a mapped group'
            : 'linked at sign-in; created by an administrator',
        },
      ],
    };
  }

  /**
   * Sign in, finding the account WITHOUT writing: linked to the entry, else
   * carrying one of its addresses. Never links and never creates — those need
   * `authenticateDirectory`'s writer, which the resolver supplies.
   */
  async authenticate(credentials: Credentials): Promise<AuthResult> {
    return this.signIn(credentials, null);
  }

  /**
   * Directory-first sign-in (ADR-0031): authenticate whatever was typed —
   * username, UPN or email — then find the account linked to the entry, link
   * one that carries its address, or create one where that is turned on.
   */
  async authenticateDirectory(
    credentials: Credentials,
    accounts: DirectoryAccounts,
  ): Promise<AuthResult> {
    return this.signIn(credentials, accounts);
  }

  /**
   * ONE implementation of search, bind and group resolution, whichever way it
   * was asked: a second copy for directory-first sign-in would be a second
   * place for the subtle parts — escaping, the two-entry refusal — to drift.
   */
  private async signIn(
    credentials: Credentials,
    accounts: DirectoryAccounts | null,
  ): Promise<AuthResult> {
    /*
     * Refusals of an identifier NO account has go through a throttle: with
     * directory-first sign-in anybody can type anything and reach here, and
     * the login limiter does not bound that across identifiers. One that is
     * an account's email is bounded by the limiter, and logged in full.
     */
    const log =
      accounts !== null && !accounts.identifierHasAccount
        ? this.unknownIdentifierLogger
        : this.logger;

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

    // Lower-cased: AD's and OpenLDAP's default matching rules for these
    // attributes are case-insensitive, and account emails are stored lower-case.
    const identifier = credentials.email.trim().toLowerCase();

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

      const found =
        config.bindType === 'simple'
          ? await this.bindDirectly(config, directory, identifier, credentials.password, log)
          : await this.searchThenBind(config, directory, identifier, credentials.password, log);

      // No such entry, or the wrong password — deliberately one outcome: any
      // observable difference makes login a user-enumeration oracle against
      // the corporate directory, which is a considerably richer target than
      // this application's own user table.
      if (found === null) {
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      // --- Authenticated. Everything below is authorization. ---------------
      const { entry, groupDns } = found;

      const resolved = resolveRoles(groupDns, config);
      if (resolved === null) {
        // Correct credentials, no mapped group. Logged at info because this is
        // the message an operator needs when someone reports "my password
        // works everywhere else": their account is fine, their group is not
        // mapped. Nothing is linked or created for them.
        log.log(
          `LDAP login refused for ${identifier}: authenticated as ${entry.dn}, but member of no ` +
            'mapped group — no account linked or created.',
        );
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      const identity = await this.accountFor(found, resolved.primary, effective, accounts, log, {
        identifier,
      });
      if (identity === null) {
        // accountFor has said why.
        return { ok: false, reason: 'INVALID_CREDENTIALS' };
      }

      // Checked after the bind so a disabled account is indistinguishable from
      // a wrong password to anyone who does not already know the password.
      // Never recreated, never reactivated: a deactivated account is still
      // the account linked to this person (ADR-0031).
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
          `Could not persist LDAP login state for ${identity.email}: ${describeError(error)}. ` +
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
      log.error(
        `LDAP authentication error for ${identifier}: ${
          error instanceof LdapUnavailableError || error instanceof Error
            ? error.message
            : String(error)
        }${error instanceof LdapUnavailableError && error.detail !== undefined ? ` (${error.detail})` : ''}`,
      );
      return { ok: false, reason: 'PROVIDER_ERROR' };
    }
  }

  /**
   * WHICH ACCOUNT this authenticated, authorised person is (ADR-0031), in
   * order:
   *
   * 1. **Linked** — the account whose `directoryId` is the entry's. Whatever
   *    was typed, and however their mail or UPN has changed since.
   * 2. **Linkable** — an `ldap` account with no link yet whose email is what
   *    was typed (when the directory vouched for it), the entry's mail, or its
   *    UPN. Linked now, so step 1 finds it next time. NEVER a local account
   *    (ADR-0015 §1: a directory password must not open a password account),
   *    and never one already linked to a different entry.
   * 3. **Created** — where the operator turned it on: a new account with the
   *    entry's own address and the mapped role.
   *
   * Else null, with the reason in the log. Without a writer (`accounts` null)
   * steps 2 and 3 find but never write.
   *
   * WITHOUT A DIRECTORY ID — a directory whose ACLs hide objectGUID/entryUUID
   * from the reader — nothing can be linked or created, and step 2 falls back
   * to the account carrying the address, unlinked: how every directory
   * sign-in worked before, so such a deployment keeps working.
   */
  private async accountFor(
    found: DirectoryMatch,
    role: string,
    { config, directory }: EffectiveDirectory,
    accounts: DirectoryAccounts | null,
    log: ProviderLogger,
    { identifier }: { identifier: string },
  ): Promise<StoredIdentity | null> {
    const { entry } = found;
    const directoryId = entry.directoryId ?? null;

    // 1. Linked.
    if (directoryId !== null) {
      const linked = await this.identities.findByDirectoryId(directoryId);
      if (linked !== null) {
        if (linked.authSource === this.source) return linked;
        // Only a directory sign-in sets the column, and moving an account to
        // another source clears it; a row like this was edited by hand.
        log.warn(
          `LDAP login refused for ${identifier}: the account linked to ${entry.dn} ` +
            `(${linked.email}) is a "${linked.authSource}" account, and is never opened ` +
            'with a directory password.',
        );
        return null;
      }
    }

    // 2. Linkable, by address.
    const addresses = [
      ...new Set(
        [found.vouchedIdentifier, entry.email ?? null, entry.upn ?? null]
          .filter((value): value is string => value !== null)
          .map((value) => value.trim().toLowerCase())
          // Only an address can be an account's email; a bare `jdoe` is not.
          .filter((value) => accountEmailSchema.safeParse(value).success),
      ),
    ];

    for (const address of addresses) {
      const account = await this.identities.findByEmail(address);
      if (account === null) continue;

      if (account.authSource !== this.source) {
        log.log(
          `LDAP login for ${identifier}: ${address} is a "${account.authSource}" account, which ` +
            'is never linked to a directory entry — a directory password must not open it. ' +
            'Not used.',
        );
        continue;
      }
      /*
       * AN ADDRESS THE PERSON DID NOT TYPE MUST NAME ONLY THEM. Mail is not
       * unique in either directory, and on AD one entry's mail can be
       * another's UPN — so an account an administrator created for somebody
       * by that address could otherwise be linked to whoever carrying it signs
       * in first. Before ADR-0031 that address was searched for and refused
       * when it matched two entries; it still is, here: it must find exactly
       * THIS entry through the configured search. Simple bind has no account
       * to search with, so there only what the bind proved can link.
       */
      if (
        address !== found.vouchedIdentifier &&
        !(await this.namesOnly(address, entry, config, directory))
      ) {
        log.warn(
          `LDAP login for ${identifier}: the account ${address} carries an address of ` +
            `${entry.dn}, but that address does not identify only that entry through the ` +
            `search (${searchedAttributes(config.searchFilter)}), so it is not used to link ` +
            'the account. Sign in with that address itself, or make it unique in the directory.',
        );
        continue;
      }

      const existingLink = account.directoryId ?? null;
      if (existingLink !== null && existingLink !== directoryId) {
        log.warn(
          `LDAP login for ${identifier}: the account ${address} is linked to a different ` +
            `directory entry (${existingLink}, not ${directoryId ?? 'unknown'}), and is never ` +
            're-linked. Not used. If the person really is the same, move the account to local ' +
            'and back to ldap to clear the link.',
        );
        continue;
      }

      // Nothing to link with, nothing to link through, or an account that
      // would only be refused: use it as it is.
      if (directoryId === null || accounts === null || !account.isActive) {
        if (directoryId === null) {
          log.log(
            `LDAP login for ${identifier}: the directory did not return a stable id ` +
              `(${config.attributes.directoryId}) for ${entry.dn}, so the account ${address} is ` +
              'used without being linked. Give the reader access to that attribute.',
          );
        }
        return account;
      }

      return accounts.link(account.userId, directoryId);
    }

    // 3. Created.
    if (accounts !== null && config.autoCreateAccounts) {
      if (directoryId === null) {
        log.warn(
          `LDAP login refused for ${identifier}: authenticated as ${entry.dn}, but the directory ` +
            `did not return its stable id (${config.attributes.directoryId}) — no account ` +
            'created, because one could not be linked to the person. Give the reader access ' +
            'to that attribute.',
        );
        return null;
      }

      const email = [entry.email, entry.upn, entry.username]
        .map((value) => (value ?? '').trim().toLowerCase())
        .find((value) => accountEmailSchema.safeParse(value).success);
      if (email === undefined) {
        log.warn(
          `LDAP login refused for ${identifier}: authenticated as ${entry.dn}, but the entry has ` +
            'no email address (mail or userPrincipalName) to key an account by — no account ' +
            'created.',
        );
        return null;
      }

      return accounts.create({
        email,
        displayName: firstSignInDisplayName(entry.displayName, email),
        role,
        directoryId,
      });
    }

    log.log(
      `LDAP login refused for ${identifier}: authenticated as ${entry.dn}, but no NexusPuppet ` +
        'account is linked to that entry or carries one of its addresses ' +
        `(${addresses.join(', ') || 'none'}). Create an account with authSource "ldap" and one ` +
        'of those emails, or turn on automatic account creation.',
    );
    return null;
  }

  /**
   * Whether `address`, searched for as a sign-in name, finds exactly `entry`
   * and nothing else. False for no match, a different entry, two entries,
   * Simple bind (nothing to search with), or a directory that would not say.
   */
  private async namesOnly(
    address: string,
    entry: LdapEntry,
    config: LdapConfig,
    directory: LdapDirectory,
  ): Promise<boolean> {
    if (config.bindType === 'simple') return false;
    try {
      const found = await directory.findEntry(buildFilter(config.searchFilter, address));
      return found !== null && normalizeDn(found.dn) === normalizeDn(entry.dn);
    } catch {
      // Two entries (findEntry refuses a second) or the directory failing:
      // either way, not proof.
      return false;
    }
  }

  /**
   * Regular and Anonymous: find the person (as the service account, or as
   * nobody), then bind as the DN found. Null when either step says no.
   */
  private async searchThenBind(
    config: LdapConfig,
    directory: LdapDirectory,
    identifier: string,
    password: string,
    log: ProviderLogger,
  ): Promise<DirectoryMatch | null> {
    const filter = buildFilter(config.searchFilter, identifier);
    const entry = await directory.findEntry(filter);

    /*
     * The two refusals below answer the caller exactly as a wrong password
     * does — the caller sees INVALID_CREDENTIALS inside the resolver's timing
     * floor either way — but they are NOT the same thing to an operator, and
     * both used to be silent. "User not found" from an AD whose mail differs
     * from its UPN looked, in the log, like nothing at all.
     *
     * Sign-in is directory-first (ADR-0031), so anything typed can reach
     * here; for an identifier no account has, `log` is the throttled logger.
     * The identifier is normalised; the password is never part of either line.
     */
    if (entry === null || entry.dn === '') {
      log.warn(
        `LDAP login refused for ${identifier}: no directory entry matched under ` +
          `${config.searchBase} (searched ${searchedAttributes(config.searchFilter)}). ` +
          'Sign in with one of those — on Active Directory the username, the UPN or the mail.',
      );
      return null;
    }

    const bound = await directory.verifyCredentials(entry.dn, password);
    if (!bound) {
      log.log(rejectedPassword(identifier, entry.dn));
      return null;
    }

    // Direct membership from the entry, plus transitive membership when the
    // directory can compute it. Resolved AFTER the bind: this is an extra
    // query, and running it for someone who failed authentication would let
    // an unauthenticated caller drive load against the directory.
    const groupDns = config.nestedGroups
      ? await this.resolveNestedGroups(entry, directory)
      : entry.groupDns;
    // The search matched THIS entry by what was typed, so the directory
    // vouches for it as one of the entry's names: it may link an account that
    // carries it (ADR-0031).
    return { entry, groupDns, vouchedIdentifier: identifier };
  }

  /**
   * Simple bind (ADR-0030 §3): no service account, so the bind identity is
   * BUILT from the pattern, the person binds as it, and their own entry is read
   * as them — groups included.
   *
   * The same answer as a wrong password for everything a stranger could
   * cause: an unusable username (refused before any network round trip, and
   * covered by the resolver's timing floor like every other refusal), a
   * rejected bind, or an entry the person may not read.
   */
  private async bindDirectly(
    config: LdapConfig,
    directory: LdapDirectory,
    identifier: string,
    password: string,
    log: ProviderLogger,
  ): Promise<DirectoryMatch | null> {
    const pattern = config.userDnPattern ?? '';

    let identity: string;
    try {
      identity = buildBindIdentity(pattern, identifier);
    } catch (error) {
      if (error instanceof InvalidUsernameError) {
        log.warn(
          `LDAP login refused for ${identifier}: the address cannot be used with the User DN ` +
            `pattern ${pattern} (${error.message}). Nothing was sent to the directory.`,
        );
        return null;
      }
      throw error;
    }

    // A DN names exactly one entry. A UPN does not: it is found by searching
    // for the ONE entry carrying exactly what was bound with — never by the
    // typed name, which on AD may be somebody else's sAMAccountName.
    const lookup = isDnPattern(pattern)
      ? { dn: identity }
      : { filter: `(userPrincipalName=${escapeFilterValue(identity)})` };

    const result = await directory.bindAndRead(identity, password, lookup, {
      nestedGroups: config.nestedGroups,
    });
    if (!result.bound) {
      // There is no search to miss in Simple bind: the identity is built, so
      // "no such person" and "wrong password" are one answer from the
      // directory, and this line says both. With {email} on AD the bind works
      // only when the address IS the person's UPN — see sign-in.md.
      log.log(rejectedPassword(identifier, identity, { simple: true }));
      return null;
    }

    if (result.entry === null || result.entry.dn === '') {
      log.warn(
        `LDAP login refused for ${identifier}: the directory accepted the password, but the ` +
          'account could not read its own entry, so its groups are unknown. Grant users read ' +
          'access to their own entry, or use Regular bind with a service account.',
      );
      return null;
    }

    /*
     * {username} DROPS THE DOMAIN, so two addresses can reach one entry:
     * alice@x.example and alice@y.example both bind as uid=alice. Typing a
     * bare `alice` is what {username} is for. But somebody who typed an
     * ADDRESS that is not the entry's own is refused rather than signed in as
     * a person they did not name — and an address the bind did not prove is
     * never used to link an account (ADR-0031). ({email} needs neither: the
     * identity bound IS the address typed.)
     */
    const typed = identifier.trim().toLowerCase();
    const usesEmail = pattern.includes(LDAP_EMAIL_PLACEHOLDER);
    const own = [result.entry.email, result.entry.upn ?? null]
      .filter((value): value is string => value !== null)
      .map((value) => value.trim().toLowerCase());
    if (!usesEmail && typed.includes('@') && own.length > 0 && !own.includes(typed)) {
      log.warn(
        `LDAP login refused for ${identifier}: the directory accepted the password for ` +
          `${result.entry.dn}, but that entry's address is ${own.join(' / ')}, not the one ` +
          'signed in with. With {username} the domain is not part of the bind, so an address ' +
          'must be the entry’s own — or sign in with the username alone.',
      );
      return null;
    }

    if (result.nestedError !== undefined) {
      this.logger.error(
        `Nested group resolution failed for ${result.entry.dn}: ${result.nestedError}. ` +
          'Falling back to direct membership only — a user whose role comes from a nested ' +
          'group will be refused or under-privileged until this is fixed.',
      );
    }

    const groupDns =
      result.nestedGroups === null
        ? result.entry.groupDns
        : [...new Set([...result.entry.groupDns, ...result.nestedGroups])];
    // What the bind proved: with {email}, the whole address; with {username},
    // an address only when it is the entry's own (checked above).
    const vouched = usesEmail || own.includes(typed) ? typed : null;
    return { entry: result.entry, groupDns, vouchedIdentifier: vouched };
  }

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

  /**
   * Direct groups plus every group that transitively contains the user.
   *
   * A failure here is NOT fatal. The direct memberships are still a valid
   * answer, and refusing a login because an optional enrichment query failed
   * would turn a slow group subtree into an outage. It is logged loudly,
   * because the visible symptom otherwise is that someone who should be an
   * administrator quietly is not.
   */
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
  if (config.protocol === 'ldap') return 'not applicable (cleartext ldap://)';
  if (!config.tlsRejectUnauthorized) return 'DISABLED';
  if (config.caPem !== undefined) return 'enforced (CA certificate saved in the console)';
  if (config.caPath === undefined) return 'enforced (system trust store)';
  return inherited
    ? `enforced (CA bundle ${config.caPath}, from this deployment)`
    : `enforced (CA bundle ${config.caPath})`;
}

/**
 * The display name of an account created at first sign-in: the directory's,
 * else the address. Trimmed to what an account may hold — a longer name in the
 * directory must not be the reason somebody cannot get in — and each later
 * sign-in's `recordLogin` keeps it current, as for every directory user.
 */
function firstSignInDisplayName(fromDirectory: string | null, email: string): string {
  const name = (fromDirectory ?? '').trim();
  return (name === '' ? email : name).slice(0, ACCOUNT_DISPLAY_NAME_MAX);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The attributes a search filter template matches the sign-in address against
 * — `(mail={{input}})` contributes `mail` — for a log line an operator can act
 * on. Falls back to the template itself when it has no such clause.
 */
export function searchedAttributes(template: string): string {
  const names = [...template.matchAll(/\(([A-Za-z][A-Za-z0-9;.-]*)=\{\{input\}\}\)/g)].map(
    (match) => match[1] ?? '',
  );
  const unique = [...new Set(names.filter((name) => name !== ''))];
  return unique.length > 0 ? unique.join(', ') : `the filter ${template}`;
}

/**
 * The directory said no to a bind as the person. Logged at LOG, not WARN: a
 * mistyped password is the most ordinary event there is. Names who was bound
 * as, never what with.
 */
function rejectedPassword(
  identifier: string,
  boundAs: string,
  { simple = false }: { simple?: boolean } = {},
): string {
  return (
    `LDAP login refused for ${identifier}: the directory rejected the password for ${boundAs} ` +
    (simple
      ? '(wrong password, the account is locked or disabled in the directory, or no account ' +
        'has that name — Simple bind cannot tell these apart).'
      : '(wrong password, or the account is locked or disabled in the directory).')
  );
}

/** The details, plus the directory's raw words when the message paraphrased them. */
function withDirectoryWords(
  details: NonNullable<ProviderVerification['details']>,
  error: unknown,
): NonNullable<ProviderVerification['details']> {
  return error instanceof LdapUnavailableError && error.detail !== undefined
    ? [...details, { label: 'Directory said', value: error.detail }]
    : details;
}

function describeProtocol(config: Pick<LdapConfig, 'protocol'>): string {
  if (config.protocol === 'ldaps') return 'LDAPS';
  if (config.protocol === 'starttls') return 'STARTTLS';
  return 'unencrypted LDAP (legacy)';
}

function describeBindType(config: Pick<LdapConfig, 'bindType'>): string {
  if (config.bindType === 'regular') return 'Regular (service account)';
  if (config.bindType === 'simple') return 'Simple (each user binds directly)';
  return 'Anonymous search';
}

function describeDetection(detection: DialectDetection): string {
  if (detection.dialect === null) {
    return 'unknown — the RootDSE could not be read, so it is treated as OpenLDAP';
  }
  const name = detection.dialect === 'ad' ? 'Active Directory' : 'OpenLDAP or compatible';
  return detection.readAs === 'service account'
    ? `${name} (detected from the RootDSE, read as the service account)`
    : `${name} (detected from the RootDSE)`;
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
  if (config.protocol === 'ldap') {
    logger.warn(
      'The LDAP connection is unencrypted (ldap:// without STARTTLS) — binds send the password ' +
        'in cleartext. Choose LDAPS or STARTTLS.',
    );
  }
  if (config.roleMappings.length === 0) {
    logger.warn(
      'No LDAP role mappings configured. Every login will be refused, because a user ' +
        'in no mapped group is not granted a default role.',
    );
  }
}
