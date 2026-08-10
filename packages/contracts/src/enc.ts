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
/**
 * How one rule evaluated against a node's projected facts (#142).
 *
 * `actual` is the value the rule was judged against — from the ManagedNode
 * PROJECTION, not from PuppetDB live (ADR-0004). Those differ: a node can
 * report something today that the projection has not caught up with, and the
 * classification on disk was decided by the projection. `factsAsOf` on the
 * explanation is the timestamp this value belongs to.
 */
export interface EvaluatedRule {
  factPath: string;
  operator: RuleOperator;
  /** Absent for EXISTS / NOT_EXISTS. */
  expected?: unknown;
  /** What the projection held. Undefined when the path resolved to nothing. */
  actual?: unknown;
  /**
   * The fact path resolved to nothing.
   *
   * Worth surfacing even on a group that matched, because a path outside the
   * projected allow-list is indistinguishable from a genuinely absent fact —
   * so a rule can look deliberate and be permanently unsatisfiable.
   */
  factMissing: boolean;
  matched: boolean;
}

/**
 * Why a group applied to a node (#142).
 *
 * The Classification tab could say WHICH groups applied and in what order, but
 * not why any of them did — which meant reading the rules, then the node's
 * facts, then evaluating the match by hand, against a projection that may not
 * match what the node reports now.
 */
export interface GroupMatchExplanation {
  groupId: string;
  strategy: MatchStrategy;
  /**
   * Every rule and how it evaluated. Empty for a PINNED group, which has no
   * rules to inspect — and where "pinned" is itself the whole answer.
   */
  rules: EvaluatedRule[];
}

/**
 * Which group put a value in the document, and which groups it beat (#141).
 *
 * GROUP IDS ONLY, never names. `explain()` already loads the applied groups to
 * render them in merge order, so a name costs nothing to resolve at read time
 * — and a stored name goes stale the moment somebody renames the group, which
 * is exactly when an operator is most likely to be reading this.
 *
 * It also keeps the stored blob small: one id per contributor rather than an
 * id and a name, on every key, on every node.
 */
export interface KeyAttribution {
  /** The group whose value is in the document. */
  groupId: string;
  /**
   * Earlier setters, in merge order, that this one overrode.
   *
   * Includes groups that set the SAME value. They were still overridden, and
   * hiding them would answer "who set this?" with a half-truth — the console
   * can say whether the value differed, because the value is here.
   */
  overridden: Array<{ groupId: string; value: PuppetValue }>;
}

/**
 * Where every part of a node's classification came from (#141).
 *
 * The merge already computes this to detect conflicts and then discards it,
 * keeping only the keys where values DIFFERED. Conflicts answer "what
 * disagreed"; this answers "where is this line from", which is the question
 * asked far more often.
 */
export interface MergeAttribution {
  /**
   * className -> the groups that included it, in merge order.
   *
   * A list rather than a winner: class inclusion is a UNION (ADR-0009), so
   * every group named here contributed and none of them lost.
   */
  classes: Record<string, string[]>;
  /** `className.paramName` -> who won, and who they beat. */
  classParameters: Record<string, KeyAttribution>;
  parameters: Record<string, KeyAttribution>;
  /** Null when no group set an environment. */
  environment: KeyAttribution | null;
}

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
  /** Where each class, parameter and the environment came from (#141). */
  attribution: MergeAttribution;
}

export const materializationStatusSchema = z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'FAILED']);
export type MaterializationStatus = z.infer<typeof materializationStatusSchema>;

/**
 * Writes ENC documents to the shared volume. The ONLY component permitted to
 * touch the ENC output directory. Implementations must write atomically
 * (tmp file + rename) so puppetserver can never read a partial document.
 */
/**
 * Where materialized classification is stored.
 *
 * Named for the POSIX case it was born in, and kept that way deliberately: an
 * implementation may equally be an object store or a git repository, and
 * renaming a published contract for a better word costs every enterprise build
 * a rebuild for no behavioural gain.
 *
 * IMPLEMENTORS
 * ------------
 * The identifier is a Puppet certname, which originates in a certificate and
 * must be treated as untrusted input. Validating it is the implementation's
 * job, because what is dangerous depends on the medium: `..` traverses a
 * filesystem, and an object store cares about key shape instead. Nothing above
 * this interface validates on your behalf.
 *
 * Writes must be ATOMIC from a reader's point of view. puppetserver reads these
 * concurrently with every agent run, and a half-written document is a failed
 * catalog compilation on a live node.
 *
 * A non-filesystem implementation changes the CONSISTENCY MODEL, not just the
 * destination: puppetserver would pull rather than read a mounted path, so
 * there is a propagation delay between materialization and the ENC seeing it.
 * ADR-0003 already accepts eventual consistency, but that window grows, and
 * enlarging it deserves its own ADR rather than arriving as a side effect.
 */
export interface IEncFileWriter {
  /**
   * Prepare the destination. Called once at boot, before anything is written.
   *
   * On a filesystem this creates directories; elsewhere it might verify a
   * bucket exists or a branch is checkable-out.
   */
  ensureLayout(): Promise<void>;
  /** @returns true if the file changed, false if content was already identical. */
  writeNode(certname: string, yaml: string, contentHash: string): Promise<boolean>;
  removeNode(certname: string): Promise<void>;
  writeDefault(yaml: string): Promise<void>;
  /**
   * Name the tree from inside itself, so the ENC script can say what it served
   * without knowing anything about how the tree got there (ADR-0022 §2).
   *
   * The replication puller already writes this file when it installs a tree it
   * fetched. A deployment that materializes locally — NexusPuppet co-located
   * with puppetserver — has no puller, so without this the tree is anonymous
   * and every compile receipt is silently dropped.
   *
   * The value must be the SAME identity the replication endpoint would serve
   * for this tree, or a receipt would mean one thing on a replicated deployment
   * and another on a co-located one, and "is this node current?" would stop
   * being an equality check.
   */
  writeRevision(revision: string): Promise<void>;
  listMaterializedCertnames(): Promise<string[]>;
  /**
   * Whether the destination can currently be written to.
   *
   * Surfaced as a health signal: a read-only mount is a silent, total failure
   * of classification delivery, and one that only shows up as agents quietly
   * running old catalogues.
   */
  isWritable(): Promise<boolean>;
}

/**
 * One conflict, aggregated across every node it affects (ADR-0009).
 *
 * The per-node view answers "why is this machine configured this way". This
 * answers the question an operator actually arrives with: "is one of my groups
 * silently overriding another, and how much of the estate does that touch".
 */
export interface AggregatedConflict {
  kind: ClassificationConflict['kind'];
  key: string;
  winningGroupId: string;
  winningGroupName: string;
  losingGroupId: string;
  losingGroupName: string;
  /** How many nodes this same override happens on. */
  nodeCount: number;
  /** A few affected nodes, to make it clickable rather than abstract. */
  exampleCertnames: string[];
}

export interface ConflictReport {
  /** Most consequential first — see `aggregateConflicts` for the ordering. */
  conflicts: AggregatedConflict[];
  /** Nodes with at least one conflict. */
  nodesAffected: number;
  /** Nodes materialized at all, so a count means something next to it. */
  nodesMaterialized: number;
}
