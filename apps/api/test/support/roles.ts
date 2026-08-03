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
