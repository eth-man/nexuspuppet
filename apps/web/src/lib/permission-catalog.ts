import type { Permission } from '@nexuspuppet/contracts';

/**
 * How much damage a permission can do, which decides how loudly it is labelled.
 *
 * Not a security boundary — the API does not read this, and nothing here
 * changes what is enforced. It exists so that granting `settings:manage` does
 * not look, in a list of eight checkboxes, exactly like granting `reports:read`.
 */
export type PermissionImpact = 'read' | 'write' | 'admin';

export interface PermissionInfo {
  /** Short label, sentence case. What a role holding this may do. */
  readonly summary: string;
  /**
   * The consequence an operator needs before ticking the box — what it reaches,
   * or what it changes outside the console. Kept to one or two sentences: this
   * is read while making a decision, not studied.
   */
  readonly detail: string;
  readonly impact: PermissionImpact;
  /**
   * Set when granting or revoking this has an effect that is not obvious from
   * its name. Rendered inline, next to the checkbox that causes it.
   */
  readonly caution?: string;
}

/**
 * Every permission the API arbitrates, described in the terms an operator
 * decides in.
 *
 * Typed as a total Record over `Permission`, so adding a permission to the
 * contracts package fails typecheck here until somebody writes down what it
 * grants. That is deliberate: an undescribed permission in an access-control
 * screen is worse than an absent one, because it still gets ticked.
 *
 * Ordered from least to most dangerous. The list is read top to bottom and the
 * things that can end an outage — or cause one — belong at the bottom where
 * they are not skimmed past.
 */
export const PERMISSION_CATALOG: Record<Permission, PermissionInfo> = {
  'inventory:read': {
    summary: 'View nodes, their facts, and console status',
    detail:
      'Read the node inventory and the facts reported for each one. This is also the baseline ' +
      'permission every signed-in user needs to load their own session and change their own password.',
    impact: 'read',
    caution:
      'Every built-in role holds this. A role without it can sign in but cannot see who it is or ' +
      'change its own password, which usually looks like a broken login rather than a policy choice.',
  },
  'resources:read': {
    summary: 'Search catalog resources across the estate, including their parameters',
    detail:
      'Read what nodes are actually managing — every resource in every catalog, and whether nodes ' +
      'in the same environment agree about it. Read-only against PuppetDB; it cannot change what ' +
      'Puppet does. It can, however, read resource PARAMETERS: the content of a managed file, and ' +
      'any credential a class was given as a parameter.',
    impact: 'read',
    caution:
      'Not the same as viewing facts, and deliberately separate from it. A holder can read managed ' +
      'file contents, and can confirm a secret by filtering on parameter values even without ' +
      'displaying them. Grant it to senior operators and auditors, not as a baseline. Expanding ' +
      'parameters and filtering by them are recorded in the audit trail (ADR-0025).',
  },
  'reports:read': {
    summary: 'View Puppet run reports and resource events',
    detail:
      'Read run history, run status, and the resource-level events behind each run. Read-only ' +
      'against PuppetDB — it cannot change what Puppet does.',
    impact: 'read',
  },
  'classification:read': {
    summary: 'View node groups, their rules, and conflicts',
    detail:
      'Read the classification tree: which groups exist, the rules that decide membership, the ' +
      'classes and parameters they assign, and any conflicts between them.',
    impact: 'read',
  },
  'classification:write': {
    summary: 'Create, edit, and delete node groups and rules',
    detail:
      'Change classification. Edits here decide which classes and parameters Puppet applies to ' +
      'real machines on their next run — this permission changes managed infrastructure, not just ' +
      'what the console displays.',
    impact: 'write',
    caution:
      'Takes effect on the next Puppet run of every matched node, without a further approval step.',
  },
  'materialization:trigger': {
    summary: 'Force the ENC to re-materialize',
    detail:
      'Queue a full reconcile so classification changes are recomputed for every node immediately, ' +
      'rather than at the next scheduled pass. Expensive on a large estate, but it changes no ' +
      'classification of its own.',
    impact: 'write',
  },
  'pql:raw': {
    summary: 'Run raw PQL against PuppetDB',
    detail:
      'Reserved for direct PQL access, which bypasses the query builder and reaches PuppetDB with ' +
      'an estate-wide certificate (ADR-0004).',
    impact: 'admin',
    caution:
      'No endpoint enforces this yet, so granting it currently permits nothing. It is listed so a ' +
      'role written today does not silently gain raw database access on the release that adds it.',
  },
  'users:manage': {
    summary: 'Create, edit, and remove console users',
    detail:
      'Add and delete users, deactivate accounts, reset passwords, and assign roles. Whoever holds ' +
      'this can give any existing role — including ADMIN — to anybody, themselves included.',
    impact: 'admin',
    caution:
      'Effectively grants every permission indirectly, by way of assigning a role that has it.',
  },
  'settings:manage': {
    summary: 'Configure directory, certificates, and roles',
    detail:
      'Change authentication and directory settings, install the console certificate, and edit ' +
      'roles on this screen.',
    impact: 'admin',
    caution:
      'Includes editing this very list, so a role holding it can grant itself anything. Treat it as ' +
      'equivalent to full administrative access.',
  },
};

/** Display order: least dangerous first. Derived from the catalogue's own key order. */
export const PERMISSIONS = Object.keys(PERMISSION_CATALOG) as Permission[];

const IMPACT_LABEL: Record<PermissionImpact, string> = {
  read: 'read only',
  write: 'changes infrastructure',
  admin: 'administrative',
};

export function impactLabel(impact: PermissionImpact): string {
  return IMPACT_LABEL[impact];
}
