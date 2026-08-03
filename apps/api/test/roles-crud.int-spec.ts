import type { AuthenticatedPrincipal, BlockingRoleMapping } from '@nexuspuppet/contracts';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { RoleRegistry } from '../src/auth/role-registry';
import { RolesService, type MappingSource } from '../src/auth/roles.service';
import { restoreBuiltInRoles, roleIdFor } from './support/roles';
import { hashPassword } from '../src/auth/password';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

/**
 * Role administration (ADR-0018 §6).
 *
 * Every guard here stops a change that cannot be undone from inside the
 * product. The one that matters most is deletion: a directory mapping naming a
 * deleted role does not fail at deletion time, it fails at somebody's next
 * sign-in, silently, and the thing to look at is no longer there.
 */
describe('RolesService (integration)', () => {
  let prisma: PrismaService;
  let registry: RoleRegistry;
  let roles: RolesService;
  let mappings: Array<BlockingRoleMapping & { role: string }> = [];

  // A REAL row: audit_logs.actorUserId is a foreign key, so an invented id
  // fails the write rather than the assertion.
  let request: never;

  const source: MappingSource = { all: async () => mappings };

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    mappings = [];
    // Built-ins are meant to be unchangeable; if a regression made them
    // changeable, an earlier test in this file may have changed them.
    await restoreBuiltInRoles(prisma);
    await prisma.user.deleteMany({ where: { email: { startsWith: 'crud-' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'crud-' } } });
    registry = new RoleRegistry(prisma);
    await registry.onModuleInit();
    roles = new RolesService(prisma, new PrismaAuditSink(prisma), registry, source);

    // An administrator who is not in any role under test, so the lockout
    // guards never fire incidentally — and who acts as the audit actor.
    const keeper = await prisma.user.upsert({
      where: { email: 'crud-keeper@example.test' },
      update: {},
      create: {
        email: 'crud-keeper@example.test',
        displayName: 'Keeper',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        isActive: true,
        passwordHash: await hashPassword('correct horse battery staple'),
      },
    });

    request = {
      principal: {
        userId: keeper.id,
        email: keeper.email,
        displayName: keeper.displayName,
        role: 'ADMIN',
        authSource: 'local',
      } as AuthenticatedPrincipal,
      ip: '10.0.0.1',
      headers: { 'user-agent': 'jest' },
    } as never;
  });

  afterEach(async () => {
    registry.onModuleDestroy();
    // Before the deletes: rows this file created are removed anyway, and rows
    // it merely borrowed from other suites must go back exactly as they were.
    if (deactivated.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: deactivated } },
        data: { isActive: true },
      });
      deactivated = [];
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: 'crud-' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'crud-' } } });
  });

  it('creates a role and makes it usable immediately', async () => {
    const created = await roles.create(
      { name: 'crud-auditor', permissions: ['pql:raw', 'reports:read'] },
      request,
    );

    expect(created.builtIn).toBe(false);
    // Invalidated before returning, so the next request already decides with it
    // rather than waiting out the refresh interval.
    expect(registry.permissionsFor('crud-auditor')?.has('pql:raw')).toBe(true);
  });

  it('refuses a duplicate name', async () => {
    await roles.create({ name: 'crud-dup', permissions: [] }, request);

    await expect(roles.create({ name: 'crud-dup', permissions: [] }, request)).rejects.toThrow(
      /already exists/,
    );
  });

  describe('deleting a role a directory still maps to', () => {
    it('names every blocking mapping, not just that one exists', async () => {
      /*
       * THE requirement. "Role is in use" tells an operator a fact they already
       * suspected and none of what they need: which entry, in which
       * configuration, to go and change.
       */
      const role = await roles.create({ name: 'crud-mapped', permissions: [] }, request);
      mappings = [
        {
          groupDn: 'cn=auditors,ou=groups,dc=example,dc=com',
          role: 'crud-mapped',
          source: 'database',
        },
        {
          groupDn: 'cn=readonly,ou=groups,dc=example,dc=com',
          role: 'crud-mapped',
          source: 'database',
        },
        { groupDn: 'cn=other,ou=groups,dc=example,dc=com', role: 'VIEWER', source: 'database' },
      ];

      const error = await roles.remove(role.id, request).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as Record<string, unknown>;

      expect(body['error']).toBe('ROLE_REFERENCED_BY_MAPPING');
      expect(body['blockingMappings']).toEqual([
        { groupDn: 'cn=auditors,ou=groups,dc=example,dc=com', source: 'database' },
        { groupDn: 'cn=readonly,ou=groups,dc=example,dc=com', source: 'database' },
      ]);
      // The DNs appear verbatim in the message too, so an operator reading the
      // console can search their directory for them without opening a payload.
      expect(String(body['message'])).toContain('cn=auditors,ou=groups,dc=example,dc=com');
      expect(String(body['message'])).toContain('cn=readonly,ou=groups,dc=example,dc=com');
    });

    it('says where the mapping is configured, so the operator knows where to go', async () => {
      const role = await roles.create({ name: 'crud-envmapped', permissions: [] }, request);
      mappings = [
        { groupDn: 'cn=x,dc=example,dc=com', role: 'crud-envmapped', source: 'environment' },
      ];

      const error = (await roles
        .remove(role.id, request)
        .catch((e: unknown) => e)) as ConflictException;
      const body = error.getResponse() as Record<string, unknown>;

      expect(String(body['message'])).toMatch(/environment/i);
    });

    it('does not block on a mapping pointing at a different role', async () => {
      const role = await roles.create({ name: 'crud-unmapped', permissions: [] }, request);
      mappings = [
        { groupDn: 'cn=x,dc=example,dc=com', role: 'SOMETHING-ELSE', source: 'database' },
      ];

      await expect(roles.remove(role.id, request)).resolves.toBeUndefined();
    });
  });

  it('refuses to delete a built-in role', async () => {
    const admin = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });

    await expect(roles.remove(admin.id, request)).rejects.toThrow(/built-in/);
  });

  it('refuses to delete a role somebody still holds', async () => {
    const role = await roles.create({ name: 'crud-held', permissions: [] }, request);
    await prisma.user.create({
      data: {
        email: 'crud-holder@example.test',
        displayName: 'Holder',
        role: 'crud-held',
        roleId: role.id,
        isActive: true,
      },
    });

    await expect(roles.remove(role.id, request)).rejects.toThrow(/still hold/);
  });

  /**
   * Establishes a custom role as the only source of administration.
   *
   * The guard asks a question about the WHOLE database — is there any other
   * active user whose role still grants this permission — so the fixture has to
   * answer for the whole database, not just for the rows this file created.
   *
   * Deactivating only the keeper was enough when this spec ran alone and wrong
   * as soon as it ran with the others: the shared integration database also
   * holds active administrators left by the auth suites, the guard correctly
   * found cover in one of them, and the test failed in CI having passed
   * locally. Rows are deactivated rather than deleted — several are foreign-key
   * targets of audit rows — and `afterEach` puts every one of them back.
   */
  let deactivated: string[] = [];

  async function makeSoleAdministrator(name: string) {
    const role = await roles.create(
      { name, permissions: ['users:manage', 'settings:manage'] },
      request,
    );
    const holder = await prisma.user.create({
      data: {
        email: `${name}-holder@example.test`,
        displayName: 'Sole administrator',
        role: name,
        roleId: role.id,
        isActive: true,
      },
    });

    const others = await prisma.user.findMany({
      where: {
        isActive: true,
        id: { not: holder.id },
        roleRef: { permissions: { hasSome: ['users:manage', 'settings:manage'] } },
      },
      select: { id: true },
    });
    deactivated = others.map((user) => user.id);
    await prisma.user.updateMany({
      where: { id: { in: deactivated } },
      data: { isActive: false },
    });

    return role;
  }

  /*
   * The lockout guard is exercised through a CUSTOM role.
   *
   * It used to be exercised through ADMIN, which is no longer editable at all —
   * the built-in guard now fires first, so the lockout branch would never be
   * reached and these tests would have kept passing for the wrong reason. The
   * property under test is unchanged: the last role granting an administrative
   * permission cannot have it taken away.
   */
  it('refuses an edit that would leave nobody able to administer', async () => {
    // Everything rests on somebody being able to grant permissions back.
    const sole = await makeSoleAdministrator('crud-sole');

    await expect(
      roles.update(sole.id, { permissions: ['inventory:read'] }, request),
    ).rejects.toThrow(/administer this deployment/);
  });

  it('permits the same edit once another role can administer', async () => {
    const sole = await makeSoleAdministrator('crud-sole-rescued');

    const rescue = await roles.create(
      { name: 'crud-rescue', permissions: ['users:manage', 'settings:manage'] },
      request,
    );
    await prisma.user.create({
      data: {
        email: 'crud-rescuer@example.test',
        displayName: 'Rescuer',
        role: 'crud-rescue',
        roleId: rescue.id,
        isActive: true,
      },
    });

    await expect(
      roles.update(sole.id, { permissions: ['inventory:read'] }, request),
    ).resolves.toMatchObject({ permissions: ['inventory:read'] });
  });

  /*
   * Built-in roles are fixed (ADR-0018 §1).
   *
   * The lockout guard alone still allowed a role NAMED "VIEWER" to be given
   * `settings:manage`. Every runbook, directory mapping and support answer
   * saying "VIEWER" then means something the product never documented, and
   * nothing about the name reveals it.
   */
  it('refuses to redefine a built-in role', async () => {
    const viewer = await prisma.role.findUniqueOrThrow({ where: { name: 'VIEWER' } });

    await expect(
      roles.update(
        viewer.id,
        { permissions: [...(viewer.permissions as never[]), 'settings:manage'] },
        request,
      ),
    ).rejects.toThrow(/built-in role and cannot be redefined/);

    const after = await prisma.role.findUniqueOrThrow({ where: { id: viewer.id } });
    expect(after.permissions).toEqual(viewer.permissions);
  });

  it('refuses to redescribe a built-in role', async () => {
    const viewer = await prisma.role.findUniqueOrThrow({ where: { name: 'VIEWER' } });

    await expect(
      roles.update(viewer.id, { description: 'Actually an administrator' }, request),
    ).rejects.toThrow(/built-in role and cannot be redefined/);
  });

  /**
   * A no-op is not a refusal.
   *
   * Any client doing read-modify-write echoes the current values back. If that
   * threw, a built-in role would not be fixed, it would be untouchable — and a
   * console editor that sends the full permission set could never open one
   * without erroring.
   */
  it('accepts a request that changes nothing about a built-in role', async () => {
    const viewer = await prisma.role.findUniqueOrThrow({ where: { name: 'VIEWER' } });

    await expect(
      roles.update(
        viewer.id,
        {
          // Deliberately reordered: the guard compares sets, not sequences.
          permissions: [...(viewer.permissions as never[])].reverse(),
          description: viewer.description,
        },
        request,
      ),
    ).resolves.toMatchObject({ name: 'VIEWER', builtIn: true });
  });

  it('reports how many active users hold each role', async () => {
    const role = await roles.create({ name: 'crud-counted', permissions: [] }, request);
    await prisma.user.create({
      data: {
        email: 'crud-one@example.test',
        displayName: 'One',
        role: 'crud-counted',
        roleId: role.id,
        isActive: true,
      },
    });
    await prisma.user.create({
      data: {
        email: 'crud-two@example.test',
        displayName: 'Two',
        role: 'crud-counted',
        roleId: role.id,
        isActive: false,
      },
    });

    const listed = (await roles.list()).find((r) => r.name === 'crud-counted');

    // Active only: a deactivated account is not somebody the operator has to
    // move before deleting.
    expect(listed?.userCount).toBe(1);
  });
});
