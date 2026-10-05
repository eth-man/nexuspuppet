import { existsSync } from 'node:fs';
import {
  LDAP_BIND_TYPES,
  LDAP_DIALECTS,
  ldapHostProblem,
  ldapUrlOf,
  parseLegacyLdapUrl,
  upgradeLegacyLdapSettings,
  userDnPatternProblem,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { CaPemError, parseCaPem } from './ca-pem';
import { dialectDefaults } from './dialect';

/**
 * LDAP configuration, validated at boot.
 *
 * Deliberately strict: a directory misconfiguration must fail at startup with a
 * readable message, not at 3am when the first person tries to log in. A throw
 * from here is fatal at boot (config/integrations.ts wraps it in an
 * IntegrationConfigError), which is exactly the behaviour wanted — a deployment
 * that believes it has a directory must never silently run without one.
 *
 * The same schema parses a configuration saved in the console, including one
 * saved before ADR-0030 in the `url` + `dialect` shape: the contracts'
 * `upgradeLegacyLdapSettings` brings that into today's shape first, so a v1.12
 * row keeps working without being saved again.
 */
const baseLdapConfigSchema = z.object({
  /**
   * The server's name or IP, as on its certificate (ADR-0030). The client
   * verifies the certificate against it, and STARTTLS sends it as SNI.
   */
  host: z
    .string()
    .trim()
    .superRefine((value, context) => {
      const problem = ldapHostProblem(value);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem });
    }),
  port: z.number().int().min(1).max(65535),

  /**
   * `ldaps` (TLS from the first byte) or `starttls` (upgraded before anything
   * else is sent — see LdaptsDirectory). `ldap` is unencrypted: only a legacy
   * row, or an `ldap://` LDAP_URL without LDAP_STARTTLS, can hold it. It keeps
   * working exactly as it did, and is warned about.
   */
  protocol: z.enum(['ldaps', 'starttls', 'ldap']),

  /** How the directory is bound to — see LDAP_BIND_TYPES in contracts. */
  bindType: z.enum(LDAP_BIND_TYPES),

  /**
   * Service account used to SEARCH for the user's DN (Regular bind only). Not
   * used to authenticate them — that is a second bind as the user themselves.
   */
  bindDn: z.string().min(1).optional(),
  bindPassword: z.string().min(1).optional(),

  /** Simple bind only: `uid={username},ou=people,…` or `{username}@corp.example`. */
  userDnPattern: z
    .string()
    .trim()
    .superRefine((value, context) => {
      const problem = userDnPatternProblem(value);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem });
    })
    .optional(),

  /**
   * Which directory this is. Supplies defaults for the search filter, the
   * identifier label, and whether nested groups can be resolved at all.
   *
   * Resolved before parsing (see `prepare`): `LDAP_DIALECT` for the
   * environment, what the console DETECTED from the server's RootDSE for a
   * saved configuration (or, for one saved before ADR-0030, what the operator
   * chose), else OpenLDAP.
   */
  dialect: z.enum(LDAP_DIALECTS).default('openldap'),

  /** What the console detected, kept so it can be reported back as such. */
  detectedDialect: z.enum(LDAP_DIALECTS).optional(),

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
   * server over TLS is to disable verification entirely — which turns every
   * password submitted to this console into something the network can read.
   * This exists so that is never the answer.
   *
   * A path to a MOUNTED FILE, never inline PEM: the same rule the PuppetDB
   * client follows. Certificate material in an environment variable
   * ends up in `docker inspect`, process listings, and crash reports.
   */
  caPath: z.string().min(1).optional(),

  /**
   * The same trust material as PEM TEXT, from the console only (ADR-0029 §5).
   *
   * Not a contradiction of the rule above. That rule is about the
   * ENVIRONMENT, where certificate material leaks into `docker inspect` and
   * crash reports; `ldapConfigFromEnv` never reads this field, so inline PEM
   * in the environment stays refused. A stored configuration is a database
   * row, and a CA certificate is public anyway. When both are present this
   * wins: it is what an operator pasted most recently, and the path is only
   * inherited from the boot configuration.
   *
   * Parsed as X.509 here, so a stored value that no longer parses refuses
   * directory logins loudly instead of failing every TLS handshake.
   */
  caPem: z
    .string()
    .min(1)
    .superRefine((value, context) => {
      try {
        parseCaPem(value);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof CaPemError ? error.message : String(error),
        });
      }
    })
    .optional(),

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
 * Bring any accepted input into the shape above.
 *
 * - The legacy `url` / `dialect` shape is upgraded by the same function the
 *   settings view uses, so the two cannot disagree about what a row means.
 * - The dialect in force is the explicit one (LDAP_DIALECT, or a legacy row's
 *   choice), else the detected one, else the default.
 */
