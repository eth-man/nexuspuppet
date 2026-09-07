import { existsSync } from 'node:fs';
import { z } from 'zod';
import { dialectDefaults } from './dialect';

/**
 * LDAP configuration, validated at boot.
 *
 * Deliberately strict: a directory misconfiguration must fail at startup with a
 * readable message, not at 3am when the first person tries to log in. The
 * enterprise loader treats a throw from register() as fatal, which is exactly
 * the behaviour wanted here — a deployment that paid for SSO must never
 * silently fall back to local authentication.
 */
const baseLdapConfigSchema = z.object({
  /** ldaps://directory.example.com:636 — see `tlsRejectUnauthorized` below. */
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('ldap://') || u.startsWith('ldaps://'), {
      message: 'LDAP_URL must use the ldap:// or ldaps:// scheme',
    }),

  /**
   * Service account used to SEARCH for the user's DN. Not used to authenticate
   * them — that is a second bind as the user themselves.
   *
   * Optional: some directories permit anonymous search.
   */
  bindDn: z.string().min(1).optional(),
  bindPassword: z.string().min(1).optional(),

  /**
   * Which directory this is. Supplies defaults for the search filter, the
   * identifier label, and whether nested groups can be resolved at all.
   */
  dialect: z.enum(['openldap', 'ad']).default('openldap'),

  searchBase: z.string().min(1),

  /**
   * Where to look for groups when resolving NESTED membership (AD only).
   *
   * Separate from searchBase because groups usually live outside the people
   * OU, and searching for groups under the people subtree finds nothing —
   * which looks exactly like "this user has no groups" and refuses every
   * login. Defaults to searchBase only when not set explicitly.
   */
  groupSearchBase: z.string().min(1).optional(),

  /**
   * Resolve group membership transitively (AD only, LDAP_MATCHING_RULE_IN_CHAIN).
   *
   * Off by default even on AD: it is an extra query per login against the
   * whole group subtree, and many estates map the groups people are directly
   * in. Turn it on when roles are granted through nested groups — without it
   * a member of a group that is itself a member of a mapped group is refused,
   * which is a confusing thing to debug from the outside.
   */
  nestedGroups: z.boolean().default(false),

  /**
   * Must contain {{input}}. See buildFilter — a template without it would match
   * every entry, and the first hit would be bound against.
   */
  searchFilter: z.string().min(1).optional(),

  attributes: z
    .object({
      email: z.string().min(1).optional(),
      displayName: z.string().min(1).optional(),
      memberOf: z.string().min(1).optional(),
    })
    .default({}),

  /**
   * Group DN -> role. Highest role wins when a user is in several groups.
   * A user in no mapped group is REFUSED rather than defaulted: granting a role
   * to anyone the directory happens to contain is how a contractor ends up with
   * estate-wide read access.
   */
  roleMappings: z
    .array(
      z.object({
        groupDn: z.string().min(1),
        /**
         * A role NAME, not the built-in enum (ADR-0018 §5). A deployment may
         * define its own, and a mapping naming one that does not exist resolves
         * to no permissions rather than to a default — the console shows it as
         * a broken mapping.
         */
        role: z.string().min(1),
      }),
    )
    .default([]),

  /**
   * Path to a PEM CA bundle that signs the directory's certificate.
   *
   * On-prem directories are almost always signed by an internal CA that is not
   * in the system trust store. Without this, the only way to reach such a
   * server over ldaps:// is to disable verification entirely — which turns
   * every password submitted to this console into something the network can
   * read. This exists so that is never the answer.
   *
   * A path to a MOUNTED FILE, never inline PEM: the same rule the PuppetDB
   * client follows in core. Certificate material in an environment variable
   * ends up in `docker inspect`, process listings, and crash reports.
   */
  caPath: z.string().min(1).optional(),

  timeoutMs: z.number().int().positive().max(60_000).default(10_000),

  /**
   * Defaults to true. Setting it false disables certificate verification and
   * makes the connection trivially interceptable — every password typed into
   * the console goes to whoever holds the network path. It exists only for
   * bootstrapping against a directory with an internal CA that has not been
   * distributed yet, and the provider logs a warning on every startup.
   */
  tlsRejectUnauthorized: z.boolean().default(true),
});

