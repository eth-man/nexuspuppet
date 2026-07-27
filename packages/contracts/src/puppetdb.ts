import { z } from 'zod';

/**
 * PuppetDB access contract (ADR-0004).
 *
 * PuppetDB is READ-ONLY. There is no command/write surface in this interface
 * and none may be added — deactivating nodes or submitting facts is not
 * NexusPuppet's business.
 *
 * Note the absence of any `query(pql: string)` method taking caller-supplied
 * PQL. The mTLS client certificate is estate-wide, so the API is a confused
 * deputy by construction; callers pass typed filters and the implementation
 * builds parameterised PQL. Raw PQL is an admin-only, audited endpoint that
 * does not route through this interface.
 */

export const nodeStatusSchema = z.enum(['CHANGED', 'UNCHANGED', 'FAILED', 'NORESPONSE', 'UNKNOWN']);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const puppetNodeSchema = z.object({
  certname: z.string(),
  environment: z.string().nullable(),
  /** ISO-8601 */
  reportTimestamp: z.string().nullable(),
  factsTimestamp: z.string().nullable(),
  catalogTimestamp: z.string().nullable(),
  latestReportStatus: nodeStatusSchema,
  expired: z.boolean(),
});
export type PuppetNode = z.infer<typeof puppetNodeSchema>;

export const nodeFilterSchema = z.object({
  certnameContains: z.string().max(255).optional(),
  environments: z.array(z.string()).optional(),
  statuses: z.array(nodeStatusSchema).optional(),
  /** Nodes with no report newer than this ISO-8601 instant. */
  staleBefore: z.string().datetime().optional(),
});
export type NodeFilter = z.infer<typeof nodeFilterSchema>;

/**
 * Server-driven pagination. A 10,000-row inventory must never be shipped to the
 * browser in one response (ADR-0008).
 */
export const pageRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
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

export const resourceEventSchema = z.object({
  status: z.enum(['success', 'failure', 'noop', 'skipped']),
  resourceType: z.string(),
  resourceTitle: z.string(),
  property: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  message: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
});
export type ResourceEvent = z.infer<typeof resourceEventSchema>;

export const puppetReportSchema = z.object({
  hash: z.string(),
  certname: z.string(),
  environment: z.string().nullable(),
  status: nodeStatusSchema,
  noop: z.boolean(),
  puppetVersion: z.string().nullable(),
  configurationVersion: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  /** Seconds. */
  duration: z.number().nullable(),
});
export type PuppetReport = z.infer<typeof puppetReportSchema>;

export interface PuppetDbHealth {
  reachable: boolean;
  /** ISO-8601 of the last successful query, for the degraded-state UI (ADR-0004). */
  lastSuccessAt: string | null;
  version: string | null;
  error?: string;
}

/**
 * Read-only PuppetDB access. All methods may reject with PuppetDbUnavailable;
 * callers must render an explicit degraded state rather than an empty table.
 */
export interface IPuppetDbClient {
  health(): Promise<PuppetDbHealth>;
  listNodes(filter: NodeFilter, page: PageRequest): Promise<Page<PuppetNode>>;
  getNode(certname: string): Promise<PuppetNode | null>;
  /** Full fact set for one node — not the projected subset. */
  getFacts(certname: string): Promise<Record<string, unknown>>;
  listReports(certname: string, page: PageRequest): Promise<Page<PuppetReport>>;
  getReport(hash: string): Promise<PuppetReport | null>;
  /** Resource events for one report — the failure-triage view. */
  getReportEvents(hash: string): Promise<ResourceEvent[]>;
  listEnvironments(): Promise<string[]>;
}

/** Thrown when PuppetDB cannot be reached or returns an error. */
export class PuppetDbUnavailableError extends Error {
  readonly lastSuccessAt: string | null;
  constructor(message: string, lastSuccessAt: string | null = null) {
    super(message);
    this.name = 'PuppetDbUnavailableError';
    this.lastSuccessAt = lastSuccessAt;
  }
}
