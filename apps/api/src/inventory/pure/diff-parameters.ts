import type { ResourceParameters } from '@nexuspuppet/contracts';

/**
 * Which parameters are not identical across a resource's variants (ADR-0025 §9).
 *
 * PURE: no I/O, no clock, no randomness.
 *
 * Computed HERE rather than in the browser so the answer cannot differ between
 * the number the list showed and the keys the expansion highlights. The list
 * says "2 variants" on the strength of the resource hash; if the UI then
 * decided for itself what "differs" meant and found nothing, the screen would
 * be arguing with itself in front of the operator.
 */

/**
 * Compare by canonical JSON, not by reference or `===`.
 *
 * Parameter values are arbitrary: strings, numbers, booleans, arrays, nested
 * objects. `===` would report every array and object as different on every
 * comparison, which would highlight all of them and highlight nothing.
 *
 * Object keys are SORTED, because `{a:1,b:2}` and `{b:2,a:1}` are the same
 * configuration and Puppet does not promise an order. Reporting them as
 * differing would send somebody to a machine that is fine.
 */
/**
 * A marker for a parameter that is ABSENT, distinct from one set to null.
 *
 * `JSON.stringify(undefined)` is `undefined`, and falling back to `'null'` made
 * a parameter explicitly set to `undef` compare equal to one that was never set
 * at all. Those are different things to Puppet, and the difference is worth
 * seeing: it usually means one node is running older code than the rest.
 *
 * A control character, because it cannot appear in JSON output and so cannot
 * be forged by a parameter whose value happens to be the string "absent".
 */
const ABSENT = '\u0000absent';

function canonical(value: unknown): string {
  if (value === undefined) return ABSENT;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? ABSENT;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function differingKeys(variants: readonly ResourceParameters[]): string[] {
  // One variant cannot differ from itself, and zero cannot differ at all.
  if (variants.length < 2) return [];

  // Every key ANY variant carries. A parameter present on one node and absent
  // on another is a difference — arguably the most interesting kind, since it
  // usually means one node is running older code.
  const keys = new Set<string>();
  for (const variant of variants) {
    for (const key of Object.keys(variant.parameters)) keys.add(key);
  }

  const differing: string[] = [];
  for (const key of keys) {
    const first = canonical(variants[0]?.parameters[key]);
    if (variants.some((variant) => canonical(variant.parameters[key]) !== first)) {
      differing.push(key);
    }
  }

  // Sorted so the same comparison renders identically every time it is opened.
  return differing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
