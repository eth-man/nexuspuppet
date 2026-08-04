/**
 * Comparing two release versions.
 *
 * Pure, and deliberately small: this decides whether to show "an update is
 * available", and the cost of a wrong answer is telling an operator to upgrade
 * a deployment that is already current — or worse, staying silent when it is
 * not. A semver library would be more correct about pre-release ordering and is
 * more than this needs; what it must get right is that 0.10.0 is newer than
 * 0.9.0, which a string comparison gets wrong.
 */

/** `v1.2.3`, `1.2.3`, `1.2.3-rc.1` → [1, 2, 3]. Null when it is not a version. */
export function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `latest` is strictly newer than `current`.
 *
 * Unparseable input answers FALSE, not true. An unrecognised tag upstream —
 * `nightly`, a date stamp, a typo — must not turn into a permanent "update
 * available" badge that an operator can do nothing about.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a === null || b === null) return false;

  for (let i = 0; i < 3; i += 1) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left !== right) return left > right;
  }
  return false;
}
