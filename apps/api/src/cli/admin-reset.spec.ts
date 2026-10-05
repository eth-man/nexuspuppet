import { Readable } from 'node:stream';
import { hostname } from 'node:os';
import { Logger } from '@nestjs/common';
import type { AuditRecord, IAuditSink } from '@nexuspuppet/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import {
  EXIT,
  actorFor,
  buildAuditSink,
  checkPassword,
  cliSettings,
  reportOutcome,
  readPassword,
  redact,
  resetLocalPassword,
  type ResetDb,
} from './admin-reset';
import { run } from './reset-password';

/**
 * `deploy.sh --reset-admin` — the in-image half.
 *
 * Against fakes: what is decided and what is written. The integration test
 * (test/reset-admin.int-spec.ts) proves the same against a real Postgres, and
 * that the record reaches the forwarding queue.
 */

const PASSWORD = 'correct horse battery staple';
const HASH = 'scrypt$32768$8$1$c2FsdA==$aGFzaA==';
const NOW = new Date('2026-10-05T12:00:00Z');

interface FakeUser {
  id: string;
  email: string;
  role: string;
  authSource: string;
  isActive: boolean;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  passwordHash: string | null;
}

function fakeDb(users: FakeUser[], activeTokens = 2) {
  const calls = {
    updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
    revokes: [] as Array<{ where: unknown; data: unknown }>,
    transactions: 0,
  };
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        users.find((u) => u.email === where.email) ?? null,
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        calls.updates.push(args);
        return {};
      },
    },
    refreshToken: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        calls.revokes.push(args);
        return { count: activeTokens };
      },
    },
    // For the real PrismaAuditSink, which run() builds.
    auditLog: { create: async () => ({ id: 'log-1' }) },
  };
  const db = {
    $transaction: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      calls.transactions += 1;
      return fn(tx as never);
    },
  } as unknown as ResetDb;
  return { db, calls, tx };
}

function fakeAudit() {
  const records: Array<{ entry: AuditRecord; tx: unknown }> = [];
  const sink: IAuditSink = {
    record: async (entry, tx) => {
      records.push({ entry, tx });
      return 'audit-1';
    },
  };
  return { sink, records };
}

const user = (over: Partial<FakeUser> = {}): FakeUser => ({
  id: '00000000-0000-0000-0000-00000000000a',
  email: 'admin@example.com',
  role: 'ADMIN',
  authSource: 'local',
  isActive: true,
  lockedUntil: null,
  failedLoginAttempts: 0,
  passwordHash: 'scrypt$old',
  ...over,
});

function deps(db: ResetDb, audit: IAuditSink) {
  return {
    db,
    audit,
    hash: async () => HASH,
    actor: 'cli:deploy.sh@console01',
    now: () => NOW,
  };
}

