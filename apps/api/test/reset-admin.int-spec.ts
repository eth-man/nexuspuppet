import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { IAuditSink } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { LocalAuthProvider } from '../src/auth/local-auth.provider';
import { hashPassword } from '../src/auth/password';
import { buildAuditSink, resetLocalPassword } from '../src/cli/admin-reset';
import { roleIdFor } from './support/roles';

/**
 * `deploy.sh --reset-admin`, against a REAL PostgreSQL.
 *
 * What a fake cannot show: that the password, the unlock, the revoked sessions
 * and the audit row — and its forwarding job — COMMIT TOGETHER, and that the
 * account can then actually be signed in to through the real local provider.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const OLD = 'the-password-that-was-lost';
const NEW = 'a-brand-new-long-password';
const SIEM = { DATABASE_URL, AUDIT_EXPORT_URL: 'https://siem.example.test/ingest' };

jest.setTimeout(120_000);

describe('reset-admin (integration)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await prisma.auditDeliveryJob.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.providerSetting.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(() => jest.restoreAllMocks());

  async function seed(
    over: {
      email?: string;
      authSource?: string;
      isActive?: boolean;
      lockedUntil?: Date | null;
      failedLoginAttempts?: number;
    } = {},
  ): Promise<{ id: string }> {
    const authSource = over.authSource ?? 'local';
    return prisma.user.create({
      data: {
        email: over.email ?? 'admin@example.com',
        displayName: 'Administrator',
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        passwordHash: authSource === 'local' ? await hashPassword(OLD) : null,
        authSource,
        isActive: over.isActive ?? true,
        lockedUntil: over.lockedUntil ?? null,
        failedLoginAttempts: over.failedLoginAttempts ?? 0,
      },
      select: { id: true },
    });
  }

  async function session(userId: string): Promise<void> {
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: randomUUID(),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  async function reset(email: string, audit?: IAuditSink, env: NodeJS.ProcessEnv = SIEM) {
    return resetLocalPassword(
      {
        db: prisma,
        audit: audit ?? (await buildAuditSink(prisma, env, () => undefined)),
        hash: hashPassword,
        actor: 'cli:deploy.sh@console01',
      },
      { email, password: NEW },
    );
  }

  const login = (password: string) =>
    new LocalAuthProvider(prisma, { maxFailedAttempts: 3, lockoutMinutes: 15 }).authenticate({
      email: 'admin@example.com',
      password,
    });

  it('resets a locked, deactivated admin so the new password signs in and the old does not', async () => {
    const admin = await seed({
      isActive: false,
      lockedUntil: new Date(Date.now() + 15 * 60_000),
      failedLoginAttempts: 7,
    });
    await session(admin.id);
    await session(admin.id);

    const outcome = await reset('ADMIN@example.com');

    expect(outcome).toMatchObject({
      kind: 'reset',
      email: 'admin@example.com',
      unlocked: true,
      reactivated: true,
      sessionsEnded: 2,
    });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row).toMatchObject({ isActive: true, lockedUntil: null, failedLoginAttempts: 0 });
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);

    expect((await login(OLD)).ok).toBe(false);
    expect((await login(NEW)).ok).toBe(true);
  });

  it('writes the audit row, and queues it for a configured SIEM, in the same commit', async () => {
    const admin = await seed();

    await reset('admin@example.com');

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorEmail: 'cli:deploy.sh@console01',
      action: 'user.password.reset',
      entityType: 'User',
      entityId: admin.id,
      entityLabel: 'admin@example.com',
      after: { email: 'admin@example.com', via: 'cli', unlocked: false, reactivated: false },
      ipAddress: null,
      userAgent: null,
    });
    const jobs = await prisma.auditDeliveryJob.findMany();
    expect(jobs.map((j) => j.auditLogId)).toEqual([rows[0]?.id]);
  });

  it('writes the row but queues nothing when no forwarding is configured', async () => {
    await seed();

    await reset('admin@example.com', undefined, { DATABASE_URL });

    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.auditDeliveryJob.count()).toBe(0);
  });

  it('refuses a directory account and changes nothing', async () => {
    const ann = await seed({ email: 'ann@corp.example', authSource: 'ldap' });
    await session(ann.id);

    const outcome = await reset('ann@corp.example');

    expect(outcome).toEqual({ kind: 'not-local', email: 'ann@corp.example', authSource: 'ldap' });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ann.id } });
    expect(row.passwordHash).toBeNull();
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(1);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('refuses an unknown email and changes nothing', async () => {
    await seed();

    expect(await reset('nobody@example.com')).toEqual({
      kind: 'not-found',
      email: 'nobody@example.com',
    });
    expect(await prisma.auditLog.count()).toBe(0);
    expect((await login(OLD)).ok).toBe(true);
  });

  /** ADR-0005: a reset whose audit row cannot be written must not happen. */
  it('rolls the whole reset back when the audit write fails', async () => {
    const admin = await seed({
      lockedUntil: new Date(Date.now() + 60_000),
      failedLoginAttempts: 3,
    });
    await session(admin.id);
    const failing: IAuditSink = {
      record: async () => {
        throw new Error('audit unavailable');
      },
    };

    await expect(reset('admin@example.com', failing)).rejects.toThrow('audit unavailable');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.failedLoginAttempts).toBe(3);
    expect(row.lockedUntil).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(1);
    // Still locked, so even the old password is refused — but it is the old
    // hash that is stored.
    await prisma.user.update({ where: { id: admin.id }, data: { lockedUntil: null } });
    expect((await login(OLD)).ok).toBe(true);
  });
});
