import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * The id of a seeded built-in role.
 *
 * `users.roleId` is NOT NULL since ADR-0018, so a test that inserts a user
 * directly has to supply it — the same way UsersService does. That is the
 * constraint working: the invariant is now enforced by the database rather than
 * by every caller remembering.
 */
export async function roleIdFor(prisma: PrismaService, name: string): Promise<string> {
  return (await prisma.role.findUniqueOrThrow({ where: { name } })).id;
}

/**
 * The built-in roles exactly as the seeding migration writes them.
 *
 * Duplicated from `20260802074701_roles_table` on purpose. These three sets are
 * what the product documents ADMIN, OPERATOR and VIEWER to mean, so a test
 * suite asserting on them should state them outright rather than read back
 * whatever the database happens to hold — otherwise a suite run against a
 * damaged database asserts against the damage.
 */
const BUILT_IN_DEFAULTS: ReadonlyArray<{
  name: string;
  description: string;
  permissions: string[];
}> = [
  {
    name: 'VIEWER',
    description: 'Read-only access to inventory, reports and classification.',
    permissions: ['inventory:read', 'reports:read', 'classification:read'],
  },
  {
    name: 'OPERATOR',
    description: 'Reads everything a viewer can, and changes classification.',
    permissions: [
      'inventory:read',
      'reports:read',
      'classification:read',
      'classification:write',
      'materialization:trigger',
    ],
  },
  {
    name: 'ADMIN',
    description: 'Full administration, including users, settings, raw PQL and catalog resources.',
    permissions: [
      'inventory:read',
      'reports:read',
      'classification:read',
      'classification:write',
      'materialization:trigger',
      'users:manage',
      'settings:manage',
      'pql:raw',
      // ADR-0025 §3. Added by 20260818120000_admin_resources_read, which is
      // what actually grants it — this list only restores what that wrote.
      'resources:read',
    ],
  },
];

/**
 * Puts the built-in roles back the way the product seeds them.
 *
 * Nothing reachable through the API can damage them — that is the guard this
 * suite exists to prove. But a suite run against a BROKEN guard can, and did:
 * one deliberately disabled guard left `settings:manage` welded onto VIEWER,
 * and every later run then failed for that reason rather than the real one.
 * A test fixture that cannot be trusted after a failure is worse than none,
 * because the second run lies about the first.
 *
 * Written straight through Prisma rather than through RolesService, which is
 * the thing under test and is supposed to refuse exactly this.
 */
export async function restoreBuiltInRoles(prisma: PrismaService): Promise<void> {
  for (const role of BUILT_IN_DEFAULTS) {
    await prisma.role.updateMany({
      where: { name: role.name, builtIn: true },
      data: { permissions: role.permissions, description: role.description },
    });
  }
}