describe('resetLocalPassword', () => {
  it('refuses an unknown email and writes nothing', async () => {
    const { db, calls } = fakeDb([user()]);
    const audit = fakeAudit();

    const outcome = await resetLocalPassword(deps(db, audit.sink), {
      email: 'nobody@example.com',
      password: PASSWORD,
    });

    expect(outcome).toEqual({ kind: 'not-found', email: 'nobody@example.com' });
    expect(calls.updates).toHaveLength(0);
    expect(calls.revokes).toHaveLength(0);
    expect(audit.records).toHaveLength(0);
    expect(reportOutcome(outcome).code).toBe(EXIT.notFound);
  });

  it('refuses a directory account with the console reset’s wording', async () => {
    const { db, calls } = fakeDb([user({ email: 'ann@corp.example', authSource: 'ldap' })]);
    const audit = fakeAudit();

    const outcome = await resetLocalPassword(deps(db, audit.sink), {
      email: 'ann@corp.example',
      password: PASSWORD,
    });

    expect(outcome.kind).toBe('not-local');
    expect(calls.updates).toHaveLength(0);
    expect(audit.records).toHaveLength(0);
    const report = reportOutcome(outcome);
    expect(report.code).toBe(EXIT.notLocal);
    expect(report.stderr.join('\n')).toBe(
      'ann@corp.example is authenticated by "ldap", not by a local password. ' +
        'Reset it in that directory instead.',
    );
  });

  it('refuses a password the console would refuse, before touching the database', async () => {
    const { db, calls } = fakeDb([user()]);
    const audit = fakeAudit();
    const hash = jest.fn(async () => HASH);

    const outcome = await resetLocalPassword(
      { ...deps(db, audit.sink), hash },
      { email: 'admin@example.com', password: 'eleven-char' },
    );

    expect(outcome).toEqual({
      kind: 'invalid-password',
      message: 'The password must be at least 12 characters.',
    });
    expect(hash).not.toHaveBeenCalled();
    expect(calls.transactions).toBe(0);
    expect(reportOutcome(outcome).code).toBe(EXIT.invalidPassword);
  });

  it('sets the hash, unlocks, reactivates, revokes sessions and audits — in one transaction', async () => {
    const locked = user({
      email: 'admin@example.com',
      isActive: false,
      lockedUntil: new Date(NOW.getTime() + 60_000),
      failedLoginAttempts: 5,
    });
    const { db, calls, tx } = fakeDb([locked], 3);
    const audit = fakeAudit();

    const outcome = await resetLocalPassword(deps(db, audit.sink), {
      // Login normalises; so must this, or the account found is not the one
      // that will be signed in to.
      email: '  Admin@Example.COM ',
      password: PASSWORD,
    });

    expect(outcome).toEqual({
      kind: 'reset',
      email: 'admin@example.com',
      role: 'ADMIN',
      unlocked: true,
      reactivated: true,
      sessionsEnded: 3,
    });
    expect(calls.transactions).toBe(1);
    expect(calls.updates).toEqual([
      {
        where: { id: locked.id },
        data: { passwordHash: HASH, failedLoginAttempts: 0, lockedUntil: null, isActive: true },
      },
    ]);
    expect(calls.revokes).toEqual([
      { where: { userId: locked.id, revokedAt: null }, data: { revokedAt: NOW } },
    ]);

    expect(audit.records).toHaveLength(1);
    const [record] = audit.records;
    // On the transaction, or a SIEM-forwarding sink would decline to enqueue.
    expect(record?.tx).toBe(tx);
    expect(record?.entry).toEqual({
      actorUserId: null,
      actorEmail: 'cli:deploy.sh@console01',
      action: 'user.password.reset',
      entityType: 'User',
      entityId: locked.id,
      before: null,
      after: { email: 'admin@example.com', via: 'cli', unlocked: true, reactivated: true },
      ipAddress: null,
      userAgent: null,
    });
  });

  it('reports an expired lock as not unlocked, and an active account as not reactivated', async () => {
    const { db } = fakeDb([user({ lockedUntil: new Date(NOW.getTime() - 1) })]);
    const audit = fakeAudit();

    await resetLocalPassword(deps(db, audit.sink), {
      email: 'admin@example.com',
      password: PASSWORD,
    });

    expect(audit.records[0]?.entry.after).toEqual({
      email: 'admin@example.com',
      via: 'cli',
      unlocked: false,
      reactivated: false,
    });
  });
});

describe('reportOutcome', () => {
  it('prints the success line, the access-token caveat, and nothing secret', () => {
    const report = reportOutcome({
      kind: 'reset',
      email: 'admin@example.com',
      role: 'ADMIN',
      unlocked: false,
      reactivated: false,
      sessionsEnded: 0,
    });
    expect(report.code).toBe(EXIT.ok);
    expect(report.stdout[0]).toBe(
      'Password reset for admin@example.com. Sessions ended; account unlocked and active.',
    );
    expect(report.stdout.join('\n')).toMatch(/access token .* stays valid until it expires/i);
    expect(report.stdout.join('\n')).not.toMatch(/not ADMIN/);
  });

  it('says so when the account reset is not an administrator', () => {
    const report = reportOutcome({
      kind: 'reset',
      email: 'v@example.com',
      role: 'VIEWER',
      unlocked: false,
      reactivated: false,
      sessionsEnded: 0,
    });
    expect(report.stdout.join('\n')).toMatch(/has the VIEWER role, not ADMIN/);
  });
});

describe('checkPassword', () => {
  it('applies resetPasswordSchema: 12 to 1024 characters', () => {
    expect(checkPassword('x'.repeat(11))).toMatch(/at least 12/);
    expect(checkPassword('x'.repeat(12))).toBeNull();
    expect(checkPassword('x'.repeat(1024))).toBeNull();
    expect(checkPassword('x'.repeat(1025))).toMatch(/at most 1024/);
  });
});

