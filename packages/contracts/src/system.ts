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

/**
 * The audit forwarding pipeline, as an operator should see it (ADR-0016 §5).
 *
 * Present in EVERY edition, unlike `auditDelivery` above — the unlicensed
 * case is a state to report ("forwarding unavailable, here is the capability"),
 * not a section to omit. A pending queue growing while nothing can send is an
 * operational alarm, and an alarm that renders as an absent field is silent.
 */
export const auditForwardingHealthSchema = z.object({
  /** Whether this deployment can forward at all — the `audit.export` capability. */
  available: z.boolean(),
  active: z.enum(['syslog', 'webhook', 'none']),
  /** Whether the registered transport can send right now. */
  configured: z.boolean(),
  /**
   * The active transport is syslog over UDP: a send clears the queue without
   * proof of receipt, so this deployment cannot show its records arrived.
   */
  unconfirmableDelivery: z.boolean(),
  pending: z.number().int(),
  oldestDueAt: z.string().nullable(),
  /** The most recent delivery attempt's outcome. Null before the first one. */
  lastDelivery: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      delivered: z.number().int(),
      /** ADMIN only — carries the collector's hostname. Null for everyone else. */
      error: z.string().nullable(),
    })
    .nullable(),
});

/** The retention bounds in force, and what the ceiling has cost (ADR-0016 §6). */
export const auditRetentionHealthSchema = z.object({
  ageDays: z.number().int(),
  /** Null when the operator has not opted into a row ceiling. */
  maxRows: z.number().int().nullable(),
  /** Cumulative, recorded by the sweeper in the same transaction as the delete. */
  undeliveredDropped: z.object({
    total: z.number().int(),
    lastDroppedAt: z.string().nullable(),
  }),
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
  auditForwarding: auditForwardingHealthSchema,
  retention: auditRetentionHealthSchema,
  projection: projectionHealthSchema,
  /** Whether this response includes error detail, so the UI need not guess. */
  includesDetail: z.boolean(),
});

export type MaterializationHealth = z.infer<typeof materializationHealthSchema>;
export type AuditDeliveryHealth = z.infer<typeof auditDeliveryHealthSchema>;
export type AuditForwardingHealth = z.infer<typeof auditForwardingHealthSchema>;
export type AuditRetentionHealth = z.infer<typeof auditRetentionHealthSchema>;
export type ProjectionHealth = z.infer<typeof projectionHealthSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;

/**
 * The certificate the console is served with (ADR-0013).
 *
 * Read from the PUBLIC certificate only. The API is given a single `.pem` file
 * and never the directory containing the key, so there is no path by which key
 * material could reach this response, an audit row, or a log line.
 *
 * PROXY-AGNOSTIC BY DESIGN. This reports what is on disk; it does not ask any
 * proxy what it loaded. Operators replace the bundled Caddy with nginx, HAProxy
 * or an appliance, and a status surface that only worked with one of those would
 * be worse than none — it would report "not configured" on a correctly running
 * deployment.
 */
export const certificateSummarySchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  /** The names a browser will match against. */
  subjectAltNames: z.array(z.string()),
  validFrom: z.string(),
  validTo: z.string(),
  /** Negative once expired, so one field answers "how bad is it". */
  daysRemaining: z.number(),
  expired: z.boolean(),
  notYetValid: z.boolean(),
  selfSigned: z.boolean(),
  /**
   * A placeholder this deployment generated for itself, rather than one an
   * operator chose.
   *
   * Both are self-signed and otherwise identical, so the console cannot tell
   * them apart from `selfSigned` alone — and it needs to, because it should say
   * "replace this" about the first and nothing about the second (ADR-0013,
   * self-signed fallback).
   */
  temporary: z.boolean(),
});

export const consoleTlsStatusSchema = z.object({
  /**
   * False when no certificate path is configured — the normal state for a
   * deployment terminating TLS elsewhere, and NOT an error.
   */
  configured: z.boolean(),
  certificate: certificateSummarySchema.nullable(),
  /**
   * Why there is no certificate summary, as something the console can phrase.
   *
   * `error` used to carry the filesystem path, which then appeared in the
   * browser: an end user cannot act on `/etc/nexuspuppet/tls/console.pem` and
   * should not be shown the server's layout to reach that conclusion. The path
   * stays in the API log, where somebody with shell access reads it.
   */
  errorCode: z.enum(['missing', 'unreadable', 'unparsable']).nullable(),

  /** The name operators are expected to reach the console by, if declared. */
  expectedHostname: z.string().nullable(),
  /**
   * Whether the certificate covers that name. Null when either is unknown —
   * distinct from false, which means a mismatch a browser will reject.
   */
  coversExpectedHostname: z.boolean().nullable(),
  /** Why the certificate could not be read. Null when it could. */
  error: z.string().nullable(),
  /**
   * Whether this deployment can install a certificate from the console
   * (ADR-0017).
   *
   * False when no cert-helper is configured — TLS terminates elsewhere, or the
   * tls profile is off. A property of the DEPLOYMENT rather than of the person
   * looking: the console uses it to decide whether to offer the form at all,
   * because a button that can only ever return 503 is worse than no button.
   *
   * Optional, so an older API answering a newer console simply omits it.
   */
  installable: z.boolean().optional(),
});

export type CertificateSummary = z.infer<typeof certificateSummarySchema>;
export type ConsoleTlsStatus = z.infer<typeof consoleTlsStatusSchema>;

/**
 * What this deployment is, and whether its parts are answering.
 *
 * Deliberately cheap: a version string, a clock, and one round trip to the
 * database. An operator opening Settings should not cause work.
 */
export const deploymentInfoSchema = z.object({
  version: z.string(),
  /** When this API process started, so uptime is derived rather than stored. */
  startedAt: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  database: z.object({
    connected: z.boolean(),
    /** Round-trip time of the health query. Null when it did not answer. */
    latencyMs: z.number().int().nonnegative().nullable(),
  }),
});
export type DeploymentInfo = z.infer<typeof deploymentInfoSchema>;

/**
 * The result of an explicitly requested update check (never automatic).
 *
 * `reachable` is a first-class field rather than an error, because being
 * offline is the NORMAL state for an air-gapped estate and must not read as a
 * fault. Nothing about the deployment is sent in the request.
 */
export const updateCheckSchema = z.object({
  current: z.string(),
  /** Null when the check could not complete. */
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  releaseUrl: z.string().nullable(),
  reachable: z.boolean(),
  /** Why it could not be reached, in words. Null when it succeeded. */
  message: z.string().nullable(),
});
export type UpdateCheck = z.infer<typeof updateCheckSchema>;
