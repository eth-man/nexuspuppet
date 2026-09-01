import { readFileSync } from 'node:fs';
import type { LdapConfig } from './config';
import { nestedGroupFilter } from './dialect';
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
   * Bind as the service account (or anonymously) and search for one entry.
   * @returns the entry, or null when the filter matched nothing.
   * @throws on transport, TLS, or protocol failure — never for "no such user".
   */
  findEntry(filter: string): Promise<LdapEntry | null>;

  /**
   * Attempt a bind as `dn` with `password`. This IS the authentication step.
   * @returns true when the directory accepted the credentials.
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
}

export interface LdapEntry {
  dn: string;
  email: string | null;
  displayName: string | null;
  groupDns: string[];
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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LdapUnavailableError';
  }
}

/**
 * Minimal structural types for `ldapts`.
 *
 * Declared locally rather than imported so this package typechecks and tests
 * without ldapts installed. It is an optional peer dependency: the adapter
 * below loads it with a dynamic import at first use, mirroring how core loads
 * this very package (ADR-0002).
 */
interface LdaptsClientLike {
  bind(dn: string, password: string): Promise<void>;
  unbind(): Promise<void>;
  search(
    base: string,
    options: { filter: string; scope: string; attributes: string[] },
  ): Promise<{
    searchEntries: Array<Record<string, unknown>>;
    /** Referral URIs the server returned. ldapts surfaces these and does not follow them. */
    searchReferences?: string[];
  }>;
}

type LdaptsConstructor = new (options: {
  url: string;
  timeout: number;
  connectTimeout: number;
  tlsOptions?: { rejectUnauthorized: boolean; ca?: string | Buffer };
}) => LdaptsClientLike;

/** Thrown by ldapts when the directory rejects credentials (LDAP result 49). */
const INVALID_CREDENTIALS_CODE = 49;

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
  ) {
    this.logger = logger;
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

  private async connect(): Promise<LdaptsClientLike> {
    let Client: LdaptsConstructor;
    try {
      const specifier = 'ldapts';
      const mod = (await import(specifier)) as unknown as { Client: LdaptsConstructor };
      Client = mod.Client;
    } catch (error) {
      // A missing client library is a deployment error, not an auth failure.
      throw new LdapUnavailableError(
        'The `ldapts` package is not installed, so LDAP authentication cannot run. ' +
          'Install it in the enterprise layer: npm install ldapts',
        { cause: error },
      );
    }

    return new Client({
      url: this.config.url,
      timeout: this.config.timeoutMs,
      connectTimeout: this.config.timeoutMs,
      // TLS options apply only to ldaps://. Supplying a CA for a cleartext
      // connection would imply a protection that is not there.
      ...(this.config.url.startsWith('ldaps://')
        ? {
            tlsOptions: {
              rejectUnauthorized: this.config.tlsRejectUnauthorized,
              ...(this.ca === undefined ? {} : { ca: this.ca }),
            },
          }
        : {}),
    });
  }

  async findEntry(filter: string): Promise<LdapEntry | null> {
    const client = await this.connect();
    try {
      if (this.config.bindDn !== undefined && this.config.bindPassword !== undefined) {
        await client.bind(this.config.bindDn, this.config.bindPassword);
      }

      const { attributes } = this.config;
      const result = await client.search(this.config.searchBase, {
        filter,
        scope: 'sub',
        attributes: [attributes.email, attributes.displayName, attributes.memberOf],
      });

      this.reportReferrals(result.searchReferences, 'user search');

      const entry = result.searchEntries[0];
      if (entry === undefined) return null;

      return {
        dn: String(entry['dn'] ?? ''),
        email: single(entry[attributes.email]),
        displayName: single(entry[attributes.displayName]),
        groupDns: multiple(entry[attributes.memberOf]),
      };
    } catch (error) {
      throw new LdapUnavailableError(`LDAP search failed: ${describe(error)}`, { cause: error });
    } finally {
      await client.unbind().catch(() => {});
    }
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
    const client = await this.connect();
    try {
      if (this.config.bindDn !== undefined && this.config.bindPassword !== undefined) {
        await client.bind(this.config.bindDn, this.config.bindPassword);
      }

      const result = await client.search(this.config.groupSearchBase, {
        filter: nestedGroupFilter(userDn, escapeFilterValue),
        scope: 'sub',
        attributes: ['distinguishedName'],
      });

      this.reportReferrals(result.searchReferences, 'nested group search');

      return result.searchEntries
        .map((entry) => String(entry['dn'] ?? entry['distinguishedName'] ?? ''))
        .filter((dn) => dn !== '');
    } catch (error) {
      throw new LdapUnavailableError(`LDAP nested group search failed: ${describe(error)}`, {
        cause: error,
      });
    } finally {
      await client.unbind().catch(() => {});
    }
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
        'will appear not to exist. Point LDAP_URL at a Global Catalog (port 3268) to search ' +
        'the whole forest from one server.',
    );
  }

  async verifyCredentials(dn: string, password: string): Promise<boolean> {
    const client = await this.connect();
    try {
      await client.bind(dn, password);
      return true;
    } catch (error) {
      if (isInvalidCredentials(error)) return false;
      throw new LdapUnavailableError(`LDAP bind failed: ${describe(error)}`, { cause: error });
    } finally {
      await client.unbind().catch(() => {});
    }
  }
}

function isInvalidCredentials(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === INVALID_CREDENTIALS_CODE;
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
