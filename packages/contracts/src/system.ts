import { z } from 'zod';

/**
 * Operational status of a running deployment.
 *
 * NOT the liveness probe. `/healthz` answers "is the process up?" for a load
 * balancer, is unauthenticated, and must stay dependency-free. This answers "is
 * the deployment doing its job?", requires a session, and reads the database.
 * Merging them would either leak estate information to anything that can reach
 * the port, or make a liveness check expensive.
 *
 * WHY THIS EXISTS. Every mechanism in this product that protects against silent
 * failure — the materialization outbox, audit delivery retries, the projected
 * fact allow-list — reports trouble by writing a log line and then waiting. A
 * permanently failed materialization is the worst of them: the job is retained
 * with status FAILED, nothing ever retries it, and the node keeps its previous
 * classification indefinitely. The only trace is one ERROR at the time and a row
 * nobody queries. This surface exists so a stranded node is visible rather than
 * discovered.
 */

/**
 * Error detail is ADMIN-only.
 *
 * A materialization error carries filesystem paths; an audit delivery error
 * carries the collector's hostname and sometimes a token endpoint. Those are
 * infrastructure facts that should not reach a VIEWER through a dashboard card,
 * so the counts are visible to everyone who may read the inventory and the
 * strings are not.
 */
export const failureDetailSchema = z.object({
  certname: z.string().nullable(),
  reason: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  failedAt: z.string().nullable(),
});
export type FailureDetail = z.infer<typeof failureDetailSchema>;

/**
 * Named "health" rather than "status" because `MaterializationStatus` is
 * already the per-job lifecycle enum in enc.ts. Two different meanings of
 * status in one contracts package is how a caller ends up importing the wrong
 * one and being confused about why it has no `pending`.
 */
export const materializationHealthSchema = z.object({
  /** Queued and waiting. A number that rises and falls is healthy. */
  pending: z.number().int(),
  /**
   * Exhausted every attempt and abandoned.
   *
   * The one unambiguously bad number here. Each is a node whose ENC file could
   * not be written and which is therefore running its previous classification,
   * permanently, with nothing scheduled to fix it.
   */
  failed: z.number().int(),
  /**
   * When the oldest queued job became due. ISO-8601, or null when idle.
   *
   * Oldest DUE rather than oldest created: `(status, nextAttemptAt)` is indexed
   * and `createdAt` is not, and "what is overdue" is the more useful question.
   */
  oldestDueAt: z.string().nullable(),
  /** ADMIN only; empty for everyone else. */
  failures: z.array(failureDetailSchema),
});

export const auditDeliveryHealthSchema = z.object({
  /** False when no transport is installed — core forwards audit records nowhere. */
  configured: z.boolean(),
  transport: z.string(),
  pending: z.number().int(),
  oldestDueAt: z.string().nullable(),
  /** ADMIN only; empty for everyone else. */
  failures: z.array(failureDetailSchema),
});

export const projectionHealthSchema = z.object({
  nodes: z.number().int(),
  /** Staleness: the least recently refreshed node. Null on an empty estate. */
  oldestProjectedAt: z.string().nullable(),
  /**
   * Projected facts that NO node reports.
   *
   * A classification rule against one of these can never match, and nothing
   * about the group would look wrong. Empty is the healthy answer; anything
   * here is a configuration error waiting to be blamed on the rule engine.
   */
  factsNoNodeReports: z.array(z.string()),
});

export const systemStatusSchema = z.object({
  materialization: materializationHealthSchema,
  /** Absent when the deployment has no audit transport installed. */
  auditDelivery: auditDeliveryHealthSchema.optional(),
  projection: projectionHealthSchema,
  /** Whether this response includes error detail, so the UI need not guess. */
  includesDetail: z.boolean(),
});

export type MaterializationHealth = z.infer<typeof materializationHealthSchema>;
export type AuditDeliveryHealth = z.infer<typeof auditDeliveryHealthSchema>;
export type ProjectionHealth = z.infer<typeof projectionHealthSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
