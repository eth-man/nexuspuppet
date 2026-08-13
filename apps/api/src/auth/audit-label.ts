/**
 * What an audited entity was CALLED, taken from the payload already recorded.
 *
 * PURE, and derived rather than supplied. Twenty call sites write audit rows;
 * asking each to pass a label would give twenty chances to pass a different
 * one, or none. The `before`/`after` payloads already contain the name in
 * almost every case, so this reads it back out in one place.
 *
 * WHY THE COLUMN EXISTS AT ALL. An audit row outlives the thing it describes.
 * Once a group is deleted, `node_group / 6e7969f8-…` names nothing to the
 * person reading the trail six weeks later, and the id cannot be resolved
 * because the row it pointed at is gone. NetBox stores `object_repr` for the
 * same reason.
 */

/**
 * Fields that name a thing, in the order they should be preferred.
 *
 * `name` first because it is what most entities call their name. `email` above
 * `key` because a user is better identified by their address than by any
 * setting key that happens to share the payload. `certname` for nodes and pins,
 * `className` for class assignments, `key` last as the settings fallback.
 */
const LABEL_FIELDS = ['name', 'email', 'certname', 'className', 'title', 'key'] as const;

/** Longer than the column, so truncation is visible rather than silent. */
const MAX_LABEL = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function labelIn(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  for (const field of LABEL_FIELDS) {
    const value = payload[field];
    // Only strings. A `name` that is an object or a number is not a label
    // anybody would recognise, and coercing it would put "[object Object]" in
    // an audit trail.
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

/**
 * @param before state before the change, if any
 * @param after state after the change, if any
 *
 * AFTER WINS, because a rename should be recorded under the new name — that is
 * what the entity is called from then on, and what somebody searching the trail
 * will type. `before` is the fallback for a deletion, which is precisely the
 * case where the id can no longer be resolved and the label matters most.
 */
export function auditLabel(before: unknown, after: unknown): string | null {
  const label = labelIn(after) ?? labelIn(before);
  if (label === null) return null;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}
