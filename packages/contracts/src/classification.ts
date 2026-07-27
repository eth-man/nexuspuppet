import { z } from 'zod';
import {
  certnameSchema,
  matchStrategySchema,
  nodeRuleSchema,
  puppetClassNameSchema,
  puppetValueSchema,
  type ClassificationConflict,
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
