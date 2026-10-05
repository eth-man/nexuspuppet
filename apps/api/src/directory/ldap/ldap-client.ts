import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import { Client, type ClientOptions, type SearchOptions, type SearchResult } from 'ldapts';
import type { LdapConfig } from './config';
import { dialectFromRootDse, nestedGroupFilter, type LdapDialect } from './dialect';
import { escapeFilterValue } from './filter';

/**
 * The directory operations this package actually needs.
 *
 * Narrow on purpose. The provider depends on this port rather than on `ldapts`
 * directly, which means the authentication logic — the part where a mistake is
 * an auth bypass — is unit-testable against a fake, with no directory server
 * and no network. Swapping the client library later touches one file.
 */
export interface LdapDirectory {
  /**
   * Bind as the service account (Regular) or not at all (Anonymous) and
   * search for one entry.
   * @returns the entry, or null when the filter matched nothing.
   * @throws on transport, TLS, or protocol failure — never for "no such user".
   */
  findEntry(filter: string): Promise<LdapEntry | null>;

  /**
   * Attempt a bind as `dn` with `password`. This IS the authentication step.
   * @returns true when the directory accepted the credentials; false for an
   *          EMPTY password without contacting the directory at all.
   * @throws on transport failure, so an unreachable directory is never
   *         mistaken for a wrong password.
   */
  verifyCredentials(dn: string, password: string): Promise<boolean>;

  /**
   * Every group that transitively contains `userDn` (Active Directory).
   *
   * Separate from the entry's own `memberOf`, which is one hop only.
   * @returns group DNs, or an empty array when the directory reports none.
   */
  findGroupsContaining(userDn: string): Promise<string[]>;

  /**
   * Simple bind (ADR-0030 §3): bind AS the person, then read their own entry
   * — and, when asked, their nested groups — on that same connection, as them.
   *
   * @returns `bound: false` for rejected credentials, or an empty password
   *          (never sent); otherwise the entry, which is null when the person
   *          may not read it.
   * @throws on transport failure, as `verifyCredentials` does.
   */
  bindAndRead(
    identity: string,
    password: string,
    lookup: OwnEntryLookup,
    options: { nestedGroups: boolean },
  ): Promise<DirectBindResult>;

  /**
   * Read the RootDSE and say what kind of directory answered (ADR-0030 §4):
   * anonymously first, then — for a Regular bind — as the service account.
   * @throws on transport or TLS failure, or a rejected service account.
   */
  detectDialect(): Promise<DialectDetection>;
}

export interface LdapEntry {
  dn: string;
  email: string | null;
  displayName: string | null;
  groupDns: string[];
}

/** How a Simple bind finds the entry it just bound as. */
export type OwnEntryLookup =
  /** The bind identity IS the DN: read that one entry. */
  | { dn: string }
  /** The identity is a UPN: search for the one entry that carries it. */
  | { filter: string };

export type DirectBindResult =
  | { bound: false }
  | {
      bound: true;
      entry: LdapEntry | null;
      /** Null when not asked for, or when the query failed (`nestedError`). */
      nestedGroups: string[] | null;
      nestedError?: string;
    };

export interface DialectDetection {
  /** Null when the RootDSE told us nothing either way. */
  dialect: LdapDialect | null;
  /** Who read it. Null when nobody could. */
  readAs: 'anonymous' | 'service account' | null;
}

/**
 * A referral the directory returned instead of an answer.
 *
 * NOT followed — see LdaptsDirectory. Surfaced so an operator can tell the
 * difference between "no such user" and "the answer lives on a server we
 * declined to ask".
 */
export interface ReferralNotice {
  uris: string[];
}

/** Distinguishes "the directory said no" from "the directory did not answer". */
export class LdapUnavailableError extends Error {
  /**
   * The directory's own words, when `message` is a plain explanation of them.
   * Shown as a secondary line, so the paraphrase hides nothing.
   */
  readonly detail: string | undefined;

  constructor(message: string, options?: { cause?: unknown; detail?: string }) {
    super(message, options);
    this.name = 'LdapUnavailableError';
    this.detail = options?.detail;
  }
}

/** What an operator is told when the directory will not be searched anonymously. */
export const ANONYMOUS_REFUSED =
  'This directory does not allow anonymous searches. Use Regular with a service account ' +
  '(User DN and Password).';

/**
 * Whether a failed ANONYMOUS operation was the directory refusing anonymous
 * access, as opposed to anything else going wrong.
 *
 * Each directory says it differently, and none says it plainly:
 *
 * - Active Directory: operationsError (1) with `000004DC … a successful bind
 *   must be completed on the connection`.
 * - OpenLDAP with `olcRequires: authc`: unwillingToPerform (53),
 *   `authentication required`.
 * - Others: insufficientAccessRights (50), inappropriateAuthentication (48),
 *   or text naming anonymous access as disallowed.
 */
