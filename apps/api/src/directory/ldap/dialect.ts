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
  attributes: { email: string; displayName: string; memberOf: string };
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
    searchFilter: '(&(objectClass=person)(mail={{input}}))',
    attributes: { email: 'mail', displayName: 'displayName', memberOf: 'memberOf' },
    identifierLabel: 'Email',
    supportsNestedGroups: false,
  },
  ad: {
    /*
     * The address a person signs in with is the EMAIL on their NexusPuppet
     * account — the resolver finds the account by it before any directory is
     * asked (ADR-0015), so a bare `jdoe` never gets here — and this filter has
     * to find their entry by that address.
     *
     * In most corporate ADs the address is the entry's `mail`, and it is NOT
     * the UPN: mail alice@example.com, UPN alice@corp.local, because the email
     * domain is not the AD domain. Matching only sAMAccountName and
     * userPrincipalName found nobody for such a person and refused them like a
     * wrong password (reproduced against Windows Server 2025). So:
     *
     * - `mail`, the usual case;
     * - `userPrincipalName`, where the account was created with the UPN, or
     *   the UPN is the email;
     * - `sAMAccountName`, harmless, and kept because a stored or environment
     *   filter may rely on the same shape.
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
    attributes: { email: 'mail', displayName: 'displayName', memberOf: 'memberOf' },
    // 'Email', not 'Username': accounts are found by the address typed, so
    // inviting `jdoe` produced a refusal that read as a wrong password.
    identifierLabel: 'Email',
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
