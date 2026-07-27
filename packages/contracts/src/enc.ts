import { z } from 'zod';

/**
 * The ENC domain contract.
 *
 * These types describe what NexusPuppet materializes to disk for puppetserver
 * to read (ADR-0003) and how matched groups are reduced to a single document
 * (ADR-0009). They are shared between the API (which produces them) and the web
 * tier (which explains them to operators).
 */

/** Puppet class/identifier grammar: `foo`, `foo::bar`, `foo::bar::baz`. */
export const PUPPET_CLASS_NAME = /^[a-z][a-z0-9_]*(::[a-z][a-z0-9_]*)*$/;

export const puppetClassNameSchema = z
  .string()
  .regex(PUPPET_CLASS_NAME, 'Not a valid Puppet class name (e.g. profile::base)');

/** A certname as Puppet reports it. */
export const certnameSchema = z.string().min(1).max(255);

/**
 * Operators available to fact-matching rules.
 * Kept deliberately small: every operator here must be implementable as a pure,
 * total function over a JSON fact value, with no surprising coercion.
 */
export const ruleOperatorSchema = z.enum([
  'EQUALS',
  'NOT_EQUALS',
  'MATCHES_REGEX',
  'NOT_MATCHES_REGEX',
  'IN',
  'NOT_IN',
  'GREATER_THAN',
  'LESS_THAN',
  'EXISTS',
  'NOT_EXISTS',
]);
export type RuleOperator = z.infer<typeof ruleOperatorSchema>;

/**
 * A single matching rule. `factPath` is a dotted path into the projected fact
 * subset, e.g. `os.family` or `networking.domain`.
 */
export const nodeRuleSchema = z.object({
  factPath: z.string().min(1).max(512),
  operator: ruleOperatorSchema,
  /** Absent for EXISTS / NOT_EXISTS. */
  value: z.unknown().optional(),
});
export type NodeRule = z.infer<typeof nodeRuleSchema>;

export const matchStrategySchema = z.enum(['ALL_RULES', 'ANY_RULE', 'PINNED']);
export type MatchStrategy = z.infer<typeof matchStrategySchema>;

/** Class parameter values are genuinely schemaless — Puppet accepts any YAML scalar/collection. */
export const puppetValueSchema: z.ZodType<PuppetValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(puppetValueSchema),
    z.record(z.string(), puppetValueSchema),
  ]),
);
export type PuppetValue =
  string | number | boolean | null | PuppetValue[] | { [key: string]: PuppetValue };

/**
 * The document written to `${ENC_OUTPUT_DIR}/nodes/<certname>.yaml`.
 * Shape is dictated by Puppet's ENC contract, not by us.
 */
export const encDocumentSchema = z.object({
  classes: z.record(puppetClassNameSchema, z.record(z.string(), puppetValueSchema)),
  parameters: z.record(z.string(), puppetValueSchema),
  environment: z.string().optional(),
});
export type EncDocument = z.infer<typeof encDocumentSchema>;

/**
 * A value one group set and a higher-ranked group overwrote (ADR-0009).
 * Conflicts are warnings, never errors — base-plus-override is a legitimate
 * pattern — but they must be visible rather than silent.
 */
export interface ClassificationConflict {
  kind: 'CLASS_PARAMETER' | 'TOP_SCOPE_PARAMETER' | 'ENVIRONMENT';
  /** e.g. `profile::base.ntp_servers`, or the bare parameter name. */
  key: string;
  winningGroupId: string;
  winningGroupName: string;
  winningValue: PuppetValue;
  losingGroupId: string;
  losingGroupName: string;
  losingValue: PuppetValue;
}

/** What the merger returns: the document plus an explanation of how it got there. */
export interface MergeResult {
  document: EncDocument;
  conflicts: ClassificationConflict[];
  /** Matched groups in applied order (rank ASC, id ASC). */
  appliedGroupIds: string[];
}

export const materializationStatusSchema = z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'FAILED']);
export type MaterializationStatus = z.infer<typeof materializationStatusSchema>;

/**
 * Writes ENC documents to the shared volume. The ONLY component permitted to
 * touch the ENC output directory. Implementations must write atomically
 * (tmp file + rename) so puppetserver can never read a partial document.
 */
export interface IEncFileWriter {
  /** @returns true if the file changed, false if content was already identical. */
  writeNode(certname: string, yaml: string, contentHash: string): Promise<boolean>;
  removeNode(certname: string): Promise<void>;
  writeDefault(yaml: string): Promise<void>;
  listMaterializedCertnames(): Promise<string[]>;
}