function prepare(raw: unknown): unknown {
  const upgraded = upgradeLegacyLdapSettings(raw);
  if (upgraded === null || typeof upgraded !== 'object') return upgraded;
  const input = upgraded as Record<string, unknown>;
  if (input['dialect'] === undefined && input['detectedDialect'] !== undefined) {
    input['dialect'] = input['detectedDialect'];
  }
  return input;
}

/**
 * Each bind type's credentials must be complete, because each is used as-is.
 *
 * A Regular bind with no password used to fall through to an anonymous
 * search; with the bind type explicit, that is now a configuration that says
 * one thing and does another, so it is refused. (A row saved before ADR-0030
 * with a bind DN and no password never gets here: it upgrades to Anonymous,
 * which is what it always did.)
 */
const checkedLdapConfigSchema = baseLdapConfigSchema.superRefine((value, context) => {
  if (value.bindType === 'regular') {
    if (value.bindDn === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['bindDn'],
        message: 'Regular bind needs a User DN (the service account).',
      });
    }
    if (value.bindPassword === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['bindPassword'],
        message:
          'Regular bind needs the User DN’s password. A bind DN with an empty password is an ' +
          'unauthenticated bind, which many directories accept while granting nothing.',
      });
    }
  }
  if (value.bindType === 'simple' && value.userDnPattern === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['userDnPattern'],
      message: 'Simple bind needs a User DN pattern containing {email} or {username}.',
    });
  }
});

/**
 * Fill anything the operator left unset from the dialect's defaults.
 *
 * Done here rather than at each use so the rest of the package sees one
 * concrete shape: no `?? 'mail'` scattered through the authentication path,
 * where a missed fallback would silently read the wrong attribute and refuse
 * every login.
 */
export const ldapConfigSchema = z
  .preprocess(prepare, checkedLdapConfigSchema)
  .transform((input) => {
    const defaults = dialectDefaults(input.dialect);
    const config = {
      ...input,
      /** Derived, for the client and for display. Never stored. */
      url: ldapUrlOf(input),
      searchFilter: input.searchFilter ?? defaults.searchFilter,
      // Simple bind substitutes the account's EMAIL — what the resolver looks
      // the account up by — into the pattern, whatever the directory is.
      identifierLabel: input.bindType === 'simple' ? 'Email' : defaults.identifierLabel,
      supportsNestedGroups: defaults.supportsNestedGroups,
      groupSearchBase: input.groupSearchBase ?? input.searchBase,
      attributes: {
        email: input.attributes.email ?? defaults.attributes.email,
        displayName: input.attributes.displayName ?? defaults.attributes.displayName,
        memberOf: input.attributes.memberOf ?? defaults.attributes.memberOf,
      },
    };
    // Credentials a bind type does not use are not carried, so nothing can use
    // them by accident.
    if (config.bindType !== 'regular') {
      delete config.bindDn;
      delete config.bindPassword;
    }
    if (config.bindType !== 'simple') delete config.userDnPattern;
    return config;
  });

export type LdapConfig = z.output<typeof ldapConfigSchema>;

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
 *
 * The environment keeps its URL (ADR-0030 §6): `LDAP_URL` is read exactly as
 * before, `LDAP_STARTTLS=true` upgrades an `ldap://` one, and `LDAP_BIND_TYPE`
 * / `LDAP_USER_DN_PATTERN` give it the console's bind types. The directory
 * type is NOT detected here — that would need the network at boot — so
 * `LDAP_DIALECT` (default openldap) still decides it, as it always has.
 */
