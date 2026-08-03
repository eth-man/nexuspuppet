import type { AuthenticatedPrincipal, UserRole } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { TokenService } from '../src/auth/token.service';
import { UsersService } from '../src/auth/users.service';
import { AuthProviderResolver } from '../src/auth/auth-provider.resolver';
import { LocalAuthProvider } from '../src/auth/local-auth.provider';
import { SEEDED_BUILT_IN_PERMISSIONS } from '../src/auth/rbac.policy';
import { roleIdFor } from './support/roles';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

/**
 * The seeded roles must equal what the code grants today (ADR-0018 §1).
 *
 * This is the whole reason the expand step is a separate release. Nothing reads
 * `roles.permissions` yet, so a mismatch between the migration and
 * `ROLE_PERMISSIONS` changes nothing now — and then changes authorization
 * silently, for everyone, in the release that switches resolution over. There
 * is no user-visible symptom in between to catch it.
 */
describe('seeded built-in roles (integration)', () => {
  let prisma: PrismaService;
  let users: UsersService;

  const CTX = { ipAddress: '10.0.0.1', userAgent: 'jest' };
  // A real row: audit_logs.actorUserId is a foreign key, so an invented id
  // fails the write rather than the assertion.
  let principal: AuthenticatedPrincipal;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();

    const provider = new LocalAuthProvider(prisma);
    const tokens = new TokenService(prisma, new AuthProviderResolver([provider], prisma, 0), {
      secret: 'x'.repeat(48),
      accessTtl: '15m',
      refreshTtl: '30d',
    });
    users = new UsersService(prisma, new PrismaAuditSink(prisma), tokens, provider);

    const actor = await prisma.user.upsert({
      where: { email: 'seedspec-actor@example.test' },
      update: {},
      create: {
        email: 'seedspec-actor@example.test',
        displayName: 'Seed Actor',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        authSource: 'local',
      },
    });
    principal = {
      userId: actor.id,
      email: actor.email,
      displayName: actor.displayName,
      role: 'ADMIN',
      authSource: 'local',
    };
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const BUILT_INS: UserRole[] = ['VIEWER', 'OPERATOR', 'ADMIN'];

  it.each(BUILT_INS)('%s grants exactly what ROLE_PERMISSIONS grants', async (name) => {
    const row = await prisma.role.findUnique({ where: { name } });

    expect(row).not.toBeNull();
    expect([...row!.permissions].sort()).toEqual([...SEEDED_BUILT_IN_PERMISSIONS[name]].sort());
  });

  it('marks them built-in, so they cannot later be deleted or renamed', async () => {
    const rows = await prisma.role.findMany({ where: { name: { in: BUILT_INS } } });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.builtIn)).toBe(true);
  });

  it('seeds no roles beyond the built-ins', async () => {
    // A fourth seeded role would be one nobody decided to ship.
    const all = await prisma.role.findMany({ select: { name: true } });
    expect(all.map((r) => r.name).sort()).toEqual(['ADMIN', 'OPERATOR', 'VIEWER']);
  });

  /**
   * Scoped to users this suite creates, deliberately.
   *
   * An earlier version asserted over every row in the table and passed alone
   * while failing in the full run: other suites insert users straight through
   * Prisma, which bypasses the lockstep in UsersService. That is worth writing
   * down rather than working around — **nothing at the database level enforces
   * this invariant.** It holds because the two production creation paths
   * maintain it, and a third one added later would silently not.
   *
   * The consequence for the next step: the migration that makes `roleId` NOT
   * NULL must re-run the backfill rather than assume the column is populated.
   * A rolling deploy has old replicas inserting rows the whole time it runs.
   */
  describe('the writes that maintain roleId', () => {
    const email = (n: string) => `roles-seed-${n}@example.test`;

    afterEach(async () => {
      await prisma.user.deleteMany({ where: { email: { startsWith: 'roles-seed-' } } });
    });

    it('sets roleId when a user is created through the service', async () => {
      const created = await users.create(
        {
          email: email('create'),
          displayName: 'C',
          role: 'OPERATOR',
          authSource: 'local',
          password: 'correct horse battery staple',
        },
        principal,
        CTX,
      );

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: created.id },
        include: { roleRef: true },
      });
      expect(row.roleRef?.name).toBe('OPERATOR');
    });

    it('moves roleId with the role when one is changed', async () => {
      const created = await users.create(
        {
          email: email('update'),
          displayName: 'U',
          role: 'VIEWER',
          authSource: 'local',
          password: 'correct horse battery staple',
        },
        principal,
        CTX,
      );

      await users.update(created.id, { role: 'ADMIN' }, principal, CTX);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: created.id },
        include: { roleRef: true },
      });
      // The failure this catches is the enum and the FK disagreeing, which has
      // no symptom until resolution moves to the FK.
      expect(row.role).toBe('ADMIN');
      expect(row.roleRef?.name).toBe('ADMIN');
    });
  });
});
