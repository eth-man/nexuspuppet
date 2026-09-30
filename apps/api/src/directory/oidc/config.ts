import { z } from 'zod';
import { roleNameSchema, type UserRole } from '@nexuspuppet/contracts';

/**
 * OIDC configuration, validated at boot.
 *
 * A deployment that believes it has SSO and does not is discovered by the first
 * person who tries to log in — usually the first person who arrives on Monday.
 * The loader makes a throw from here fatal for exactly that reason.
 */

/** The three the product seeds. Everything else is a role a deployment defined. */
const builtInRoleSchema = z.enum(['VIEWER', 'OPERATOR', 'ADMIN']);

/** Rank exists only to recognise a built-in; OIDC does not order by it. */
const BUILT_IN: ReadonlySet<string> = new Set(builtInRoleSchema.options);

export function isBuiltInRole(name: string): name is UserRole {
  return BUILT_IN.has(name);
}

export const oidcConfigSchema = z.object({
  /**
   * The issuer, from which `.well-known/openid-configuration` is discovered.
   *
   * Discovery rather than hand-configured endpoints: an issuer that rotates a
   * token endpoint would otherwise silently break, and the `issuer` value in the
   * discovery document is checked against this — a mismatch means the document
   * did not come from the issuer it claims to describe.
   */
  issuer: z.string().url(),

  clientId: z.string().min(1),
  /**
   * Optional: a public client uses PKCE alone. Required for a confidential one.
   * Never rendered by `describe()`.
   */
  clientSecret: z.string().min(1).optional(),

  /**
   * Where the identity provider sends the browser back. Must match what is
   * registered with the provider EXACTLY, including scheme and trailing path.
   */
  redirectUri: z.string().url(),

  /** `openid` is added automatically; it is what makes this OIDC and not OAuth. */
  scopes: z.array(z.string().min(1)).default(['profile', 'email']),

  /** Claim carrying the address that identifies a NexusPuppet account. */
  emailClaim: z.string().min(1).default('email'),
  displayNameClaim: z.string().min(1).default('name'),
  /**
   * Claim carrying group membership.
   *
   * `groups` is conventional but not standard — Entra ID uses `groups`, Okta is
   * commonly configured with `groups`, Keycloak needs a mapper adding. There is
   * no safe default beyond the convention, so a deployment whose provider names
   * it otherwise must say so.
   */
  groupsClaim: z.string().min(1).default('groups'),

  /**
   * Group value to role NAME, which may be one a deployment defined itself
   * (ADR-0018 §5). Typed as the three-value enum until then, which meant a
   * custom role could be created and mapped from an LDAP group but never from
   * an OIDC claim — the feature existed and was unreachable from here.
   *
   * Order matters for built-ins: the first match wins, so the most privileged
   * mapping belongs first. See `resolveOidcRole` for what happens once a custom
   * role is involved, where ordering stops being meaningful.
   */
  roleMappings: z.array(z.object({ group: z.string().min(1), role: roleNameSchema })).default([]),

  /**
   * Role for someone who authenticates but matches no mapping.
   *
   * Absent means REFUSED, and that is the default deliberately. The alternative
   * grants everyone in the identity provider access to the estate inventory,
   * which for most directories is the entire company.
   */
  defaultRole: roleNameSchema.optional(),

  /** Bounds every network call to the identity provider. */
  timeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  /**
   * Tolerance for clock skew when checking `exp` and `iat`.
   *
   * Small on purpose. A generous window is a generous replay window, and an
   * estate whose clocks differ by more than a minute has a problem this setting
   * would only hide.
   */
  clockSkewSeconds: z.coerce.number().int().min(0).max(300).default(60),
});

export type OidcConfig = z.infer<typeof oidcConfigSchema>;

/**
 * Parse `group=ROLE;group=ROLE`, matching the LDAP layer's syntax.
 *
 * Same shape deliberately: an administrator configuring both should not have to
 * learn two grammars, and a group value here is a claim value where LDAP's is a
 * DN — the only real difference.
 */
export function parseRoleMappings(raw: string): Array<{ group: string; role: string }> {
  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const at = pair.lastIndexOf('=');
      if (at === -1) {
        throw new Error(`Invalid OIDC role mapping "${pair}": expected group=ROLE.`);
      }
      const group = pair.slice(0, at).trim();
      const written = pair.slice(at + 1).trim();

      if (group.length === 0) {
        throw new Error(`Invalid OIDC role mapping "${pair}": the group is empty.`);
      }
      if (written.length === 0) {
        throw new Error(`Invalid OIDC role mapping "${pair}": the role is empty.`);
      }

      /*
       * Case-fold ONLY when the result is a built-in.
       *
       * `viewer` and `VIEWER` have always meant the same thing and must keep
       * doing so. But blanket upper-casing would rewrite a custom role named
       * `auditor` to `AUDITOR`, which matches no row — the mapping would
       * silently grant nothing. Same rule as the LDAP parser, for the same
       * reason.
       */
      const folded = written.toUpperCase();
      const role = isBuiltInRole(folded) ? folded : written;

      const parsed = roleNameSchema.safeParse(role);
      if (!parsed.success) {
        // A name outside the charset can never match a role row, so it is a
        // configuration error rather than a mapping to surface later.
        throw new Error(
          `Invalid OIDC role mapping "${pair}": "${role}" is not a usable role name ` +
            '(letters, digits, dot, underscore and hyphen only).',
        );
      }
      return { group, role: parsed.data };
    });
}

