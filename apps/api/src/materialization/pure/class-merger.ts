import type {
  ClassificationConflict,
  EncDocument,
  KeyAttribution,
  MergeAttribution,
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

  /*
   * Attribution (#141). The provenance maps below already know who set what —
   * this keeps it rather than discarding everything except the disagreements.
   *
   * Conflicts answer "what disagreed". This answers "where is this line from",
   * which is the question asked far more often and previously needed opening
   * every group in turn and re-deriving the merge by hand.
   */
  const attribution: MergeAttribution = {
    classes: {},
    classParameters: {},
    parameters: {},
    environment: null,
  };

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

      // Union, so every group that names the class contributed and none lost.
      // Guarded against a group listing the same class twice.
      const includedBy = (attribution.classes[className] ??= []);
      if (!includedBy.includes(group.id)) includedBy.push(group.id);

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
        attribution.classParameters[provenanceKey] = beat(
          attribution.classParameters[provenanceKey],
          group.id,
          previous,
        );
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
      attribution.parameters[key] = beat(attribution.parameters[key], group.id, previous);
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
      attribution.environment = beat(attribution.environment, group.id, environmentProvenance);
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
    attribution,
  };
}

/**
 * Record that `groupId` now owns a key, and that `previous` was overridden.
 *
 * Accumulates across the whole merge rather than keeping only the last loser,
 * so a key set by four groups names all four — and it records an override even
 * when the values were EQUAL. Those are not conflicts, but the earlier group
 * did still set it, and answering "who set this?" with only the winner would be
 * a half-truth. The value travels with the entry so the console can say whether
 * it actually differed.
 */
function beat(
  existing: KeyAttribution | null | undefined,
  groupId: string,
  previous: Provenance | undefined,
): KeyAttribution {
  const overridden = existing?.overridden ?? [];

  return {
    groupId,
    overridden:
      previous === undefined
        ? overridden
        : [...overridden, { groupId: previous.groupId, value: previous.value }],
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