export function isAnonymousRefusal(error: unknown): boolean {
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === 1 && /000004DC|successful bind must be completed/i.test(message)) return true;
  if (code === 53 && /authentication required/i.test(message)) return true;
  if (code === 50 || code === 48) return true;
  return /anonymous[^.]*(disallowed|not allowed|denied)/i.test(message);
}

/** The part of `ldapts`' Client this package uses. A seam for tests. */
export interface LdapClientLike {
  startTLS(options?: ConnectionOptions): Promise<void>;
  bind(dn: string, password?: string): Promise<void>;
  search(base: string, options?: SearchOptions): Promise<SearchResult>;
  unbind(): Promise<void>;
}

export type LdapClientFactory = (options: ClientOptions) => LdapClientLike;

/** Thrown by ldapts when the directory rejects credentials (LDAP result 49). */
const INVALID_CREDENTIALS_CODE = 49;
/** noSuchObject: the entry is not there, or the reader may not know it is. */
const NO_SUCH_OBJECT_CODE = 32;
/** sizeLimitExceeded: more entries matched than were asked for. */
const SIZE_LIMIT_EXCEEDED_CODE = 4;

/** What a RootDSE read asks for. Every LDAPv3 server publishes some of these. */
const ROOT_DSE_ATTRIBUTES = [
  'supportedCapabilities',
  'supportedLDAPVersion',
  'namingContexts',
  'defaultNamingContext',
  'vendorName',
  'vendorVersion',
];

export class LdaptsDirectory implements LdapDirectory {
  private readonly logger: { warn(message: string): void };

  /**
   * The CA bundle, read once at construction.
   *
   * Read here rather than per connection so an unreadable file is a BOOT
   * failure — the loader turns it into a refusal to start — instead of a TLS
   * error on somebody's first login. The cost is that rotating the CA needs a
   * restart, which is the right trade for a file that changes once a year.
   */
  private readonly ca: Buffer | undefined;

