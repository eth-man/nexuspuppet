import { z } from 'zod';
import {
  certnameSchema,
  matchStrategySchema,
  nodeRuleSchema,
  puppetClassNameSchema,
  puppetValueSchema,
  type ClassificationConflict,
  type GroupMatchExplanation,
  type MergeAttribution,
  type CompileReceiptView,
} from './enc';

/**
 * Request and response shapes for classification writes (ADR-0009).
 *
 * Shared with the web tier so the UI validates exactly what the API accepts —
 * there is no second, drifting definition of a node group.
 */

export const nodeGroupNameSchema = z
  .string()
  .min(1)
  .max(128)
  // Names appear in conflict reports and audit entries, where control
  // characters would corrupt the output an operator reads during an incident.
  .regex(/^[\w][\w .:/-]*$/, 'Use letters, digits, and . : / - _ only');

export const createNodeGroupSchema = z.object({
  name: nodeGroupNameSchema,
  description: z.string().max(2000).optional(),
  /** Higher rank is applied later and wins on conflict (ADR-0009). */
  rank: z.number().int().min(0).max(100000).default(100),
  strategy: matchStrategySchema.default('ALL_RULES'),
  environment: z.string().max(128).nullable().default(null),
  isEnabled: z.boolean().default(true),
  parentId: z.string().uuid().nullable().default(null),
});
export type CreateNodeGroup = z.infer<typeof createNodeGroupSchema>;

export const updateNodeGroupSchema = createNodeGroupSchema.partial();
export type UpdateNodeGroup = z.infer<typeof updateNodeGroupSchema>;

/** Rules are replaced as a set, so a rule edit is one atomic change. */
export const replaceRulesSchema = z.object({
  rules: z.array(nodeRuleSchema).max(50),
});
export type ReplaceRules = z.infer<typeof replaceRulesSchema>;

export const assignClassSchema = z.object({
  className: puppetClassNameSchema,
  params: z.record(z.string().max(255), puppetValueSchema).default({}),
});
export type AssignClass = z.infer<typeof assignClassSchema>;

export const setParameterSchema = z.object({
  key: z.string().min(1).max(255),
  value: puppetValueSchema,
});
export type SetParameter = z.infer<typeof setParameterSchema>;

export const addPinsSchema = z.object({
  certnames: z.array(certnameSchema).min(1).max(1000),
});
export type AddPins = z.infer<typeof addPinsSchema>;

/**
 * A fact path a rule can actually match on, discovered from the ManagedNode
 * projection.
 *
 * Sourced from the PROJECTION, not from PuppetDB's full fact set, because that
 * is the only thing rule evaluation reads. A path absent here can never match,
 * so offering PuppetDB's complete fact list would actively mislead — it would
 * suggest paths that are guaranteed to fail (ADR-0004).
 */
export interface FactPathSuggestion {
  /** Dotted path, e.g. `os.family`. */
  path: string;
  /** How many projected nodes carry this path — coverage, so a rule author can
   *  see that a fact exists on 3 of 1,000 nodes before matching on it. */
  nodeCount: number;
  /** One observed value, for orientation. */
  sampleValue: unknown;
  /** Distinct observed values, when the cardinality is low enough to be a
   *  useful picker. Absent for high-cardinality paths like IP addresses. */
  values?: unknown[];
}

export interface FactPathIndex {
  paths: FactPathSuggestion[];
  /** Nodes scanned to build this. Zero means the projection is empty. */
  nodesScanned: number;
}

export interface NodeGroupSummary {
  id: string;
  name: string;
  description: string | null;
  rank: number;
  strategy: z.infer<typeof matchStrategySchema>;
  environment: string | null;
  isEnabled: boolean;
  parentId: string | null;
  ruleCount: number;
  classCount: number;
  pinCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeGroupDetail extends NodeGroupSummary {
  rules: z.infer<typeof nodeRuleSchema>[];
  classes: Array<{ className: string; params: Record<string, unknown> }>;
  parameters: Array<{ key: string; value: unknown }>;
  pinnedCertnames: string[];
}

/**
 * Returned by every write.
 *
 * `materializationQueued` is the honest state: the change is DURABLE but not
 * yet effective. The UI must not report a change as live until the node's
 * materialization confirms it (ADR-0003). Endpoints answer 202, not 200.
 */
export interface ClassificationWriteResult {
  group: NodeGroupDetail;
  materializationQueued: {
    scope: 'nodes' | 'full-reconcile';
    /** Certnames explicitly queued; empty for a full reconcile. */
    certnames: string[];
  };
  /** Non-fatal problems an operator should see, e.g. an unprojected fact path. */
  warnings: string[];
}

/**
 * Why a node is classified the way it is.
 *
 * "Why is this node getting this class?" answerable in one screen was a primary
 * product requirement; this is the payload that answers it.
 */
export interface NodeClassificationExplanation {
  certname: string;
  /** Groups in merge order (rank ASC, id ASC). */
  appliedGroups: Array<{ id: string; name: string; rank: number }>;
  conflicts: ClassificationConflict[];
  /**
   * Where each class, parameter and the environment came from (#141).
   *
   * Optional so a node materialized before this existed reads as "unknown"
   * rather than as "nothing contributed" — the two are different, and the
   * console must not present the second when it means the first.
   */
  attribution?: MergeAttribution;
  /**
   * Why each applied group matched (#142), in the same order as
   * `appliedGroups`.
   *
   * Optional for the same reason as `attribution`: a node materialized before
   * this existed has no reasons recorded, which is different from having
   * matched for no reason.
   */
  matchReasons?: GroupMatchExplanation[];
  /**
   * What each Puppet server reported this node last compiling (ADR-0022).
   *
   * Empty when nothing has reported — which is the normal state until a
   * collector is running, and must read as "not reported" rather than as
   * "behind". One entry per serving Puppet server, so a node compiling against
   * two masters shows both rather than flapping between them.
   */
  compileReceipts?: CompileReceiptView[];
  /**
   * The YAML this node will actually be served (#143).
   *
   * READ FROM DISK, never re-rendered — re-rendering would answer "what would
   * we write now", quietly hiding a file that failed to write or belongs to a
   * classification that has since changed.
   *
   * Null when the node has no file of its own and receives `default.yaml`,
   * which is a valid classification rather than an error.
   */
  document: string | null;
  /** True when `document` is null because the node falls back to default.yaml. */
  usesDefault: boolean;
  /** Null when the node has never been materialized. */
  materialization: {
    contentHash: string;
    revision: number;
    relativePath: string;
    writtenAt: string;
  } | null;
  /** Timestamp of the fact projection the rules were evaluated against. */
  factsAsOf: string | null;
  /** True when a job for this node is queued but not yet applied to disk. */
  pending: boolean;
}