export function ldapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LdapConfig {
  const problems: string[] = [];

  const url = env['LDAP_URL'];
  const target = url === undefined ? null : parseLegacyLdapUrl(url);
  if (target === null) {
    problems.push(
      url === undefined
        ? '  url: LDAP_URL is required'
        : '  url: LDAP_URL must be ldap://host[:port] or ldaps://host[:port] — the ldap:// or ldaps:// scheme, a server name, an optional port, and nothing else',
    );
  }

  const startTls = env['LDAP_STARTTLS'];
  if (startTls !== undefined && startTls !== 'true' && startTls !== 'false') {
    problems.push(`  LDAP_STARTTLS: must be true or false, not "${startTls}"`);
  }
  if (startTls === 'true' && target?.protocol === 'ldaps') {
    problems.push(
      '  LDAP_STARTTLS: STARTTLS upgrades an ldap:// connection. With ldaps:// the connection is ' +
        'already TLS — use LDAP_URL=ldap://host:389 with LDAP_STARTTLS=true, or drop LDAP_STARTTLS.',
    );
  }

  const bindType = env['LDAP_BIND_TYPE'];
  if (bindType !== undefined && !(LDAP_BIND_TYPES as readonly string[]).includes(bindType)) {
    problems.push(
      `  LDAP_BIND_TYPE: must be one of ${LDAP_BIND_TYPES.join(', ')}, not "${bindType}"`,
    );
  }
  if (env['LDAP_USER_DN_PATTERN'] !== undefined && bindType !== 'simple') {
    problems.push('  LDAP_USER_DN_PATTERN: only used with LDAP_BIND_TYPE=simple');
  }
  if (bindType === 'simple' && env['LDAP_BIND_DN'] !== undefined) {
    problems.push(
      '  LDAP_BIND_DN: Simple bind has no service account — it binds as each user directly. ' +
        'Unset LDAP_BIND_DN, or use LDAP_BIND_TYPE=regular.',
    );
  }
  if (bindType === 'anonymous' && env['LDAP_BIND_DN'] !== undefined) {
    problems.push(
      '  LDAP_BIND_DN: set alongside LDAP_BIND_TYPE=anonymous, which would ignore it. ' +
        'Unset one of them.',
    );
  }

  const raw = {
    ...(target === null
      ? {}
      : {
          host: target.host,
          port: target.port,
          protocol:
            target.protocol === 'ldap' && startTls === 'true' ? 'starttls' : target.protocol,
        }),
    // Inferred exactly as before when unset: a bind DN means a service account.
    bindType: bindType ?? (env['LDAP_BIND_DN'] === undefined ? 'anonymous' : 'regular'),
    ...(env['LDAP_BIND_DN'] === undefined ? {} : { bindDn: env['LDAP_BIND_DN'] }),
    ...(env['LDAP_BIND_PASSWORD'] === undefined ? {} : { bindPassword: env['LDAP_BIND_PASSWORD'] }),
    ...(env['LDAP_USER_DN_PATTERN'] === undefined
      ? {}
      : { userDnPattern: env['LDAP_USER_DN_PATTERN'] }),
    searchBase: env['LDAP_SEARCH_BASE'],
    ...(env['LDAP_SEARCH_FILTER'] === undefined ? {} : { searchFilter: env['LDAP_SEARCH_FILTER'] }),
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
    ...(env['LDAP_TIMEOUT_MS'] === undefined ? {} : { timeoutMs: Number(env['LDAP_TIMEOUT_MS']) }),
    ...(env['LDAP_TLS_REJECT_UNAUTHORIZED'] === undefined
      ? {}
      : { tlsRejectUnauthorized: env['LDAP_TLS_REJECT_UNAUTHORIZED'] !== 'false' }),
  };

  // A bind DN with no password is an "unauthenticated bind" — see the note in
  // ldap-auth.provider.ts. Caught here, by name, rather than as the schema's
  // generic complaint about a missing field.
  if (env['LDAP_BIND_DN'] !== undefined && env['LDAP_BIND_PASSWORD'] === undefined) {
    problems.push(
      '  LDAP_BIND_DN is set but LDAP_BIND_PASSWORD is not. A bind DN with an empty ' +
        'password is an unauthenticated bind, which many directories accept while ' +
        'granting nothing — searches would silently return no results.',
    );
  }

  const parsed = ldapConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      // The URL's parts were reported above, in the variable's own name.
      if (target === null && ['host', 'port', 'protocol'].includes(path)) continue;
      // Already said, by name, above.
      if (path === 'bindPassword' && env['LDAP_BIND_DN'] !== undefined) continue;
      problems.push(`  ${path}: ${issue.message}`);
    }
  }
  if (problems.length > 0 || !parsed.success) {
    throw new Error(`Invalid LDAP configuration:\n${problems.join('\n')}`);
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