/**
 * Fill anything the operator left unset from the dialect's defaults.
 *
 * Done here rather than at each use so the rest of the package sees one
 * concrete shape: no `?? 'mail'` scattered through the authentication path,
 * where a missed fallback would silently read the wrong attribute and refuse
 * every login.
 */
export const ldapConfigSchema = baseLdapConfigSchema.transform((input) => {
  const defaults = dialectDefaults(input.dialect);
  return {
    ...input,
    searchFilter: input.searchFilter ?? defaults.searchFilter,
    identifierLabel: defaults.identifierLabel,
    supportsNestedGroups: defaults.supportsNestedGroups,
    groupSearchBase: input.groupSearchBase ?? input.searchBase,
    attributes: {
      email: input.attributes.email ?? defaults.attributes.email,
      displayName: input.attributes.displayName ?? defaults.attributes.displayName,
      memberOf: input.attributes.memberOf ?? defaults.attributes.memberOf,
    },
  };
});

export type LdapConfig = z.infer<typeof ldapConfigSchema>;

/**
 * Read configuration from the environment.
 *
 * Role mappings arrive as `DN=ROLE` pairs separated by `;` because on-prem
 * operators configure this through docker-compose environment variables, where
 * JSON is painful to quote correctly:
 *
 *   LDAP_ROLE_MAPPINGS="cn=puppet-admins,ou=groups,dc=x=ADMIN;cn=ops,ou=groups,dc=x=OPERATOR"
 *
 * The DN itself contains `=`, so the split is on the LAST `=` in each pair.
 */
