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

/**
 * One fact condition on a node query (#243).
 *
 * The operator vocabulary is deliberately the SAME set classification rules
 * use, so an operator learns one grammar rather than two — and a filter that
 * finds a set of nodes reads like the rule that would classify them.
 */
export const factFilterOperatorSchema = z.enum([
  'EQUALS',
  'NOT_EQUALS',
  'MATCHES_REGEX',
  'IN',
  'EXISTS',
  'NOT_EXISTS',
]);
export type FactFilterOperator = z.infer<typeof factFilterOperatorSchema>;

export const factFilterSchema = z
  .object({
    /**
     * Dotted path into the structured fact, e.g. `os.release.major`.
     *
     * Validated to a conservative grammar, NOT because PQL is built by string
     * concatenation — it is not, PqlBuilder emits an AST — but because this
     * path becomes a FIELD NAME in that AST rather than a bound value, and a
     * field name is the one place a typed builder cannot protect (ADR-0004).
     */
    path: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/, 'Use dotted names, e.g. os.release.major'),
    operator: factFilterOperatorSchema,
    /** Absent for EXISTS / NOT_EXISTS; an array only for IN. */
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  })
  .refine(
    (f) =>
      f.operator === 'EXISTS' || f.operator === 'NOT_EXISTS'
        ? f.value === undefined
        : f.value !== undefined,
    { message: 'This operator requires a value; EXISTS and NOT_EXISTS take none.' },
  )
  .refine((f) => (f.operator === 'IN' ? Array.isArray(f.value) : !Array.isArray(f.value)), {
    message: 'IN takes an array; every other operator takes a single value.',
  });
export type FactFilter = z.infer<typeof factFilterSchema>;

export const nodeFilterSchema = z.object({
  /**
   * Fact conditions, ANDed together (#243).
   *
   * Answers "which nodes are Ubuntu 22.04", which nothing could before: the
   * node list filtered by certname, environment, status and staleness only, and
   * a classification group could report a COUNT but never the nodes.
   */
  facts: z.array(factFilterSchema).max(10).optional(),
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

  /**
   * How many resources match, asked BEFORE any are fetched (ADR-0025 §10).
   *
   * A thousand nodes at several hundred resources each is millions of rows.
   * Asking first turns "the browser stopped responding" into a sentence the
   * operator can act on.
   */
  countResources(filter: ResourceFilter): Promise<number>;

  /**
   * Resources matching the filter, WITHOUT their parameters (ADR-0025 §4).
   *
   * The omission is a disclosure control, not an optimisation: a value never
   * fetched cannot leak through a rendering bug, a log line, or an error page.
   */
  searchResources(filter: ResourceFilter, page: PageRequest): Promise<Page<ResourceSummary>>;

  /**
   * One resource's parameters, for named nodes only (ADR-0025 §9).
   *
   * THE ONLY METHOD HERE THAT RETURNS PARAMETERS. Callers pass an explicit,
   * short list of certnames — one representative per variant — so this can
   * never become a bulk export of the estate's configuration by widening a
   * filter.
   */
  getResourceParameters(
    type: string,
    title: string,
    certnames: readonly string[],
  ): Promise<ResourceParameters[]>;
}

/**
 * A catalog resource WITHOUT its parameters (ADR-0025 §4).
 *
 * The absence is the point. `parameters` carries the configuration payload —
 * a `File`'s `content` is the entire file body, and a class parameter may hold
 * a credential — so it never travels in a list. It is fetched only when an
 * operator expands one resource, which is an audited act (ADR-0025 §6).
 */
export interface ResourceSummary {
  certname: string;
  type: string;
  title: string;
  /** Manifest that declared it, and the line. Both null on older agents. */
  file: string | null;
  line: number | null;
  environment: string;
  /**
   * PuppetDB's SHA-1 over type, title AND parameters.
   *
   * Two nodes sharing this hash have byte-identical parameters, which is what
   * lets consistency be established without a parameter crossing the wire
   * (ADR-0025 §7). If this ever stopped covering parameters, the consistency
   * view would report agreement that does not exist.
   */
  resourceHash: string;
  /** Collected from another node's exported catalog rather than declared here. */
  exported: boolean;
  tags: string[];
}

/** One distinct parameter-set among the nodes carrying a resource. */
export interface ResourceVariant {
  /** The `resource` hash shared by every node in this variant. */
  resourceHash: string;
  nodeCount: number;
  /**
   * One node carrying it — the node whose parameters get fetched on expand
   * (ADR-0025 §9). One per variant, never one per node.
   */
  sampleCertname: string;
  /** Up to a bounded number of certnames, for "which nodes are the odd ones". */
  certnames: string[];
}

/**
 * A resource across the estate, grouped for the consistency question.
 *
 * Keyed by type, title AND environment — variance is counted WITHIN an
 * environment and never across it (ADR-0025 §8). A development node differing
 * from a production node is not drift, and counting it as such would flag the
 * whole estate as inconsistent on the first day.
 */
export interface ResourceGroup {
  type: string;
  title: string;
  environment: string;
  nodeCount: number;
  /** Distinct parameter-sets. Greater than one means the nodes disagree. */
  variantCount: number;
  variants: ResourceVariant[];
  /** Where it was declared, from the first node seen. Null on older agents. */
  file: string | null;
  line: number | null;
}

/**
 * One node's parameters for one resource (ADR-0025 §9).
 *
 * THE DISCLOSURE. `parameters` is the configuration payload — a `File`'s
 * `content` is the whole file body, and a class parameter may hold a
 * credential. Fetching this is an audited act (§6); nothing else in the
 * resource surface returns it.
 */
export interface ResourceParameters {
  certname: string;
  resourceHash: string;
  parameters: Record<string, unknown>;
}

/**
 * What an expanded resource shows: one representative per variant, diffed.
 *
 * ONE PER VARIANT, never one per node (§9). Bounded by variant count — usually
 * two or three — rather than by the hundreds of nodes carrying it, and it
 * answers the question actually being asked: how do these DIFFER.
 */
export interface ResourceComparison {
  type: string;
  title: string;
  environment: string;
  /** In the same order the group lists them: baseline first. */
  variants: ResourceParameters[];
  /**
   * Parameter names whose value is not identical across every variant.
   *
   * Computed server-side so the UI cannot disagree with itself about what
   * "differs" means, and so a single variant trivially yields none.
   */
  differingKeys: string[];
}

/**
 * How a resource search is narrowed.
 *
 * `type` is REQUIRED (ADR-0025 §10). A search with no type is the estate's
 * entire catalog, and this mirrors the rule already applied to facts: an empty
 * allow-list fetches nothing rather than everything.
 */
export const resourceFilterSchema = z.object({
  /** Capitalised resource type, e.g. `File`. Required — there is no "all". */
  type: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Z][A-Za-z0-9_]*(::[A-Z][A-Za-z0-9_]*)*$/,
      'A resource type, e.g. File or Nginx::Config',
    ),
  /** Exact resource title, e.g. `/etc/ssh/sshd_config`. */
  title: z.string().max(1024).optional(),
  /** Substring of the title, for when the exact path is not known. */
  titleContains: z.string().max(1024).optional(),
  /** Restrict to nodes in these environments. */
  environments: z.array(z.string()).max(50).optional(),
  /** Restrict to nodes matching these facts — the #243 filter, composed in. */
  facts: z.array(factFilterSchema).max(10).optional(),
  /**
   * Conditions on parameter VALUES (ADR-0025 §5).
   *
   * A disclosure oracle, and knowingly so: a holder can confirm a secret by
   * guessing without any value being rendered. That is why `resources:read` is
   * a separate, privileged grant and why using this writes an audit row.
   */
  parameters: z.array(factFilterSchema).max(10).optional(),
  exported: z.boolean().optional(),
});
export type ResourceFilter = z.infer<typeof resourceFilterSchema>;

