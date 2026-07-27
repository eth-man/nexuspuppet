import type {
  ClassificationConflict,
  EncDocument,
  MergeResult,
  PuppetValue,
} from '@nexuspuppet/contracts';

/**
 * Pure reduction of N matched groups to the single ENC document Puppet accepts
 * (ADR-0009).
 *
 * Merge rules, in full:
 *   - Class inclusion .......... union
 *   - Class parameters ......... last writer wins, per key
 *   - Top-scope parameters ..... last writer wins, per key
 *   - Environment .............. last writer wins; a group with no environment
 *                                does not clear an earlier one
 *   - Nested values ............ REPLACED WHOLESALE, never deep-merged
 *
 * The no-deep-merge rule is deliberate. Deep merging makes a parameter's
 * effective value a function of every group in the chain, so an operator
 * reading one group cannot know what a node will receive, and removing a nested
 * key becomes impossible without a sentinel. Hiera exists for layered data
 * composition and does it properly; the ENC's job is classification.
 */

export interface MergeableGroup {
  id: string;
  name: string;
  environment: string | null;
  /** className -> parameter map */
  classes: Record<string, Record<string, PuppetValue>>;
  /** top-scope parameters */
  parameters: Record<string, PuppetValue>;
}

/** Tracks which group last set a key, so conflicts can name both sides. */
interface Provenance {
  groupId: string;
  groupName: string;
  value: PuppetValue;
}

/**
 * @param groups Matched groups ALREADY in merge order (rank ASC, id ASC).
 *               Ordering is the caller's responsibility — see matchGroups().
 */
export function mergeGroups(groups: readonly MergeableGroup[]): MergeResult {
  const classes: Record<string, Record<string, PuppetValue>> = {};
  const parameters: Record<string, PuppetValue> = {};
  const conflicts: ClassificationConflict[] = [];

  // key -> who set it last
  const classParamProvenance = new Map<string, Provenance>();
  const paramProvenance = new Map<string, Provenance>();
  let environment: string | undefined;
  let environmentProvenance: Provenance | undefined;

  for (const group of groups) {
    for (const [className, params] of Object.entries(group.classes)) {
      // Union: a class assigned by any matched group is included, even with no
      // parameters of its own.
      classes[className] ??= {};
      const target = classes[className];

      for (const [paramKey, value] of Object.entries(params)) {
        const provenanceKey = `${className}.${paramKey}`;
        const previous = classParamProvenance.get(provenanceKey);

        if (previous !== undefined && !valuesEqual(previous.value, value)) {
          conflicts.push({
            kind: 'CLASS_PARAMETER',
            key: provenanceKey,
            winningGroupId: group.id,
            winningGroupName: group.name,
            winningValue: value,
            losingGroupId: previous.groupId,
            losingGroupName: previous.groupName,
            losingValue: previous.value,
          });
        }

        target[paramKey] = value;
        classParamProvenance.set(provenanceKey, {
          groupId: group.id,
          groupName: group.name,
          value,
        });
      }
    }

    for (const [key, value] of Object.entries(group.parameters)) {
      const previous = paramProvenance.get(key);

      if (previous !== undefined && !valuesEqual(previous.value, value)) {
        conflicts.push({
          kind: 'TOP_SCOPE_PARAMETER',
          key,
          winningGroupId: group.id,
          winningGroupName: group.name,
          winningValue: value,
          losingGroupId: previous.groupId,
          losingGroupName: previous.groupName,
          losingValue: previous.value,
        });
      }

      parameters[key] = value;
      paramProvenance.set(key, { groupId: group.id, groupName: group.name, value });
    }

    // A null/absent environment does not clear an earlier one.
    if (group.environment !== null && group.environment !== '') {
      if (
        environmentProvenance !== undefined &&
        environmentProvenance.value !== group.environment
      ) {
        conflicts.push({
          kind: 'ENVIRONMENT',
          key: 'environment',
          winningGroupId: group.id,
          winningGroupName: group.name,
          winningValue: group.environment,
          losingGroupId: environmentProvenance.groupId,
          losingGroupName: environmentProvenance.groupName,
          losingValue: environmentProvenance.value,
        });
      }
      environment = group.environment;
      environmentProvenance = {
        groupId: group.id,
        groupName: group.name,
        value: group.environment,
      };
    }
  }

  // Built conditionally because `exactOptionalPropertyTypes` distinguishes an
  // absent key from one explicitly set to undefined — and Puppet does too.
  const document: EncDocument =
    environment === undefined ? { classes, parameters } : { classes, parameters, environment };

  return {
    document,
    conflicts,
    appliedGroupIds: groups.map((g) => g.id),
  };
}

/**
 * Structural equality, used only to decide whether an override is a genuine
 * conflict worth reporting. Re-setting a key to the same value is not a
 * conflict and must not generate UI noise.
 */
function valuesEqual(a: PuppetValue, b: PuppetValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => valuesEqual(item, b[i] as PuppetValue));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) =>
      valuesEqual(a[k] as PuppetValue, (b as Record<string, PuppetValue>)[k] as PuppetValue),
    );
  }

  return false;
}