/** Upper-case a role name only when that makes it one of the built-ins. */
function foldRoleName(written: string): string {
  const folded = written.toUpperCase();
  return isBuiltInRole(folded) ? folded : written;
}

const list = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
};

/** Null when OIDC is not configured — a valid state, not an error. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env['OIDC_ISSUER'];
  if (issuer === undefined || issuer.trim() === '') return null;

  const parsed = oidcConfigSchema.safeParse({
    issuer: issuer.trim(),
    clientId: env['OIDC_CLIENT_ID'],
    clientSecret: env['OIDC_CLIENT_SECRET'],
    redirectUri: env['OIDC_REDIRECT_URI'],
    ...(list(env['OIDC_SCOPES']) === undefined ? {} : { scopes: list(env['OIDC_SCOPES']) }),
    ...(env['OIDC_EMAIL_CLAIM'] === undefined ? {} : { emailClaim: env['OIDC_EMAIL_CLAIM'] }),
    ...(env['OIDC_DISPLAY_NAME_CLAIM'] === undefined
      ? {}
      : { displayNameClaim: env['OIDC_DISPLAY_NAME_CLAIM'] }),
    ...(env['OIDC_GROUPS_CLAIM'] === undefined ? {} : { groupsClaim: env['OIDC_GROUPS_CLAIM'] }),
    ...(env['OIDC_ROLE_MAPPINGS'] === undefined
      ? {}
      : { roleMappings: parseRoleMappings(env['OIDC_ROLE_MAPPINGS']) }),
    // Folded only when the result is a built-in, as in a mapping: a default of
    // `auditor` must not be rewritten to `AUDITOR` and match no role.
    ...(env['OIDC_DEFAULT_ROLE'] === undefined
      ? {}
      : { defaultRole: foldRoleName(env['OIDC_DEFAULT_ROLE'].trim()) }),
    ...(env['OIDC_TIMEOUT_MS'] === undefined ? {} : { timeoutMs: env['OIDC_TIMEOUT_MS'] }),
    ...(env['OIDC_CLOCK_SKEW_SECONDS'] === undefined
      ? {}
      : { clockSkewSeconds: env['OIDC_CLOCK_SKEW_SECONDS'] }),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid OIDC configuration: ${detail}`);
  }

  return parsed.data;
}

export interface ResolvedOidcRoles {
  /** For display and for the stored assignment. */
  primary: string;
  /** Every role that applies. Authorization unions their permissions. */
  all: string[];
}

/**
 * Which roles the claim says this person holds (ADR-0018 §5).
 *
 * TWO RULES, chosen by what the matched mappings actually name:
 *
 * - **Only built-ins → first match in mapping order wins.** Unchanged, and
 *   that is the point: OIDC has always resolved by configured order and told
 *   operators to put the most privileged mapping first. Switching to LDAP's
 *   highest-wins rule would silently re-read existing configurations — a
 *   deployment listing `contractors=VIEWER` before `ops=OPERATOR` would find
 *   its contractors promoted, with no diff to review. ADR-0018 §5 refuses that
 *   trade for exactly this reason.
 * - **Any custom role → union.** Ordering stops meaning anything once roles
 *   are not ranked: there is no answer to "is `auditor` above or below
 *   `deployer`" that is not invented. A deployment opts in by naming a custom
 *   role, which is a deliberate edit.
 *
 * `primary` is display and storage only — `all` is what authorization reads —
 * so it stays the first match in mapping order, which is the order somebody
 * chose rather than one this function invented.
 *
 * @returns null when no mapping matched and no default role is configured,
 *          which the caller must treat as a refusal.
 */
export function resolveOidcRole(
  groups: readonly string[],
  config: OidcConfig,
): ResolvedOidcRoles | null {
  const held = new Set(groups);

  const matched: string[] = [];
  for (const mapping of config.roleMappings) {
    if (!held.has(mapping.group)) continue;
    if (!matched.includes(mapping.role)) matched.push(mapping.role);
  }

  if (matched.length === 0) {
    const fallback = config.defaultRole;
    return fallback === undefined ? null : { primary: fallback, all: [fallback] };
  }

  const first = matched[0] as string;
  if (matched.every(isBuiltInRole)) return { primary: first, all: [first] };

  return { primary: first, all: matched };
}
