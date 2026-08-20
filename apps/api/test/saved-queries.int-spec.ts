import type { AuthenticatedPrincipal, Permission } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { SavedQueriesService } from '../src/inventory/saved-queries.service';
import { roleIdFor } from './support/roles';

/**
 * Saved queries, against a REAL PostgreSQL (ADR-0026).
 *
 * Two claims here are about what the DATABASE does, and a mock would confirm
 * whatever the code already believes:
 *
 *   - deleting a user drops their PRIVATE queries and keeps their SHARED ones,
 *     which is one `deleteMany` and one `ON DELETE SET NULL` acting together
 *   - a shared query survives its owner with an attributable `ownerEmail`
 *
 * The third — that a shared resource query is INVISIBLE to somebody without
 * `resources:read` — is asserted here rather than in a unit test because it is
 * the security rule, and it depends on rows the query builder actually returns.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(30_000);

/** A policy that grants exactly what it is told to, so tests state the grant. */
const policyGranting = (...granted: Permission[]) => ({
  can: (_p: AuthenticatedPrincipal, permission: Permission) => granted.includes(permission),
});

const CONTEXT = { ipAddress: '10.0.0.1', userAgent: 'jest' };

describe('saved queries (integration)', () => {
  let prisma: PrismaService;

  const principal = (userId: string, email: string): AuthenticatedPrincipal =>
    ({ userId, email, role: 'OPERATOR', roles: ['OPERATOR'] }) as AuthenticatedPrincipal;

  const serviceFor = (...granted: Permission[]) =>
    new SavedQueriesService(prisma, new PrismaAuditSink(prisma), policyGranting(...granted));

  async function makeUser(email: string): Promise<string> {
    const roleId = await roleIdFor(prisma, 'OPERATOR');
    const user = await prisma.user.create({
      data: { email, displayName: email, role: 'OPERATOR', roleId, authSource: 'local' },
    });
    return user.id;
  }

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.savedQuery.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany({ where: { email: { contains: '@saved-queries.test' } } });
  });

  it('keeps a query private by default, and shows it only to its owner', async () => {
    const mine = await makeUser('mine@saved-queries.test');
    const other = await makeUser('other@saved-queries.test');
    const service = serviceFor('inventory:read');

    await service.create(
      {
        kind: 'node',
        name: 'My Ubuntu boxes',
        isShared: false,
        filter: { includeInactive: false },
      },
      principal(mine, 'mine@saved-queries.test'),
      CONTEXT,
    );

    expect(await service.list(principal(mine, 'mine@saved-queries.test'))).toHaveLength(1);
    expect(await service.list(principal(other, 'other@saved-queries.test'))).toHaveLength(0);
  });

  /*
   * §3, AND THE SECURITY RULE. A name is information: "sudoers on the payment
   * boxes" discloses what somebody is watching. So a shared resource query is
   * absent from the list entirely for a caller without `resources:read` — not
   * greyed out, not disabled.
   */
  it('hides a shared RESOURCE query from somebody who cannot run it', async () => {
    const owner = await makeUser('owner@saved-queries.test');
    const viewer = await makeUser('viewer@saved-queries.test');

    await serviceFor('inventory:read', 'resources:read').create(
      {
        kind: 'resource',
        name: 'sudoers on the payment boxes',
        isShared: true,
        filter: { type: 'File', title: '/etc/sudoers' },
      },
      principal(owner, 'owner@saved-queries.test'),
      CONTEXT,
    );

    const asViewer = await serviceFor('inventory:read').list(
      principal(viewer, 'viewer@saved-queries.test'),
    );
    expect(asViewer).toHaveLength(0);

    const asPrivileged = await serviceFor('inventory:read', 'resources:read').list(
      principal(viewer, 'viewer@saved-queries.test'),
    );
    expect(asPrivileged.map((q) => q.name)).toEqual(['sudoers on the payment boxes']);
  });

  it('refuses to save a query the author cannot run', async () => {
    const owner = await makeUser('owner@saved-queries.test');

    await expect(
      serviceFor('inventory:read').create(
        { kind: 'resource', name: 'nope', isShared: false, filter: { type: 'File' } },
        principal(owner, 'owner@saved-queries.test'),
        CONTEXT,
      ),
    ).rejects.toThrow(/cannot run/i);
  });

  /*
   * §4. THE LIFECYCLE, and the reason `userId` is nullable. Somebody leaves;
   * the team keeps the query it depends on, and it still says who made it.
   */
  it('drops private queries with the account and keeps shared ones', async () => {
    const leaver = await makeUser('leaver@saved-queries.test');
    const service = serviceFor('inventory:read');
    const actor = principal(leaver, 'leaver@saved-queries.test');

    await service.create(
      { kind: 'node', name: 'private', isShared: false, filter: { includeInactive: false } },
      actor,
      CONTEXT,
    );
    await service.create(
      { kind: 'node', name: 'team wallboard', isShared: true, filter: { includeInactive: false } },
      actor,
      CONTEXT,
    );

    // Exactly what UsersService.remove does, in the same order.
    await prisma.$transaction(async (tx) => {
      await tx.savedQuery.deleteMany({ where: { userId: leaver, isShared: false } });
      await tx.user.delete({ where: { id: leaver } });
    });

    const remaining = await prisma.savedQuery.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe('team wallboard');
    // Orphaned by the foreign key, still attributable by the denormalised email.
    expect(remaining[0]?.userId).toBeNull();
    expect(remaining[0]?.ownerEmail).toBe('leaver@saved-queries.test');
  });

  /*
   * §5. Sharing changes who can see something; creating a private query changes
   * nothing for anybody else. Auditing both would bury the one that matters.
   */
  it('audits sharing, not creating', async () => {
    const owner = await makeUser('owner@saved-queries.test');
    const service = serviceFor('inventory:read');
    const actor = principal(owner, 'owner@saved-queries.test');

    const created = await service.create(
      { kind: 'node', name: 'quiet', isShared: false, filter: { includeInactive: false } },
      actor,
      CONTEXT,
    );
    expect(await prisma.auditLog.count()).toBe(0);

    await service.update(created.id, { isShared: true }, actor, CONTEXT);
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('saved-query.share');
    expect(rows[0]?.entityLabel).toBe('quiet');
  });

  /*
   * §6. Two people may both have "Ubuntu boxes" — global uniqueness would let
   * whoever saved first take the name from everybody.
   */
  it('allows two owners the same name, and refuses one owner a duplicate', async () => {
    const a = await makeUser('a@saved-queries.test');
    const b = await makeUser('b@saved-queries.test');
    const service = serviceFor('inventory:read');
    const query = {
      kind: 'node' as const,
      name: 'Ubuntu boxes',
      isShared: false,
      filter: { includeInactive: false },
    };

    await service.create(query, principal(a, 'a@saved-queries.test'), CONTEXT);
    await expect(
      service.create(query, principal(b, 'b@saved-queries.test'), CONTEXT),
    ).resolves.toBeDefined();

    await expect(
      service.create(query, principal(a, 'a@saved-queries.test'), CONTEXT),
    ).rejects.toThrow(/already have a saved query/i);
  });

  it('lets an admin fix a shared query whose owner has gone, but not a stranger', async () => {
    const owner = await makeUser('owner@saved-queries.test');
    const stranger = await makeUser('stranger@saved-queries.test');
    const service = serviceFor('inventory:read');

    const created = await service.create(
      { kind: 'node', name: 'team wallboard', isShared: true, filter: { includeInactive: false } },
      principal(owner, 'owner@saved-queries.test'),
      CONTEXT,
    );

    await expect(
      service.update(
        created.id,
        { name: 'hijacked' },
        principal(stranger, 'stranger@saved-queries.test'),
        CONTEXT,
      ),
    ).rejects.toThrow(/only the owner/i);

    const asAdmin = serviceFor('inventory:read', 'users:manage');
    await expect(
      asAdmin.update(
        created.id,
        { name: 'team wallboard (fixed)' },
        principal(stranger, 'stranger@saved-queries.test'),
        CONTEXT,
      ),
    ).resolves.toMatchObject({ name: 'team wallboard (fixed)' });
  });
});