describe('readPassword', () => {
  it('takes the first line and drops its line ending', async () => {
    await expect(readPassword(Readable.from([`${PASSWORD}\n`]))).resolves.toBe(PASSWORD);
    await expect(readPassword(Readable.from([`${PASSWORD}\r\nsecond\n`]))).resolves.toBe(PASSWORD);
    await expect(readPassword(Readable.from(['abc', 'def\nghi']))).resolves.toBe('abcdef');
  });

  it('accepts a final line with no newline, and keeps surrounding spaces', async () => {
    await expect(readPassword(Readable.from(['  spaced password  ']))).resolves.toBe(
      '  spaced password  ',
    );
  });

  it('stops reading past the bound', async () => {
    const huge = Readable.from(['y'.repeat(5000), 'y'.repeat(5000), 'y'.repeat(5000)]);
    expect((await readPassword(huge, 8192)).length).toBe(10000);
  });
});

describe('actorFor', () => {
  it('names the host deploy.sh ran on', () => {
    expect(actorFor('console01.example.com')).toBe('cli:deploy.sh@console01.example.com');
  });

  it('falls back to this host for anything that is not a hostname', () => {
    expect(actorFor(undefined)).toBe(`cli:deploy.sh@${hostname()}`);
    expect(actorFor('evil\nINJECTED')).toBe(`cli:deploy.sh@${hostname()}`);
  });
});

describe('redact', () => {
  it('removes every occurrence of every secret', () => {
    expect(redact(`a ${PASSWORD} b ${HASH} c ${PASSWORD}`, [PASSWORD, HASH, ''])).toBe(
      'a [redacted] b [redacted] c [redacted]',
    );
  });
});

describe('cliSettings', () => {
  it('reads only what it needs, with the API’s schema, empty meaning absent', () => {
    expect(
      cliSettings({
        DATABASE_URL: 'postgresql://x',
        CONFIG_ENCRYPTION_KEY: '',
        JWT_SECRET: 'short',
      }),
    ).toEqual({ DATABASE_URL: 'postgresql://x', SETTINGS_SOURCE: 'db' });
  });

  it('refuses a missing DATABASE_URL', () => {
    expect(() => cliSettings({})).toThrow(/DATABASE_URL/);
  });
});

describe('buildAuditSink', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** Enough of a client for PrismaAuditSink, the outbox and the settings store. */
  function prismaWith(rows: Record<string, { config: unknown }>) {
    const created: unknown[] = [];
    const enqueued: unknown[] = [];
    const tx = {
      auditLog: {
        create: async (args: unknown) => {
          created.push(args);
          return { id: 'log-1' };
        },
      },
      auditDeliveryJob: {
        upsert: async (args: unknown) => {
          enqueued.push(args);
          return {};
        },
      },
    };
    const prisma = {
      providerSetting: {
        findUnique: async ({ where }: { where: { kind: string } }) => {
          const row = rows[where.kind];
          return row === undefined
            ? null
            : {
                kind: where.kind,
                enabled: true,
                config: row.config,
                secrets: null,
                updatedAt: NOW,
                updatedByEmail: 'x@example.com',
              };
        },
      },
    } as unknown as PrismaService;
    return { prisma, tx, created, enqueued };
  }

  const entry: AuditRecord = {
    actorUserId: null,
    actorEmail: 'cli:deploy.sh@h',
    action: 'user.password.reset',
    entityType: 'User',
    entityId: 'u',
  };

  it('queues the record for forwarding when the environment configures a collector', async () => {
    const { prisma, tx, created, enqueued } = prismaWith({});
    const sink = await buildAuditSink(
      prisma,
      { DATABASE_URL: 'postgresql://x', AUDIT_EXPORT_URL: 'https://siem.example.test/in' },
      () => undefined,
    );

    await sink.record(entry, tx);
    expect(created).toHaveLength(1);
    expect(enqueued).toEqual([
      { where: { auditLogId: 'log-1' }, create: { auditLogId: 'log-1' }, update: {} },
    ]);
  });

  it('writes locally only when forwarding is switched off in the console', async () => {
    const { prisma, tx, created, enqueued } = prismaWith({
      'audit.forwarding': { config: { active: 'none' } },
    });
    const sink = await buildAuditSink(
      prisma,
      { DATABASE_URL: 'postgresql://x', AUDIT_EXPORT_URL: 'https://siem.example.test/in' },
      () => undefined,
    );

    await sink.record(entry, tx);
    expect(created).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
  });

  it('writes locally only when nothing configures forwarding', async () => {
    const { prisma, tx, created, enqueued } = prismaWith({});
    const sink = await buildAuditSink(prisma, { DATABASE_URL: 'postgresql://x' }, () => undefined);

    await sink.record(entry, tx);
    expect(created).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
  });

  it('queues anyway, and says so, when the forwarding state cannot be resolved', async () => {
    const { tx, enqueued } = prismaWith({});
    const broken = {
      providerSetting: {
        findUnique: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as PrismaService;
    const warnings: string[] = [];

    const sink = await buildAuditSink(
      broken,
      { DATABASE_URL: 'postgresql://x', AUDIT_EXPORT_URL: 'http://not-https.example.test' },
      (line) => warnings.push(line),
    );

    await sink.record(entry, tx);
    expect(enqueued).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/audit export configuration/i);
    expect(warnings.join('\n')).toMatch(/queued for forwarding/);
  });
});

