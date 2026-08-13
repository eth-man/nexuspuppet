import type { AuditRecord, AuditTransaction } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { AuditDeliveryOutbox } from '../src/auth/audit-delivery.outbox';
import { SettingsStore } from '../src/settings/settings.store';

/**
 * Settings changes must be forwardable (#103), against a REAL PostgreSQL.
 *
 * THE BUG. A forwarding sink enqueues delivery inside the transaction that
 * carried the change — that is the whole point of the outbox, and it is why the
 * sink declines to enqueue when handed no transaction. The settings services
 * called `audit.record()` without one, so their records were written and never
 * queued: a SIEM saw every classification change, and not the change that
 * repointed the directory or switched forwarding OFF.
 *
 * A mock cannot show this. The claim is about what is COMMITTED, and about two
 * rows sharing one transaction — so it is asserted against the database.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

/**
 * Stands in for the enterprise forwarding sink.
 *
 * It follows the same rule the real one does — enqueue only when given a
 * transaction — because that rule is what the fix has to satisfy. A stub that
 * enqueued unconditionally would pass whether or not the bug was fixed.
 */
class ForwardingSink extends PrismaAuditSink {
  declinedWithoutTransaction = 0;

  constructor(
    prisma: PrismaService,
    private readonly outbox: AuditDeliveryOutbox,
  ) {
    super(prisma);
  }

  override async record(entry: AuditRecord, tx?: AuditTransaction): Promise<string> {
    const id = await super.record(entry, tx);
    if (tx === undefined) {
      this.declinedWithoutTransaction += 1;
      return id;
    }
    await this.outbox.enqueue(tx as never, id);
    return id;
  }
}

jest.setTimeout(30_000);

describe('settings changes reach the forwarding queue (integration)', () => {
  let prisma: PrismaService;
  let sink: ForwardingSink;
  let store: SettingsStore;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.auditDeliveryJob.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.providerSetting.deleteMany();
    sink = new ForwardingSink(prisma, new AuditDeliveryOutbox(prisma));
    // No encryption key: none of these settings carry a secret field.
    store = new SettingsStore(prisma, undefined, 'db');
  });

  const queued = () => prisma.auditDeliveryJob.count();

  /*
   * THE SHAPE THE FIX INTRODUCES, exercised directly: the store write and the
   * audit record inside one transaction, which is what lets the sink enqueue.
   */
  it('queues delivery when the change and the record share a transaction', async () => {
    await prisma.$transaction(async (tx) => {
      await store.clear('auth.ldap', tx);
      await sink.record(
        {
          actorUserId: null,
          actorEmail: 'ops@example.com',
          action: 'settings.auth.ldap.clear',
          entityType: 'ProviderSetting',
          entityId: 'auth.ldap',
          before: { url: 'ldaps://old.example.com' },
          after: null,
        },
        tx,
      );
    });

    expect(await queued()).toBe(1);
    expect(sink.declinedWithoutTransaction).toBe(0);
  });

  /*
   * THE BUG ITSELF, pinned so it cannot come back unnoticed. This is exactly
   * what the settings services used to do.
   */
  it('does NOT queue delivery when the record arrives without one', async () => {
    await store.clear('auth.ldap');
    await sink.record({
      actorUserId: null,
      actorEmail: 'ops@example.com',
      action: 'settings.auth.ldap.clear',
      entityType: 'ProviderSetting',
      entityId: 'auth.ldap',
      before: { url: 'ldaps://old.example.com' },
      after: null,
    });

    // The record exists — it was never the record that was missing.
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await queued()).toBe(0);
    expect(sink.declinedWithoutTransaction).toBe(1);
  });

  /*
   * THE RECORD A SIEM MOST WANTS. Switching forwarding off is the one change an
   * attacker would make first, and it was the one change that never arrived.
   */
  it('queues the change that switches forwarding off', async () => {
    await prisma.$transaction(async (tx) => {
      await store.save('audit.forwarding', { active: 'none' }, [], 'ops@example.com', tx);
      await sink.record(
        {
          actorUserId: null,
          actorEmail: 'ops@example.com',
          action: 'settings.audit.forwarding.update',
          entityType: 'ProviderSetting',
          entityId: 'audit.forwarding',
          before: { active: 'syslog' },
          after: { active: 'none' },
        },
        tx,
      );
    });

    expect(await queued()).toBe(1);
  });

  /*
   * A rollback must take BOTH with it. The alternative — a queued delivery for a
   * change that never happened — is the failure the outbox exists to prevent,
   * and it is worse than never forwarding at all.
   */
  it('queues nothing when the transaction rolls back', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await store.clear('auth.oidc', tx);
        await sink.record(
          {
            actorUserId: null,
            actorEmail: 'ops@example.com',
            action: 'settings.auth.oidc.clear',
            entityType: 'ProviderSetting',
            entityId: 'auth.oidc',
            before: {},
            after: null,
          },
          tx,
        );
        throw new Error('something later failed');
      }),
    ).rejects.toThrow('something later failed');

    expect(await queued()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});
