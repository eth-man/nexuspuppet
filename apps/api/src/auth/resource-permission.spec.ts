import { SEEDED_BUILT_IN_PERMISSIONS } from './rbac.policy';

/*
 * Who may read catalog resources, and their parameters (ADR-0025 §3).
 *
 * Pinned in a test because this is a SECURITY BOUNDARY that reads like an
 * ordinary line in a list. `resources:read` grants effective read of managed
 * file contents and of credentials passed as class parameters — including by
 * oracle, since filtering on a parameter value discloses it without rendering
 * it (§5). Adding it to VIEWER would be a one-word diff, would look like
 * tidying, and would hand every read-only account the estate's secrets.
 */

describe('who holds resources:read', () => {
  /*
   * VIEWER and OPERATOR are the roles most people actually hold, which is
   * exactly why the disclosure stops above them.
   */
  it.each(['VIEWER', 'OPERATOR'] as const)('%s cannot read resource parameters', (role) => {
    expect(SEEDED_BUILT_IN_PERMISSIONS[role].has('resources:read')).toBe(false);
  });

  /*
   * ADMIN holds it because, when it was introduced, otherwise NOBODY could:
   * creating a custom role then answered 501 without the enterprise layer
   * (ADR-0018), so an unheld permission would have made the feature
   * unreachable rather than merely restricted. Custom roles are always
   * available since ADR-0027; ADMIN keeps it, and the seeded table is pinned.
   */
  it('ADMIN holds it, as seeded when it was introduced', () => {
    expect(SEEDED_BUILT_IN_PERMISSIONS.ADMIN.has('resources:read')).toBe(true);
  });

  /*
   * The split from `inventory:read` is the whole point of §3. If these ever
   * became the same grant, every account that can see a node's IP address
   * could read its managed file contents.
   */
  it('is not the same grant as inventory:read', () => {
    expect(SEEDED_BUILT_IN_PERMISSIONS.VIEWER.has('inventory:read')).toBe(true);
    expect(SEEDED_BUILT_IN_PERMISSIONS.VIEWER.has('resources:read')).toBe(false);
  });
});