describe('run (the entry point)', () => {
  /**
   * The property this whole command is built around: the password reaches
   * nothing a person or another process can read. Every output channel —
   * the injected writers, console.*, and the process streams — is captured
   * and searched for both the password and the hash.
   */
  function captureEverything() {
    const seen: string[] = [];
    const keep = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
    };
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation(keep);
    }
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      keep(chunk);
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      keep(chunk);
      return true;
    });
    return seen;
  }

  afterEach(() => jest.restoreAllMocks());

  function io(
    over: Partial<Parameters<typeof run>[0]> & { users?: FakeUser[]; failWith?: Error } = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const { db, calls } = fakeDb(over.users ?? [user()]);
    const disconnect = jest.fn(async () => undefined);
    const prisma = Object.assign(
      over.failWith === undefined
        ? db
        : {
            $transaction: async () => {
              throw over.failWith;
            },
          },
      {
        $disconnect: disconnect,
        // buildAuditSink reads the forwarding selection; nothing stored.
        providerSetting: { findUnique: async () => null },
        auditLog: { create: async () => ({ id: 'log-1' }) },
      },
    ) as unknown as PrismaService;

    return {
      out,
      err,
      calls,
      disconnect,
      args: {
        argv: ['node', 'reset-password.js', 'admin@example.com'],
        env: { DATABASE_URL: 'postgresql://x', NEXUSPUPPET_RESET_HOST: 'console01' },
        stdin: Readable.from([`${PASSWORD}\n`]),
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        connect: async () => prisma,
        hash: async () => HASH,
        ...over,
      },
    };
  }

  it('resets, prints the success line, disconnects — and never shows the password or hash', async () => {
    const seen = captureEverything();
    const t = io();

    const code = await run(t.args);

    expect(code).toBe(EXIT.ok);
    expect(t.out[0]).toBe(
      'Password reset for admin@example.com. Sessions ended; account unlocked and active.',
    );
    expect(t.calls.updates[0]?.data['passwordHash']).toBe(HASH);
    expect(t.disconnect).toHaveBeenCalled();
    const everything = [...t.out, ...t.err, ...seen].join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(HASH);
  });

  it('maps each refusal to its exit code', async () => {
    captureEverything();
    await expect(run(io({ users: [] }).args)).resolves.toBe(EXIT.notFound);
    await expect(run(io({ users: [user({ authSource: 'ldap' })] }).args)).resolves.toBe(
      EXIT.notLocal,
    );
    await expect(run(io({ stdin: Readable.from(['short\n']) }).args)).resolves.toBe(
      EXIT.invalidPassword,
    );
  });

  it('redacts the password and hash from an unexpected error', async () => {
    const seen = captureEverything();
    const t = io({
      failWith: new Error(`update failed: data { passwordHash: "${HASH}" } for ${PASSWORD}`),
    });

    const code = await run(t.args);

    expect(code).toBe(EXIT.failed);
    expect(t.err.join('\n')).toMatch(/nothing was changed.*\[redacted\]/i);
    const everything = [...t.out, ...t.err, ...seen].join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(HASH);
  });

  it('refuses to read from a terminal, which would echo the password', async () => {
    captureEverything();
    const stdin = Object.assign(Readable.from([]), { isTTY: true });
    const t = io({ stdin });

    await expect(run(t.args)).resolves.toBe(EXIT.failed);
    expect(t.err.join('\n')).toMatch(/terminal/);
    expect(t.calls.transactions).toBe(0);
  });

  it('needs exactly one email argument', async () => {
    captureEverything();
    await expect(run(io({ argv: ['node', 'x'] }).args)).resolves.toBe(EXIT.failed);
    await expect(run(io({ argv: ['node', 'x', 'a@b.c', PASSWORD] }).args)).resolves.toBe(
      EXIT.failed,
    );
  });
});
