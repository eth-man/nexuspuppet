import type { AuthenticatedPrincipal, Permission } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { RoleRegistry } from '../src/auth/role-registry';
import { RbacPolicy, permissionsFor } from '../src/auth/rbac.policy';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

/**
 * Authorization reads the roles table (ADR-0018 §2).
 *
 * The registry is what lets `can()` stay synchronous while still resolving from
 * the database, so the properties that matter are: it reflects what is stored,
 * it notices a change without a re-login, and it grants nothing when it cannot
 * be trusted.
 */
describe('RoleRegistry (integration)', () => {
  let prisma: PrismaService;
  let registry: RoleRegistry;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.role.deleteMany({ where: { name: { startsWith: 'reg-' } } });
    registry = new RoleRegistry(prisma);
    await registry.onModuleInit();
  });

  afterEach(async () => {
    registry.onModuleDestroy();
    await prisma.role.deleteMany({ where: { name: { startsWith: 'reg-' } } });
  });

  it('reports what the seeded roles grant', async () => {
    expect([...(registry.permissionsFor('ADMIN') ?? [])]).toEqual(
      expect.arrayContaining(['users:manage', 'settings:manage', 'pql:raw']),
    );
    expect([...(registry.permissionsFor('VIEWER') ?? [])]).not.toContain('classification:write');
  });

  it('distinguishes a role that grants nothing from one that does not exist', async () => {
    // A caller can tell "no such role" — a misconfiguration worth reporting —
    // from "a role with an empty permission set", which is a deliberate choice.
    await prisma.role.create({ data: { name: 'reg-empty', permissions: [] } });
    await registry.invalidate();

    expect(registry.permissionsFor('reg-empty')).toEqual(new Set());
    expect(registry.permissionsFor('reg-nonexistent')).toBeUndefined();
  });

  it('sees a permission revoked without anybody signing in again', async () => {
    // THE property ADR-0018 §3 requires. Baking permissions into a session
    // would mean a revocation waits for that session to expire.
    const role = await prisma.role.create({
      data: { name: 'reg-deployer', permissions: ['inventory:read', 'classification:write'] },
    });
    await registry.invalidate();
    expect(registry.permissionsFor('reg-deployer')?.has('classification:write')).toBe(true);

    await prisma.role.update({ where: { id: role.id }, data: { permissions: ['inventory:read'] } });
    await registry.invalidate();

    expect(registry.permissionsFor('reg-deployer')?.has('classification:write')).toBe(false);
  });

  it('ignores a permission string this build does not know', async () => {
    // The column is a string array, so a typo from a future migration or a hand
    // edit would otherwise sit in memory as a permission matching nothing.
    await prisma.role.create({
      data: { name: 'reg-typo', permissions: ['inventory:read', 'inventry:read'] },
    });
    await registry.invalidate();

    const granted = registry.permissionsFor('reg-typo');
    expect(granted?.has('inventory:read')).toBe(true);
    expect([...(granted ?? [])]).toHaveLength(1);
  });

  it('refuses to start on an empty roles table', async () => {
    // Every request would be denied. Failing at boot names the cause; starting
    // and serving 403s looks like a permissions problem nobody can find.
    const emptied = new RoleRegistry({
      role: { findMany: async () => [] },
    } as unknown as PrismaService);

    await expect(emptied.onModuleInit()).rejects.toThrow(/roles table is empty/i);
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    // Emptying it because a query timed out would lock every operator out of a
    // console that is working.
    let calls = 0;
    const flaky = new RoleRegistry({
      role: {
        findMany: async () => {
          calls += 1;
          if (calls === 1)
            return [{ name: 'reg-x', permissions: ['inventory:read' as Permission] }];
          throw new Error('connection reset');
        },
      },
    } as unknown as PrismaService);

    await flaky.onModuleInit();
    await expect(flaky.invalidate()).rejects.toThrow();

    expect(flaky.permissionsFor('reg-x')?.has('inventory:read')).toBe(true);
    flaky.onModuleDestroy();
  });
});

