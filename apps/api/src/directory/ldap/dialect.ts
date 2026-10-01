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

const DEFAULTS: Record<LdapDialect, DialectDefaults> = {
  openldap: {
    searchFilter: '(&(objectClass=person)(mail={{input}}))',
    attributes: { email: 'mail', displayName: 'displayName', memberOf: 'memberOf' },
    identifierLabel: 'Email',
    supportsNestedGroups: false,
  },
  ad: {
    /*
     * Accepts either form a person might type. AD users are told their
     * "username" (sAMAccountName, `jdoe`) by IT, but the UPN
     * (`jdoe@corp.example.com`) looks like an email and is what many will try
     * first. Refusing one of them produces a login screen that works for some
     * colleagues and not others.
     *
     * objectCategory=person alongside objectClass=user excludes computer
     * accounts, which are also objectClass=user in AD — without it, a machine
     * account could match and be bound against.
     */
    searchFilter:
      '(&(objectClass=user)(objectCategory=person)(|(sAMAccountName={{input}})(userPrincipalName={{input}})))',
    attributes: { email: 'mail', displayName: 'displayName', memberOf: 'memberOf' },
    identifierLabel: 'Username',
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