/**
 * A filter somebody kept (ADR-0026).
 *
 * THE FIRST PER-USER OBJECT in the product. Node groups, roles and settings are
 * global, so "mine" and "shared" are new concepts here rather than an
 * established pattern being reused — which is why the visibility rules are
 * written down rather than inferred.
 */
export const savedQueryKindSchema = z.enum(['node', 'resource']);
export type SavedQueryKind = z.infer<typeof savedQueryKindSchema>;

/**
 * The filter a saved query holds, discriminated by `kind`.
 *
 * ONE CONCEPT, TWO SHAPES. Two tables would mean duplicate UI, duplicate
 * sharing rules, and a second answer to every lifecycle question here.
 */
export const savedQueryFilterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), filter: nodeFilterSchema }),
  z.object({ kind: z.literal('resource'), filter: resourceFilterSchema }),
]);
export type SavedQueryFilter = z.infer<typeof savedQueryFilterSchema>;

export interface SavedQuery {
  id: string;
  name: string;
  kind: SavedQueryKind;
  /** A NodeFilter or a ResourceFilter, per `kind`. Never raw PQL (ADR-0004). */
  filter: unknown;
  isShared: boolean;
  /**
   * Who made it. Denormalised, so a shared query outlives its author's account
   * — the same reason `AuditLog` keeps `actorEmail`.
   */
  ownerEmail: string;
  /** True when the caller owns it. Decided server-side; the UI must not guess. */
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}

export const createSavedQuerySchema = z
  .object({
    name: z.string().min(1).max(120),
    /**
     * PRIVATE BY DEFAULT. Sharing is a deliberate act — it changes who can see
     * what somebody is watching, and a default that shares would make that
     * decision by omission.
     */
    isShared: z.boolean().default(false),
  })
  .and(savedQueryFilterSchema);
export type CreateSavedQuery = z.infer<typeof createSavedQuerySchema>;

export const updateSavedQuerySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  isShared: z.boolean().optional(),
});
export type UpdateSavedQuery = z.infer<typeof updateSavedQuerySchema>;

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