export function ldapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LdapConfig {
  const raw = {
    url: env['LDAP_URL'],
    ...(env['LDAP_BIND_DN'] === undefined ? {} : { bindDn: env['LDAP_BIND_DN'] }),
    ...(env['LDAP_BIND_PASSWORD'] === undefined
      ? {}
      : { bindPassword: env['LDAP_BIND_PASSWORD'] }),
    searchBase: env['LDAP_SEARCH_BASE'],
    ...(env['LDAP_SEARCH_FILTER'] === undefined
      ? {}
      : { searchFilter: env['LDAP_SEARCH_FILTER'] }),
    ...(env['LDAP_ROLE_MAPPINGS'] === undefined
      ? {}
      : { roleMappings: parseRoleMappings(env['LDAP_ROLE_MAPPINGS']) }),
    ...(env['LDAP_DIALECT'] === undefined ? {} : { dialect: env['LDAP_DIALECT'] }),
    ...(env['LDAP_GROUP_SEARCH_BASE'] === undefined
      ? {}
      : { groupSearchBase: env['LDAP_GROUP_SEARCH_BASE'] }),
    ...(env['LDAP_NESTED_GROUPS'] === undefined
      ? {}
      : { nestedGroups: env['LDAP_NESTED_GROUPS'] === 'true' }),
    ...(env['LDAP_CA_PATH'] === undefined ? {} : { caPath: env['LDAP_CA_PATH'] }),
    ...(env['LDAP_TIMEOUT_MS'] === undefined
      ? {}
      : { timeoutMs: Number(env['LDAP_TIMEOUT_MS']) }),
    ...(env['LDAP_TLS_REJECT_UNAUTHORIZED'] === undefined
      ? {}
      : { tlsRejectUnauthorized: env['LDAP_TLS_REJECT_UNAUTHORIZED'] !== 'false' }),
  };

  const parsed = ldapConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid LDAP configuration:\n${detail}`);
  }

  // A bind DN with no password is an "unauthenticated bind" — see the note in
  // ldap-auth.provider.ts. Catch the misconfiguration here rather than letting
  // the search silently run with no privileges.
  if (parsed.data.bindDn !== undefined && parsed.data.bindPassword === undefined) {
    throw new Error(
      'LDAP_BIND_DN is set but LDAP_BIND_PASSWORD is not. A bind DN with an empty ' +
        'password is an unauthenticated bind, which many directories accept while ' +
        'granting nothing — searches would silently return no results.',
    );
  }

  // LDAP_MATCHING_RULE_IN_CHAIN is an Active Directory extension. OpenLDAP
  // answers a filter using it with an error, so honouring this on the wrong
  // dialect would turn every login into a PROVIDER_ERROR. Refusing at boot says
  // why; degrading silently to direct membership would quietly grant the wrong
  // roles.
  if (parsed.data.nestedGroups && !parsed.data.supportsNestedGroups) {
    throw new Error(
      `LDAP_NESTED_GROUPS is enabled but dialect "${parsed.data.dialect}" does not support ` +
        'LDAP_MATCHING_RULE_IN_CHAIN. Set LDAP_DIALECT=ad, or turn nested groups off.',
    );
  }

  // A CA that cannot be read is a deployment fault. Catching it here means the
  // loader refuses to start with a readable message, rather than every login
  // failing with a TLS error hours later.
  if (parsed.data.caPath !== undefined && !existsSync(parsed.data.caPath)) {
    throw new Error(
      `LDAP_CA_PATH points at ${parsed.data.caPath}, which does not exist. ` +
        'Mount the CA bundle into the container, or unset it to use the system trust store.',
    );
  }

  // Verification off AND a CA supplied means someone expected the CA to be
  // doing something. It is not: rejectUnauthorized false ignores it entirely.
  if (parsed.data.caPath !== undefined && !parsed.data.tlsRejectUnauthorized) {
    throw new Error(
      'LDAP_CA_PATH is set but LDAP_TLS_REJECT_UNAUTHORIZED is false, so the CA would be ' +
        'ignored and any certificate accepted. Set one or the other, not both.',
    );
  }

  return parsed.data;
}

function parseRoleMappings(value: string): Array<{ groupDn: string; role: string }> {
  return value
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const index = pair.lastIndexOf('=');
      if (index === -1) {
        throw new Error(`Malformed LDAP_ROLE_MAPPINGS entry "${pair}" — expected <groupDn>=<ROLE>`);
      }

      const groupDn = pair.slice(0, index).trim();
      const role = pair.slice(index + 1).trim();

      /*
       * The group part must itself look like a DN, i.e. contain an `=`.
       *
       * This check used to be free: the role was parsed as an enum, so
       * "cn=nope" produced role "NOPE" and failed validation. Roles are names
       * now (ADR-0018 §5) and any string is legal, so a mapping where somebody
       * forgot the role would otherwise be accepted as group "cn" mapped to
       * role "nope" — silently mapping nothing to nothing.
       */
      if (!groupDn.includes('=')) {
        throw new Error(
          `Malformed LDAP_ROLE_MAPPINGS entry "${pair}" — expected <groupDn>=<ROLE>, ` +
            `where the group is a DN such as cn=admins,ou=groups,dc=example,dc=com`,
        );
      }
      if (role === '') {
        throw new Error(`Malformed LDAP_ROLE_MAPPINGS entry "${pair}" — the role is empty`);
      }

      /*
       * Case is folded for the BUILT-IN names only.
       *
       * This used to upper-case everything, so `=admin` in an existing
       * deployment's environment resolved to ADMIN. Dropping the fold outright
       * would silently stop those configurations matching — a role change
       * nobody made. Folding everything is equally wrong the other way: a
       * custom role called `auditor` would be looked up as AUDITOR and match no
       * row.
       *
       * So: fold when the result IS a built-in, otherwise keep what was typed.
       */
      const folded = role.toUpperCase();
      const isBuiltIn = folded === 'VIEWER' || folded === 'OPERATOR' || folded === 'ADMIN';

      return { groupDn, role: isBuiltIn ? folded : role };
    });
}