/**
 * The policy must read the TABLE, not the constant it replaced.
 *
 * Every other test passes against either implementation, because the seeded
 * roles are identical to `SEEDED_BUILT_IN_PERMISSIONS` by construction — that
 * is the whole point of the seed. A mutation swapping the table lookup back for
 * the constant survived the entire suite. These are the cases where the two
 * genuinely differ.
 */
describe('RbacPolicy reads the roles table (integration)', () => {
  let prisma: PrismaService;
  let registry: RoleRegistry;
  let policy: RbacPolicy;

  /*
   * The cast is the honest state of the migration, not a shortcut.
   *
   * AuthenticatedPrincipal.role is still the three-value UserRole in the
   * contracts package. Widening it to a string belongs with the slice that
   * lets a user actually HOLD a custom role — there is no role CRUD yet and
   * users.role is still an enum column, so today a principal can only carry a
   * built-in name in production.
   *
   * The policy itself takes the role as a lookup key and never depended on the
   * narrow type, which is why this test can exercise the case ahead of the
   * contract catching up.
   */
  const principal = (role: string): AuthenticatedPrincipal => ({
    userId: '00000000-0000-4000-8000-00000000000a',
    email: 'someone@example.test',
    displayName: 'Someone',
    role: role as AuthenticatedPrincipal['role'],
    authSource: 'local',
  });

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.role.deleteMany({ where: { name: { startsWith: 'pol-' } } });
    registry = new RoleRegistry(prisma);
    await registry.onModuleInit();
    policy = new RbacPolicy(registry);
  });

  afterEach(async () => {
    registry.onModuleDestroy();
    await prisma.role.deleteMany({ where: { name: { startsWith: 'pol-' } } });
  });

  it('grants what a CUSTOM role in the table grants', async () => {
    // A role the constant has never heard of. Against the old implementation
    // this is simply undefined and grants nothing.
    await prisma.role.create({
      data: { name: 'pol-auditor', permissions: ['pql:raw', 'reports:read'] },
    });
    await registry.invalidate();

    expect(policy.can(principal('pol-auditor'), 'pql:raw')).toBe(true);
    expect(policy.can(principal('pol-auditor'), 'classification:write')).toBe(false);
  });

  it('unions the permissions of every role a principal holds', async () => {
    // ADR-0018 §5. A directory can map somebody into several groups at once,
    // and a single role name cannot express the result.
    await prisma.role.create({ data: { name: 'pol-auditor', permissions: ['pql:raw'] } });
    await prisma.role.create({
      data: { name: 'pol-deployer', permissions: ['classification:write'] },
    });
    await registry.invalidate();

    const both = { ...principal('pol-auditor'), roles: ['pol-auditor', 'pol-deployer'] };

    expect(policy.can(both, 'pql:raw')).toBe(true);
    expect(policy.can(both, 'classification:write')).toBe(true);
    // Neither role grants this, so the union must not either.
    expect(policy.can(both, 'users:manage')).toBe(false);
  });

  it('reports the same union to the console as it enforces', async () => {
    // A console showing a subset hides controls that would have worked; a
    // superset offers controls that will be refused. Both come from computing
    // this in two places.
    await prisma.role.create({ data: { name: 'pol-a', permissions: ['pql:raw'] } });
    await prisma.role.create({ data: { name: 'pol-b', permissions: ['reports:read'] } });
    await registry.invalidate();

    const held = { ...principal('pol-a'), roles: ['pol-a', 'pol-b'] };

    expect(permissionsFor(registry, held)).toEqual(['pql:raw', 'reports:read']);
  });

  it('denies what has been REVOKED from a built-in role in the table', async () => {
    // The mirror case: the constant still says ADMIN may run raw PQL. The table
    // is what decides, so removing it there must deny.
    const admin = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
    const original = admin.permissions;
    try {
      await prisma.role.update({
        where: { id: admin.id },
        data: { permissions: original.filter((p) => p !== 'pql:raw') },
      });
      await registry.invalidate();

      expect(policy.can(principal('ADMIN'), 'pql:raw')).toBe(false);
      expect(policy.can(principal('ADMIN'), 'users:manage')).toBe(true);
    } finally {
      await prisma.role.update({ where: { id: admin.id }, data: { permissions: original } });
    }
  });
});
