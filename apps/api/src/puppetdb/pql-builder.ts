import type { NodeFilter, PageRequest } from '@nexuspuppet/contracts';

/**
 * Builds PuppetDB queries from typed filters (ADR-0004).
 *
 * WHY AST AND NOT PQL STRINGS
 * ---------------------------
 * PuppetDB accepts either a PQL string or an AST expressed as nested JSON
 * arrays. We emit the AST exclusively. Values sit in their own array slots and
 * are serialised by JSON.stringify, so there is no grammar for a hostile value
 * to break out of — injection is structurally impossible rather than escaped
 * and hoped for.
 *
 * This matters more here than in most applications: the mTLS certificate
 * PuppetDB authenticates is estate-wide and read-everything, so a caller who
 * could smuggle a query fragment past us would read the entire estate
 * regardless of their role in NexusPuppet.
 *
 * The one place a value still reaches an interpreter is the `~` regex operator,
 * used for substring search. Regex metacharacters are escaped there.
 */

export type PqlAst = unknown[];

const NODE_FIELDS = {
  certname: 'certname',
  reportEnvironment: 'report_environment',
  factsEnvironment: 'facts_environment',
  catalogEnvironment: 'catalog_environment',
  reportTimestamp: 'report_timestamp',
  latestReportStatus: 'latest_report_status',
  deactivated: 'deactivated',
  expired: 'expired',
} as const;

/**
 * Escape every regex metacharacter so a substring search is a literal
 * substring search. Without this, a filter of `.*` matches everything and
 * `(a+)+$` is a ReDoS against PuppetDB itself.
 */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Order-by fields a caller may name. An allow-list, not free text. */
const SORTABLE = new Set<string>([
  'certname',
  'report_timestamp',
  'facts_timestamp',
  'catalog_timestamp',
  'latest_report_status',
  'receive_time',
  'start_time',
  'end_time',
]);

const SORTABLE_ALIASES: Record<string, string> = {
  reportTimestamp: 'report_timestamp',
  factsTimestamp: 'facts_timestamp',
  catalogTimestamp: 'catalog_timestamp',
  latestReportStatus: 'latest_report_status',
};

export function resolveOrderBy(field: string | undefined): string {
  if (field === undefined) return 'certname';
  const resolved = SORTABLE_ALIASES[field] ?? field;
  // Unknown fields fall back rather than reaching PuppetDB, which would answer
  // with an opaque 400 that surfaces to the operator as "something broke".
  return SORTABLE.has(resolved) ? resolved : 'certname';
}

/**
 * Translate a typed NodeFilter into a PuppetDB AST.
 *
 * @returns null when the filter is empty — PuppetDB treats an absent query as
 *          "everything", and an empty `["and"]` is a syntax error.
 */
export function buildNodeQuery(filter: NodeFilter): PqlAst | null {
  const clauses: PqlAst[] = [];

  if (filter.certnameContains !== undefined && filter.certnameContains !== '') {
    // Literal substring match, case-insensitive via PuppetDB's ~ operator.
    clauses.push(['~', NODE_FIELDS.certname, escapeRegex(filter.certnameContains)]);
  }

  if (filter.environments !== undefined && filter.environments.length > 0) {
    // Match any of the three environment fields: a node mid-migration may have
    // moved its facts but not yet its report, and hiding it would make it look
    // like it had vanished from the estate.
    clauses.push([
      'or',
      ...filter.environments.flatMap((env) => [
        ['=', NODE_FIELDS.reportEnvironment, env],
        ['=', NODE_FIELDS.factsEnvironment, env],
        ['=', NODE_FIELDS.catalogEnvironment, env],
      ]),
    ]);
  }

  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    clauses.push([
      'or',
      ...filter.statuses.map((status) =>
        // Our `unknown` is PuppetDB's null — a deactivated or never-reported
        // node. It has no literal value to compare against.
        status === 'unknown'
          ? ['null?', NODE_FIELDS.latestReportStatus, true]
          : ['=', NODE_FIELDS.latestReportStatus, status],
      ),
    ]);
  }

  if (filter.staleBefore !== undefined && filter.staleBefore !== '') {
    // A node that never reported is stale by any reasonable reading, so it must
    // be included rather than filtered out by the comparison.
    clauses.push([
      'or',
      ['<', NODE_FIELDS.reportTimestamp, filter.staleBefore],
      ['null?', NODE_FIELDS.reportTimestamp, true],
    ]);
  }

  if (!filter.includeInactive) {
    clauses.push(['null?', NODE_FIELDS.deactivated, true]);
    clauses.push(['null?', NODE_FIELDS.expired, true]);
  }

  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0] as PqlAst;
  return ['and', ...clauses];
}

/** Reports for one certname, newest first. */
export function buildReportQuery(certname: string): PqlAst {
  return ['=', 'certname', certname];
}

export function buildReportByHashQuery(hash: string): PqlAst {
  return ['=', 'hash', hash];
}

/**
 * Facts named in the projection allow-list, across every node.
 *
 * @returns null when the allow-list is empty — which would otherwise build an
 *          empty `or` and fetch every fact in the estate.
 */
export function buildFactsQuery(factNames: readonly string[]): PqlAst | null {
  if (factNames.length === 0) return null;
  return ['or', ...factNames.map((name) => ['=', 'name', name])];
}

export function buildEventsQuery(reportHash: string): PqlAst {
  return ['=', 'report', reportHash];
}

/**
 * Wrap a query so PuppetDB returns a count instead of rows.
 * Used for the pagination total, so the UI can show "50 of 1,204".
 */
export function buildCountQuery(query: PqlAst | null): PqlAst {
  const extract = ['extract', [['function', 'count']]];
  return query === null ? extract : [...extract, query];
}

export interface PaginationParams extends Record<string, string | number> {
  limit: number;
  offset: number;
  order_by: string;
}

/**
 * PuppetDB pagination parameters. `order_by` is itself JSON, and `include_total`
 * is deliberately not used — it is markedly slower than a separate count query
 * on large estates.
 */
export function buildPagination(page: PageRequest): PaginationParams {
  return {
    limit: page.limit,
    offset: page.offset,
    order_by: JSON.stringify([{ field: resolveOrderBy(page.orderBy), order: page.order }]),
  };
}
