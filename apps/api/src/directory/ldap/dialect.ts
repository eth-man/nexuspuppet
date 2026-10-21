/**
 * Directory dialects.
 *
 * Active Directory and OpenLDAP speak the same protocol and disagree about
 * almost everything above it: what a user object is called, which attribute
 * holds the login name, and how group membership is expressed. Encoding that as
 * a dialect keeps the differences in one readable place instead of scattered
 * conditionals in the authentication path.
 *
 * A dialect only supplies DEFAULTS. Every value it sets can be overridden
 * explicitly, because real directories are customised and a dialect that
 * cannot be overridden is a dialect that eventually blocks someone.
 */

export type LdapDialect = 'openldap' | 'ad';

export interface DialectDefaults {
  searchFilter: string;
  attributes: {
    email: string;
    displayName: string;
    memberOf: string;
    /** The UPN, where the directory has one — an address an account may carry. */
    upn: string | null;
    /** The sign-in name: sAMAccountName, uid. */
    username: string;
    /** The entry's stable id (ADR-0031): objectGUID, entryUUID. */
    directoryId: string;
  };
  /** Whether `directoryId` arrives as raw bytes (AD's objectGUID) rather than text. */
  directoryIdIsBinary: boolean;
  /** What the login form should call the identifier. */
  identifierLabel: string;
  /** Whether transitive group membership can be resolved at all. */
  supportsNestedGroups: boolean;
}

/**
 * Active Directory's transitive-membership matching rule,
 * LDAP_MATCHING_RULE_IN_CHAIN.
 *
 * Applied to an attribute in a filter, it walks the membership graph rather
 * than reading one hop. AD-specific: OpenLDAP does not implement it and
 * answers a filter using it with an error, which is why it is gated on the
 * dialect rather than merely offered.
 */
export const AD_MATCHING_RULE_IN_CHAIN = '1.2.840.113556.1.4.1941';

/**
 * LDAP_CAP_ACTIVE_DIRECTORY_OID: what an Active Directory domain controller
 * (and Samba AD, which implements the same protocol surface) lists in its
 * RootDSE's `supportedCapabilities`. Its presence is how the directory type is
 * DETECTED rather than chosen (ADR-0030 §4). AD LDS advertises a different
 * OID and is deliberately not matched: it has no sAMAccountName to search.
 */
export const AD_CAPABILITY_OID = '1.2.840.113556.1.4.800';

/**
 * The directory type a RootDSE describes, or null when it describes nothing.
 *
 * `supportedCapabilities` carrying the AD OID means AD. A RootDSE that was
 * readable — it answered with any of the attributes every LDAPv3 server
 * publishes — but did not carry it means an OpenLDAP-compatible server. An
 * empty answer is not evidence of anything: a server that hides its RootDSE
 * from an anonymous reader returns exactly that.
 */
export function dialectFromRootDse(attributes: Record<string, string[]>): LdapDialect | null {
  const capabilities = attributes['supportedCapabilities'] ?? [];
  if (capabilities.includes(AD_CAPABILITY_OID)) return 'ad';

  const answered = Object.values(attributes).some((values) => values.length > 0);
  return answered ? 'openldap' : null;
}

/**
 * OpenLDAP's default user search: by `uid` (the username) or `mail`
 * (ADR-0031). People sign in with what they type everywhere else, which on
 * most OpenLDAP estates is their uid.
 */
export const OPENLDAP_SEARCH_FILTER = '(&(objectClass=person)(|(uid={{input}})(mail={{input}})))';

/**
 * The OpenLDAP default up to v1.13.1, which matched `mail` only.
 *
 * Read as "the default" wherever it appears, for the same reason as
 * AD_SEARCH_FILTER_WITHOUT_MAIL: a saved row carrying exactly this string got
 * it from a form opened on the environment baseline, not from a choice.
 */
export const OPENLDAP_SEARCH_FILTER_MAIL_ONLY = '(&(objectClass=person)(mail={{input}}))';

/** Active Directory's default user search: by sAMAccountName, UPN or mail. */
export const AD_SEARCH_FILTER =
  '(&(objectClass=user)(objectCategory=person)(|(sAMAccountName={{input}})(userPrincipalName={{input}})(mail={{input}})))';

/**
 * The AD default up to v1.13.0, which did not match `mail`.
 *
 * Read as "the default" wherever it appears (see `prepare` in config.ts). The
 * console has no search-filter field, so a saved row carrying exactly this
 * string got it from a form opened on the environment baseline, which used to
 * report the resolved default as though somebody had chosen it. Left in place,
 * it would keep the defect on exactly the deployments that adopted their
 * environment configuration into the console.
 */
export const AD_SEARCH_FILTER_WITHOUT_MAIL =
  '(&(objectClass=user)(objectCategory=person)(|(sAMAccountName={{input}})(userPrincipalName={{input}})))';

const DEFAULTS: Record<LdapDialect, DialectDefaults> = {
  openldap: {
    searchFilter: OPENLDAP_SEARCH_FILTER,
    attributes: {
      email: 'mail',
      displayName: 'displayName',
      memberOf: 'memberOf',
      upn: null,
      username: 'uid',
      // Operational, so it is returned only when asked for by name — it is.
      directoryId: 'entryUUID',
    },
    directoryIdIsBinary: false,
    identifierLabel: 'Username or email',
    supportsNestedGroups: false,
  },
  ad: {
    /*
     * People sign in with whatever AD knows them by (ADR-0031): their
     * username, their UPN, or their email. The directory is asked FIRST, and
     * the account is whichever is linked to the entry it finds — so this
     * filter has to find an entry by any of the three:
     *
     * - `sAMAccountName`, `jdoe` — what people type into every other AD-backed
     *   login, and the only one that works where `mail` is empty (no
     *   Exchange) and the UPN suffix is `.local`;
     * - `userPrincipalName`, `jdoe@corp.local`;
     * - `mail`, `jdoe@example.com` — in most corporate ADs NOT the UPN, because
     *   the email domain is not the AD domain (reproduced against Windows
     *   Server 2025).
     *
     * An address that is one entry's mail and another's UPN matches both, and
     * is refused rather than guessed: the search asks for at most two entries
     * and refuses a second (LdaptsDirectory.findEntry).
     *
     * objectCategory=person alongside objectClass=user excludes computer
     * accounts, which are also objectClass=user in AD — without it, a machine
     * account could match and be bound against.
     */
    searchFilter: AD_SEARCH_FILTER,
    attributes: {
      email: 'mail',
      displayName: 'displayName',
      memberOf: 'memberOf',
      upn: 'userPrincipalName',
      username: 'sAMAccountName',
      // 16 raw bytes, little-endian in its first three fields — directory-id.ts.
      directoryId: 'objectGUID',
    },
    directoryIdIsBinary: true,
    // The directory is asked first, so `jdoe` now finds the person (ADR-0031).
    identifierLabel: 'Username or email',
    supportsNestedGroups: true,
  },
};

export function dialectDefaults(dialect: LdapDialect): DialectDefaults {
  return DEFAULTS[dialect];
}

/**
 * A filter matching every group that transitively contains the given user.
 *
 * One query rather than one per configured mapping: AD evaluates the chain
 * server-side, so the whole answer comes back at once. The DN is escaped per
 * RFC 4515 — it is attacker-influenceable in the sense that it comes from a
 * directory entry, and an unescaped parenthesis would change the filter's
 * meaning.
 */
export function nestedGroupFilter(userDn: string, escape: (value: string) => string): string {
  return `(member:${AD_MATCHING_RULE_IN_CHAIN}:=${escape(userDn)})`;
}
