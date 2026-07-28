import { z } from 'zod';

/**
 * PuppetDB access contract (ADR-0004).
 *
 * PuppetDB is READ-ONLY. There is no command/write surface in this interface
 * and none may be added — deactivating nodes or submitting facts is not
 * NexusPuppet's business.
 *
 * These are DOMAIN types, not wire types. PuppetDB speaks snake_case and
 * exposes some fields we deliberately reshape (three separate environment
 * fields; `expired` as a timestamp rather than a flag; no duration on reports).
 * The client owns that translation so PuppetDB's shape does not leak into our
 * API or the UI. Wire shapes are documented at each field that differs.
 *
 * Note the absence of any `query(pql: string)` method taking caller-supplied
 * PQL. The mTLS client certificate is estate-wide, so the API is a confused
 * deputy by construction; callers pass typed filters and the implementation
 * builds a parameterised AST query.
 */

/**
 * PuppetDB's `latest_report_status`. Documented values are `changed`,
 * `unchanged`, and `failed`; older servers have also been observed emitting
 * `success`. `unknown` is ours, covering null — which is what a deactivated or
 * never-reported node returns.
 */
export const nodeStatusSchema = z.enum(['changed', 'unchanged', 'failed', 'unknown']);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const puppetNodeSchema = z.object({
  certname: z.string(),

  /**
   * Effective environment. PuppetDB exposes `report_environment`,
   * `facts_environment`, and `catalog_environment` separately; they normally
   * agree, and an inventory table wants one column. Resolution order is
   * report → facts → catalog. The three raw values are preserved below so a
   * disagreement — which usually means a half-completed environment move —
   * remains visible rather than being silently flattened.
   */
  environment: z.string().nullable(),
  reportEnvironment: z.string().nullable(),
  factsEnvironment: z.string().nullable(),
  catalogEnvironment: z.string().nullable(),

  /** ISO-8601, or null when the node has never submitted one. */
  reportTimestamp: z.string().nullable(),
  factsTimestamp: z.string().nullable(),
  catalogTimestamp: z.string().nullable(),

  latestReportStatus: nodeStatusSchema,
  latestReportHash: z.string().nullable(),
  latestReportNoop: z.boolean(),

  /**
   * Wire fields `deactivated` and `expired` are TIMESTAMPS OR NULL, not
   * booleans — a node carries when it was deactivated, not merely that it was.
   * Preserved as timestamps, with `isActive` derived for the common case.
   */
  deactivated: z.string().nullable(),
  expired: z.string().nullable(),
  isActive: z.boolean(),
});
export type PuppetNode = z.infer<typeof puppetNodeSchema>;

export const nodeFilterSchema = z.object({
  certnameContains: z.string().max(255).optional(),
  environments: z.array(z.string()).optional(),
  statuses: z.array(nodeStatusSchema).optional(),
  /** Nodes whose last report is older than this ISO-8601 instant. */
  staleBefore: z.string().optional(),
  /**
   * Nodes whose FACTS changed after this ISO-8601 instant.
   *
   * Facts, not reports: classification is evaluated against facts, and a node
   * can report repeatedly without any fact the rules read having changed.
   * Filtering on report_timestamp instead would return the whole estate on
   * every agent run and defeat the point.
   */
  factsChangedSince: z.string().datetime().optional(),
  /** Default false: deactivated and expired nodes are hidden unless asked for. */
  includeInactive: z.boolean().default(false),
});
export type NodeFilter = z.infer<typeof nodeFilterSchema>;

/**
 * Server-driven pagination. A 10,000-row inventory must never be shipped to the
 * browser in one response (ADR-0008).
 */