  constructor(
    private readonly config: LdapConfig,
    logger: { warn(message: string): void } = console,
    /** Injected by tests to record the order of operations. */
    private readonly clientFor: LdapClientFactory = (options) => new Client(options),
  ) {
    this.logger = logger;
    // PEM pasted in the console wins over a mounted file (ADR-0029 §5). It is
    // already in memory and was parsed when the configuration was, so there is
    // nothing here to fail.
    if (config.caPem !== undefined) {
      this.ca = Buffer.from(config.caPem, 'utf8');
      return;
    }
    if (config.caPath === undefined) {
      this.ca = undefined;
      return;
    }
    try {
      this.ca = readFileSync(config.caPath);
    } catch (error) {
      throw new LdapUnavailableError(
        `Could not read the LDAP CA bundle at ${config.caPath}: ${describe(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * TLS options for LDAPS and STARTTLS alike.
   *
   * `host` is what the certificate is verified against — for STARTTLS too,
   * where Node would otherwise check the certificate against "localhost",
   * because the socket it upgrades carries no name. `servername` is SNI, and
   * an IP literal must never be sent as one (RFC 6066 §3).
   *
   * A fresh object every time: `ldapts` writes the socket into the options it
   * is given when it upgrades.
   */
  private tlsOptions(): ConnectionOptions {
    const { host } = this.config;
    return {
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
      ...(this.ca === undefined ? {} : { ca: this.ca }),
      host,
      ...(isIP(host) === 0 ? { servername: host } : {}),
    };
  }

  /**
   * A fresh client per operation, encrypted BEFORE it is handed back.
   *
   * - **LDAPS**: TLS from the first byte.
   * - **STARTTLS** (ADR-0030 §2): connect, then upgrade, then return. Every
   *   bind — service account, anonymous search or user — happens after this
   *   returns, so none can precede the upgrade. Two things make it fail
   *   CLOSED rather than fall back:
   *   1. a refused or failed upgrade throws, and the caller never binds;
   *   2. the client may open exactly ONE socket. `ldapts` transparently
   *      reconnects a dropped connection, and its reconnect is plain TCP: a
   *      bind after a lost STARTTLS session would otherwise go out in clear
   *      text on a new socket. A second connection attempt throws instead.
   * - **ldap** (legacy, unencrypted): exactly as before ADR-0030.
   *
   * A plain import: `ldapts` is an ordinary dependency of the API. It used to
   * be an optional peer loaded with a dynamic import, so a missing package
   * surfaced as a failed login rather than a failed build (ADR-0027).
   */
  private async open(): Promise<LdapClientLike> {
    const base: ClientOptions = {
      url: this.config.url,
      timeout: this.config.timeoutMs,
      connectTimeout: this.config.timeoutMs,
    };

    if (this.config.protocol === 'ldaps') {
      return this.clientFor({ ...base, tlsOptions: this.tlsOptions() });
    }
    if (this.config.protocol === 'ldap') {
      // Unencrypted, by an operator's choice made before ADR-0030. Supplying
      // TLS options here would imply a protection that is not there.
      return this.clientFor(base);
    }

    let connections = 0;
    const onlyOnce = ((port: number, host: string) => {
      connections += 1;
      if (connections > 1) {
        throw new LdapUnavailableError(
          'The STARTTLS connection was lost, and reconnecting would not be encrypted. ' +
            'Refused; nothing was sent.',
        );
      }
      return netConnect(port, host);
    }) as unknown as typeof netConnect;

    const client = this.clientFor({ ...base, createConnection: onlyOnce });
    try {
      await withTimeout(client.startTLS(this.tlsOptions()), this.config.timeoutMs);
    } catch (error) {
      // Closed without another operation: nothing more is said on a
      // connection that never became encrypted.
      await client.unbind().catch(() => {});
      throw new LdapUnavailableError(explainStartTlsFailure(error, this.config), {
        cause: error,
      });
    }
    return client;
  }

  /** Open, run, and always close — translating failures for the operator. */
  private async session<T>(
    failure: string,
    run: (client: LdapClientLike) => Promise<T>,
  ): Promise<T> {
    let client: LdapClientLike | null = null;
    try {
      client = await this.open();
      return await run(client);
    } catch (error) {
      if (error instanceof LdapUnavailableError) throw error;
      const raw = `${failure}: ${describe(error)}`;
      if (this.config.bindType === 'anonymous' && isAnonymousRefusal(error)) {
        throw new LdapUnavailableError(ANONYMOUS_REFUSED, { cause: error, detail: raw });
      }
      // OpenLDAP's default ACLs HIDE what an anonymous reader may not see, so
      // the refusal arrives as "no such object" — indistinguishable from a
      // mistyped search base, and so both are named.
      if (this.config.bindType === 'anonymous' && codeOf(error) === NO_SUCH_OBJECT_CODE) {
        throw new LdapUnavailableError(
          `The search base was not found — or this directory hides it from anonymous readers. ` +
            'Check Search base, or use Regular with a service account (User DN and Password).',
          { cause: error, detail: raw },
        );
      }
      throw new LdapUnavailableError(`${failure}: ${explainError(error, this.config)}`, {
        cause: error,
      });
    } finally {
      await client?.unbind().catch(() => {});
    }
  }

  /**
   * The service account's bind, for Regular. Nothing for Anonymous — and
   * nothing for Simple, which has no service account to bind as.
   */
  private async bindServiceAccount(client: LdapClientLike): Promise<void> {
    if (this.config.bindType !== 'regular') return;
    const { bindDn, bindPassword } = this.config;
    // The schema requires both for Regular. Checked again because an empty
    // password here would be an unauthenticated bind that many servers accept.
    if (bindDn === undefined || bindPassword === undefined || bindPassword === '') {
      throw new LdapUnavailableError('Regular bind is configured without a User DN and password.');
    }
    try {
      await client.bind(bindDn, bindPassword);
    } catch (error) {
      if (isInvalidCredentials(error)) {
        throw new LdapUnavailableError(
          `The directory refused the User DN and password (${bindDn}): ${describe(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private toEntry(entry: Record<string, unknown>): LdapEntry {
    const { attributes } = this.config;
    return {
      dn: String(entry['dn'] ?? ''),
      email: single(entry[attributes.email]),
      displayName: single(entry[attributes.displayName]),
      groupDns: multiple(entry[attributes.memberOf]),
    };
  }

  private get entryAttributes(): string[] {
    const { attributes } = this.config;
    return [attributes.email, attributes.displayName, attributes.memberOf];
  }

  async findEntry(filter: string): Promise<LdapEntry | null> {
    return this.session('LDAP search failed', async (client) => {
      await this.bindServiceAccount(client);

      const result = await client.search(this.config.searchBase, {
        filter,
        scope: 'sub',
        attributes: this.entryAttributes,
      });

      this.reportReferrals(result.searchReferences, 'user search');

      const entry = result.searchEntries[0];
      return entry === undefined ? null : this.toEntry(entry);
    });
  }

  /**
   * Groups that transitively contain the user, via LDAP_MATCHING_RULE_IN_CHAIN.
   *
   * One query: Active Directory walks the membership chain server-side, so
   * asking once per configured mapping would be N round trips for the same
   * answer.
   *
   * Only DNs are requested. The group objects themselves may carry attributes
   * this application has no business reading, and asking for less is the
   * cheaper query besides.
   */
  async findGroupsContaining(userDn: string): Promise<string[]> {
    return this.session('LDAP nested group search failed', async (client) => {
      await this.bindServiceAccount(client);
      return this.searchGroupsContaining(client, userDn);
    });
  }

  private async searchGroupsContaining(client: LdapClientLike, userDn: string): Promise<string[]> {
    const result = await client.search(this.config.groupSearchBase, {
      filter: nestedGroupFilter(userDn, escapeFilterValue),
      scope: 'sub',
      attributes: ['distinguishedName'],
    });

    this.reportReferrals(result.searchReferences, 'nested group search');

    return result.searchEntries
      .map((entry) => String(entry['dn'] ?? entry['distinguishedName'] ?? ''))
      .filter((dn) => dn !== '');
  }

  /**
   * Referrals are NOT followed. Deliberately, and this is the security answer
   * to LDAP_OPT_REFERRALS.
   *
   * Chasing a referral means opening a connection to a host the referred-to
   * server names, and re-binding there — with the service account's
   * credentials, or the user's password, depending on the operation. The
   * referral target is chosen by the directory, not by configuration, so
   * following one hands credentials to whatever host a compromised or
   * misconfigured DC nominates. `ldapts` does not chase them; this makes that
   * choice explicit rather than incidental.
   *
   * They are LOGGED because ignoring them silently is its own failure: a user
   * who lives in another domain of the forest then looks simply absent, and the
   * operator has nothing to go on.
   */
  private reportReferrals(references: string[] | undefined, during: string): void {
    if (references === undefined || references.length === 0) return;
    this.logger.warn(
      `LDAP ${during} returned ${references.length} referral(s), which were NOT followed: ` +
        `${references.join(', ')}. Results may be incomplete — a user in a referred domain ` +
        'will appear not to exist. Point the console at a Global Catalog (port 3269 for ' +
        'LDAPS, 3268 for STARTTLS) to search the whole forest from one server.',
    );
  }

  async verifyCredentials(dn: string, password: string): Promise<boolean> {
    // An EMPTY password is an unauthenticated bind (RFC 4513 §5.1.2), which
    // many servers answer with success. The provider refuses it first; this
    // refuses it again, here at the wire, so no future caller can forget.
    if (password === '') return false;

    return this.session('LDAP bind failed', async (client) => {
      try {
        await client.bind(dn, password);
        return true;
      } catch (error) {
        if (isInvalidCredentials(error)) return false;
        throw error;
      }
    });
  }

  async bindAndRead(
    identity: string,
    password: string,
    lookup: OwnEntryLookup,
    options: { nestedGroups: boolean },
  ): Promise<DirectBindResult> {
    // See verifyCredentials: never sent, whatever the caller did first.
    if (password === '') return { bound: false };

    return this.session('LDAP bind failed', async (client) => {
      try {
        await client.bind(identity, password);
      } catch (error) {
        if (isInvalidCredentials(error)) return { bound: false } as const;
        throw error;
      }

      const entry = await this.readOwnEntry(client, lookup);
      if (entry === null || !options.nestedGroups) {
        return { bound: true, entry, nestedGroups: null } as const;
      }

      try {
        const nestedGroups = await this.searchGroupsContaining(client, entry.dn);
        return { bound: true, entry, nestedGroups } as const;
      } catch (error) {
        return {
          bound: true,
          entry,
          nestedGroups: null,
          nestedError: explainError(error, this.config),
        } as const;
      }
    });
  }

  /**
   * The entry just bound as, read as that person.
   *
   * By DN, a base read of exactly that entry. By UPN, a search for the one
   * entry carrying it — and MORE THAN ONE is refused: if two entries matched,
   * picking either would hand somebody another account's groups.
   */
  private async readOwnEntry(
    client: LdapClientLike,
    lookup: OwnEntryLookup,
  ): Promise<LdapEntry | null> {
    try {
      const result =
        'dn' in lookup
          ? await client.search(lookup.dn, {
              filter: '(objectClass=*)',
              scope: 'base',
              attributes: this.entryAttributes,
            })
          : await client.search(this.config.searchBase, {
              filter: lookup.filter,
              scope: 'sub',
              sizeLimit: 2,
              attributes: this.entryAttributes,
            });

      this.reportReferrals(result.searchReferences, 'own-entry read');

      if (result.searchEntries.length > 1) {
        throw new LdapUnavailableError(
          'More than one directory entry carries this sign-in name; refusing to guess which.',
        );
      }
      const entry = result.searchEntries[0];
      return entry === undefined ? null : this.toEntry(entry);
    } catch (error) {
      if (codeOf(error) === NO_SUCH_OBJECT_CODE) return null;
      if (codeOf(error) === SIZE_LIMIT_EXCEEDED_CODE) {
        throw new LdapUnavailableError(
          'More than one directory entry carries this sign-in name; refusing to guess which.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async detectDialect(): Promise<DialectDetection> {
    return this.session('LDAP RootDSE read failed', async (client) => {
      const anonymous = await this.readRootDse(client);
      if (anonymous !== null) return { dialect: anonymous, readAs: 'anonymous' };

      // Some servers hide the RootDSE from anonymous readers. A service
      // account may see it; nobody else configured here can.
      if (this.config.bindType === 'regular') {
        await this.bindServiceAccount(client);
        const bound = await this.readRootDse(client);
        if (bound !== null) return { dialect: bound, readAs: 'service account' };
      }
      return { dialect: null, readAs: null };
    });
  }

  /** The RootDSE's dialect, or null when it was refused or said nothing. */
  private async readRootDse(client: LdapClientLike): Promise<LdapDialect | null> {
    let result: SearchResult;
    try {
      result = await client.search('', {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ROOT_DSE_ATTRIBUTES,
      });
    } catch (error) {
      // An LDAP RESULT — insufficientAccess, noSuchObject — is the server
      // declining to say. Anything else is the transport failing.
      if (typeof codeOf(error) === 'number') return null;
      throw error;
    }

    const entry = result.searchEntries[0];
    if (entry === undefined) return null;

    const attributes: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(entry)) {
      if (name !== 'dn') attributes[name] = multiple(value);
    }
    return dialectFromRootDse(attributes);
  }
}

/** Race a promise against the clock, without leaving the loser unhandled. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no TLS handshake within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function isInvalidCredentials(error: unknown): boolean {
  return codeOf(error) === INVALID_CREDENTIALS_CODE;
}

/** Node's names for a certificate the client would not trust. */
const UNTRUSTED_CERTIFICATE = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
]);

/**
 * Say what went wrong in the terms an operator acts on: the certificate, the
 * name, the port, the protocol. The library's own words are kept at the end,
 * so nothing is hidden behind the paraphrase.
 */
export function explainError(
  error: unknown,
  config: Pick<LdapConfig, 'host' | 'port' | 'protocol' | 'timeoutMs'>,
): string {
  const code = codeOf(error);
  const where = `${config.host}:${config.port}`;
  const raw = describe(error);

  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return (
      `The server's certificate is not valid for the name "${config.host}". Use the server's ` +
      `name exactly as it appears on its certificate. (${raw})`
    );
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return `The server's certificate has expired. (${raw})`;
  }
  if (typeof code === 'string' && UNTRUSTED_CERTIFICATE.has(code)) {
    return (
      'The server’s certificate is not trusted: the CA that signed it is not one this ' +
      `console trusts. Paste that CA under CA certificate (PEM). (${raw})`
    );
  }
  if (code === 'ECONNREFUSED') {
    return `Nothing is accepting connections on ${where}. Check the server name and port. (${raw})`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `The server name "${config.host}" does not resolve. (${raw})`;
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(raw)) {
    return `No answer from ${where} within ${config.timeoutMs}ms. (${raw})`;
  }
  if (
    config.protocol === 'ldaps' &&
    (code === 'ECONNRESET' || code === 'EPROTO' || /wrong version number|packet length/i.test(raw))
  ) {
    return (
      `The TLS handshake with ${where} failed. If this server expects STARTTLS on this port ` +
      `rather than LDAPS, choose STARTTLS. (${raw})`
    );
  }
  return raw;
}

/**
 * Why STARTTLS failed. Every message ends the same way, because it is the
 * thing an operator worries about: nothing was sent in clear text.
 */
function explainStartTlsFailure(error: unknown, config: LdapConfig): string {
  const safe = 'No credentials were sent.';
  if (typeof codeOf(error) === 'number') {
    return (
      `The server refused STARTTLS: ${describe(error)}. It may have no certificate configured ` +
      `for STARTTLS, or expect LDAPS on port 636. ${safe}`
    );
  }
  return `STARTTLS failed: ${explainError(error, config)} ${safe}`;
}

function single(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function multiple(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Never includes the password: `error.message` from a bind can echo the DN, never the secret. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
