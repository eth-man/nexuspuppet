import { z } from 'zod';
import { puppetClassNameSchema, type ClassificationConflict } from './enc';

/**
 * "Plan before apply" — what a classification change would do, before it does it.
 *
 * A classifier decides what a thousand machines run, and until now the only way
 * to learn the answer was to save and wait for the next Puppet run. This runs
 * the SAME pipeline the materializer runs — match, merge, render — against the
 * proposed change and returns the difference without writing anything.
 *
 * A FORECAST, NOT A CONTRACT. It is computed against the estate as it is now.
 * If the projection moves between planning and applying — a node checks in, a
 * fact changes — the applied result differs from the reviewed one. Making it a
 * contract would need optimistic locking on the projection, which is a much
 * larger feature; saying so plainly in the UI is the honest alternative.
 */

/**
 * The change being previewed, in the same shape the write endpoints take.
 *
 * Deliberately identical to the apply payloads. If plan and apply took
 * different inputs the plan would stop predicting the apply, which is the only
 * property that makes it worth having.
 */
export const planRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('replace-rules'),
    groupId: z.string().uuid(),
    rules: z.array(
      z.object({
        factPath: z.string().min(1).max(512),
        operator: z.string().min(1),
        value: z.unknown().optional(),
      }),
    ),
  }),
  z.object({
    operation: z.literal('assign-class'),
    groupId: z.string().uuid(),
    // Both fields match assignClassSchema exactly. Naming `params` as
    // `parameters` here would mean the plan took a different body from the
    // write it previews — the divergence this contract exists to prevent.
    //
    // `className` used to be `z.string().min(1)` while the write used
    // puppetClassNameSchema, which is that same divergence in the very next
    // line of the comment claiming to avoid it. The plan accepted names the
    // write rejects, and the preview reached the ENC renderer, whose class-name
    // assertion threw and escaped as a 500 — so an operator who typed
    // `Profile::Monitoring` got "internal server error" from the preview where
    // the write would have said "Not a valid Puppet class name".
    className: puppetClassNameSchema,
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    operation: z.literal('remove-class'),
    groupId: z.string().uuid(),
    // Deliberately permissive, unlike assign-class above. Removing a name never
    // puts it into a rendered document, so it cannot reach the renderer's
    // assertion — and if an invalid name ever did get stored, refusing to
    // preview its removal would leave no way to get rid of it.
    className: z.string().min(1),
  }),
  z.object({
    operation: z.literal('set-parameter'),
    groupId: z.string().uuid(),
    key: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    operation: z.literal('remove-parameter'),
    groupId: z.string().uuid(),
    key: z.string().min(1),
  }),
  z.object({
    operation: z.literal('update-group'),
    groupId: z.string().uuid(),
    rank: z.number().int().optional(),
    environment: z.string().nullable().optional(),
    isEnabled: z.boolean().optional(),
  }),
  z.object({ operation: z.literal('delete-group'), groupId: z.string().uuid() }),
  z.object({
    operation: z.literal('pin'),
    groupId: z.string().uuid(),
    certnames: z.array(z.string().min(1)),
  }),
  z.object({
    operation: z.literal('unpin'),
    groupId: z.string().uuid(),
    certnames: z.array(z.string().min(1)),
  }),
]);
export type PlanRequest = z.infer<typeof planRequestSchema>;

/**
 * The response is a TYPE, not a schema.
 *
 * Zod earns its place on input, where the shape arrives from a caller and must
 * be rejected if wrong. This is produced here and consumed by our own client,
 * so a runtime schema would validate our own output against itself — cost with
 * no failure it could catch.
 */

/**
 * How many nodes changed, and how.
 *
 * `unchanged` is reported deliberately: the most reassuring number in a plan is
 * usually how much it does NOT touch, and content-hash comparison already
 * distinguishes a real change from churn.
 *
 * `added` and `removed` are separated from `changed` because they are the ones
 * that surprise people — a node newly inheriting a class, or quietly losing one.
 */
export interface PlanCounts {
  total: number;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/** One field that differs, named rather than diffed as text. */
export interface PlanFieldChange {
  /** Class name for a class parameter; absent for a top-scope parameter. */
  className?: string;
  key: string;
  before: unknown;
  after: unknown;
}

export interface PlanDiff {
  classesAdded: string[];
  classesRemoved: string[];
  classParameters: PlanFieldChange[];
  parameters: PlanFieldChange[];
  environmentBefore: string | null;
  environmentAfter: string | null;
}

/**
 * A distinct outcome, and the nodes that share it.
 *
 * Grouped by the resulting document's content hash. Four hundred changed nodes
 * usually produce three or four distinct documents, and listing four hundred
 * diffs is a wall nobody reads. The exemplar is a real certname so an operator
 * can go and look at one.
 */
export interface PlanShape {
  count: number;
  exemplar: string;
  /** Up to a bounded sample, for a "which nodes?" affordance. */
  certnames: string[];
  kind: 'added' | 'removed' | 'changed';
  diff: PlanDiff;
}

export interface PlanResponse {
  counts: PlanCounts;
  shapes: PlanShape[];
  /**
   * Conflicts this change INTRODUCES.
   *
   * Only new ones. An estate accumulates pre-existing conflicts, and surfacing
   * all of them on every plan would train operators to scroll past the section
   * that exists to stop them.
   */
  conflictsIntroduced: ClassificationConflict[];
  /** Non-fatal problems — a rule on an unprojected fact, an unknown certname. */
  warnings: string[];
  /**
   * True when the estate is larger than the plan evaluated.
   *
   * A plan that times out is worse than no plan, so evaluation is bounded. A
   * plan that silently sampled would be worse still, so this says so and the UI
   * must show it.
   */
  truncated: boolean;
  /** How many nodes were evaluated, and how many exist. */
  evaluated: number;
  estateSize: number;
}