export const pageRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  orderBy: z.string().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type PageRequest = z.infer<typeof pageRequestSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Documented legal values: success, failure, noop, skipped. */
export const eventStatusSchema = z.enum(['success', 'failure', 'noop', 'skipped']);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const resourceEventSchema = z.object({
  status: eventStatusSchema,
  timestamp: z.string().nullable(),
  resourceType: z.string(),
  resourceTitle: z.string(),
  property: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  message: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  /** e.g. ["Stage[main]", "Profile::Db::Postgres", "Package[postgresql16-server]"] */
  containmentPath: z.array(z.string()),
  containingClass: z.string().nullable(),
  correctiveChange: z.boolean().nullable(),
});
export type ResourceEvent = z.infer<typeof resourceEventSchema>;

export const puppetReportSchema = z.object({
  hash: z.string(),
  certname: z.string(),
  environment: z.string().nullable(),
  status: z.enum(['changed', 'unchanged', 'failed', 'unknown']),
  noop: z.boolean(),
  noopPending: z.boolean(),
  puppetVersion: z.string().nullable(),
  configurationVersion: z.string().nullable(),
  transactionUuid: z.string().nullable(),
  catalogUuid: z.string().nullable(),
  cachedCatalogStatus: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  receiveTime: z.string().nullable(),
  /**
   * DERIVED from start_time/end_time. PuppetDB reports carry no duration field;
   * the `time`/`total` metric is close but is catalog application time only and
   * is absent on some report formats.
   */
  durationSeconds: z.number().nullable(),
});
export type PuppetReport = z.infer<typeof puppetReportSchema>;

/** Resource/event/change counters from a report's `metrics` collection. */
export const reportSummarySchema = z.object({
  resourcesTotal: z.number().nullable(),
  resourcesChanged: z.number().nullable(),
  resourcesFailed: z.number().nullable(),
  resourcesSkipped: z.number().nullable(),
  eventsTotal: z.number().nullable(),
  timeTotalSeconds: z.number().nullable(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

/**
 * One (certname, fact) pair from /pdb/query/v4/facts.
 *
 * The projector reads facts in BULK this way rather than fetching a factset
 * per node: at 1,000 nodes a per-node fetch is 1,000 round trips every cycle,
 * which is both slow and a needless load on PuppetDB.
 */
export interface FactRow {
  certname: string;
  name: string;
  value: unknown;
}

export interface PuppetDbHealth {
  reachable: boolean;
  /** ISO-8601 of the last successful query, for the degraded-state UI (ADR-0004). */
  lastSuccessAt: string | null;
  version: string | null;
  error?: string;
}

/**
 * Read-only PuppetDB access. Any method may reject with
 * PuppetDbUnavailableError; callers must render an explicit degraded state
 * rather than an empty table.
 */
export interface IPuppetDbClient {
  health(): Promise<PuppetDbHealth>;
  listNodes(filter: NodeFilter, page: PageRequest): Promise<Page<PuppetNode>>;
  getNode(certname: string): Promise<PuppetNode | null>;
  /** Full fact set for one node — not the projected subset. */
  getFacts(certname: string): Promise<Record<string, unknown>>;
  /**
   * Named facts across the WHOLE estate, for the projector. One paged query
   * instead of one request per node.
   */
  listFacts(factNames: readonly string[], page: PageRequest): Promise<Page<FactRow>>;
  listReports(certname: string, page: PageRequest): Promise<Page<PuppetReport>>;
  getReport(hash: string): Promise<PuppetReport | null>;
  /** Resource events for one report — the failure-triage view. */
  getReportEvents(hash: string): Promise<ResourceEvent[]>;
  getReportSummary(hash: string): Promise<ReportSummary | null>;
  listEnvironments(): Promise<string[]>;
}

/** Thrown when PuppetDB cannot be reached or returns an error. */
export class PuppetDbUnavailableError extends Error {
  readonly lastSuccessAt: string | null;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options: { lastSuccessAt?: string | null; statusCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PuppetDbUnavailableError';
    this.lastSuccessAt = options.lastSuccessAt ?? null;
    this.statusCode = options.statusCode;
  }
}
