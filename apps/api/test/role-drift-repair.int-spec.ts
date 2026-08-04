import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import { roleIdFor } from './support/roles';

/**
 * The data migration that heals users whose role NAME and role KEY disagree.
 *
 * Data migrations are the least-tested code in most projects: they run once, in
 * production, against rows nobody has looked at. This one rewrites an
 * authorization column, and getting it wrong moves people between roles
 * silently — so it gets the same treatment as the code that caused the drift.
 *
 * The real SQL file is read and executed here rather than restated, because a
 * copy in a test only proves the copy works.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260804063000_repair_role_drift',
  'migration.sql',
);

jest.setTimeout(60_000);

describe('repair_role_drift migration (integration)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.role.deleteMany({ where: { builtIn: false } });
  });

  /** Executes the migration exactly as `prisma migrate deploy` would. */
  async function runMigration(): Promise<void> {
    const sql = readFileSync(MIGRATION, 'utf8');
    // Split on the statement boundaries, keeping the DO $$ … $$ block whole —
    // it contains semicolons of its own.
    for (const statement of sql.split(/;\s*\n(?=\s*(?:UPDATE|DO)\b)/i)) {
      if (statement.replace(/^\s*--.*$/gm, '').trim() === '') continue;
      await prisma.$executeRawUnsafe(statement);
    }
  }

  async function seed(email: string, name: string, keyOf: string): Promise<void> {
    await prisma.user.create({
      data: {
        email,
        displayName: email,
        role: name,
        roleId: await roleIdFor(prisma, keyOf),
        authSource: 'ldap',
      },
    });
  }

  async function keyName(email: string): Promise<string> {
    const row = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { roleRef: { select: { name: true } } },
    });
    return row.roleRef.name;
  }

  it('points the key at the role the name says', async () => {
    // Exactly what the deployment showed: signed in as an operator, counted as
    // a viewer.
    await seed('drifted@example.com', 'OPERATOR', 'VIEWER');

    await runMigration();

    expect(await keyName('drifted@example.com')).toBe('OPERATOR');
  });

  it('heals a drifted administrator, which is the dangerous one', async () => {
    /*
     * The last-administrator guard counts by the key. An admin whose key still
     * said VIEWER was not counted as an administrator at all, so the guard was
     * protecting a set that did not include them.
     */
    await seed('admin@example.com', 'ADMIN', 'VIEWER');

    await runMigration();

    expect(await keyName('admin@example.com')).toBe('ADMIN');
  });

  it('heals drift onto a custom role', async () => {
    await prisma.role.create({
      data: { name: 'auditor', permissions: ['inventory:read'] },
    });
    await seed('auditor@example.com', 'auditor', 'VIEWER');

    await runMigration();

    expect(await keyName('auditor@example.com')).toBe('auditor');
  });

  it('leaves users alone whose name already matches their key', async () => {
    await seed('fine@example.com', 'OPERATOR', 'OPERATOR');
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'fine@example.com' } });

    await runMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'fine@example.com' } });
    expect(after.roleId).toBe(before.roleId);
    expect(after.role).toBe('OPERATOR');
  });

  it('leaves a name no role matches exactly as it found it, rather than guessing', async () => {
    // Keyed to OPERATOR and not VIEWER on purpose: VIEWER is the value a
    // "just default the unmatched ones to the least privilege" repair would
    // pick, and seeding it there would make that repair indistinguishable from
    // leaving the row alone.
    await seed('ghost@example.com', 'role-that-was-deleted', 'OPERATOR');
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'ghost@example.com' } });

    await runMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'ghost@example.com' } });
    expect(after.roleId).toBe(before.roleId);
    expect(after.role).toBe('role-that-was-deleted');
  });

  it('is safe to run twice', async () => {
    // It ships as a migration and so runs once, but a data repair that is not
    // idempotent cannot be re-run by hand during an incident, which is when
    // somebody will want to.
    await seed('drifted@example.com', 'OPERATOR', 'VIEWER');

    await runMigration();
    await runMigration();

    expect(await keyName('drifted@example.com')).toBe('OPERATOR');
  });
});
