import type { UserRole } from '@nexuspuppet/contracts';
import type { LdapConfig } from './config';

/**
 * Directory group -> NexusPuppet role.
 *
 * Two decisions worth stating, because both are the kind that get "simplified"
 * later:
 *
 * 1. HIGHEST role wins. Someone in both `ops` and `puppet-admins` is an admin.
 *    Taking the first match instead would make the outcome depend on the order
 *    the directory happened to return memberOf, which is not specified.
 *
 * 2. NO default role. A user in none of the mapped groups is refused, not made
 *    a VIEWER. Defaulting grants estate-wide read access to anyone the
 *    directory contains — including contractors, service accounts, and former
 *    staff whose entries have not been removed. Read access to an estate
 *    inventory is not nothing: it is a map of every host, its OS, and its
 *    patch state.
 */

const RANK: Record<UserRole, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };

/**
 * DN comparison is case-insensitive and whitespace-insensitive around commas,
 * because directories are inconsistent about both. `CN=Ops, OU=Groups` and
 * `cn=ops,ou=groups` are the same group, and an operator who types one while
 * the directory returns the other should not silently get no access.
 *
 * This is deliberately NOT a full RFC 4514 DN parser. It normalises the two
 * things that vary in practice; anything more would be guessing at semantics
 * only the directory can settle.
 */
export function normalizeDn(dn: string): string {
  return dn
    .split(',')
    .map((part) => part.trim())
    .join(',')
    .toLowerCase();
}

/** A role name is built-in when RANK knows it. Anything else is a custom role. */
function isBuiltIn(name: string): name is UserRole {
  return Object.prototype.hasOwnProperty.call(RANK, name);
}

export interface ResolvedRoles {
  /** For display and for the stored assignment. */
  primary: string;
  /** Every role that applies. Authorization unions their permissions. */
  all: string[];
}

/**
 * Which roles the directory says this person holds (ADR-0018 §5).
 *
 * TWO RULES, chosen by what the matched mappings actually name:
 *
 * - **Only built-ins → highest wins.** Unchanged behaviour, and that is the
 *   point. Somebody in both `ops` and `viewers` gets OPERATOR today, and an
 *   upgrade must not quietly turn that into OPERATOR ∪ VIEWER. Nobody edited
 *   anything, so nothing may change.
 * - **Any custom role → union.** Ordering stops meaning anything once roles are
 *   not ranked: there is no answer to "is `auditor` above or below `deployer`"
 *   that is not invented. Union is the only rule that does not require one.
 *
 * A deployment opts into the second by naming a custom role in a mapping, which
 * is a deliberate edit made while looking at the settings screen.
 *
 * @returns null when the user belongs to no mapped group — which the caller
 *          must treat as a refusal, not as a default role.
 */
export function resolveRoles(groupDns: readonly string[], config: LdapConfig): ResolvedRoles | null {
  const held = new Set(groupDns.map(normalizeDn));

  const matched: string[] = [];
  for (const mapping of config.roleMappings) {
    if (!held.has(normalizeDn(mapping.groupDn))) continue;
    if (!matched.includes(mapping.role)) matched.push(mapping.role);
  }

  if (matched.length === 0) return null;

  if (matched.every(isBuiltIn)) {
    const best = matched.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
    return { primary: best, all: [best] };
  }

  /*
   * Primary is the highest built-in when one matched, else the first custom in
   * MAPPING ORDER — the order the operator wrote them in, which is at least
   * something they chose, rather than alphabetical or arbitrary.
   *
   * It is display and storage only. `all` is what decides access, so a wrong
   * guess here costs a label, not a permission.
   */
  const builtIns = matched.filter(isBuiltIn);
  const primary =
    builtIns.length > 0 ? builtIns.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : matched[0]!;

  return { primary, all: matched };
}
