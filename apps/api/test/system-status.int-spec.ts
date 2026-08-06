import type { IAuditTransport } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditDeliveryOutbox } from '../src/auth/audit-delivery.outbox';
import { NoopAuditTransport } from '../src/auth/audit-delivery.worker';
import { SystemStatusService } from '../src/system/system-status.service';
import { roleIdFor } from './support/roles';

/**
 * The operational status surface, against a REAL PostgreSQL.
 *
 * The number this exists for is `materialization.failed`. A job that exhausts
 * its attempts is written back with status FAILED, and nothing in this codebase
 * ever claims, retries or clears it — `drainLocked` selects `status: 'PENDING'`
 * only. Each one is a node whose ENC file could not be written, still running
 * its previous classification, with nothing scheduled to fix it.
 *
 * Before this surface existed the only trace was a single ERROR log line at the
 * moment it happened. These tests assert that a stranded node is now visible,
 * and that the error text explaining it does not reach someone who should not
 * have it.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(30_000);

/** A transport that reports itself installed, so the audit section appears. */
class ConfiguredTransport implements IAuditTransport {
  readonly name = 'webhook';
  readonly configured = true;
  async deliver(): Promise<void> {
    /* never called here */
  }
}

/** Enough of the projector for the status service; the real one needs config. */
const projectorReporting = (absent: string[]) =>
  ({ factsNoNodeReports: () => absent }) as unknown as ConstructorParameters<
    typeof SystemStatusService
  >[2];

/** A forwarding view for a deployment with nothing configured (issue #95). */
const forwardingOff = () =>
  ({
    describe: async () => ({
      active: 'none',
      syslog: {
        source: 'unset',
        config: null,
        disabled: false,
        secretsHeld: [],
        updatedAt: null,
        updatedByEmail: null,
        liveReload: false,
      },
      webhook: {
        source: 'unset',
        config: null,
        disabled: false,
        secretsHeld: [],
        updatedAt: null,
        updatedByEmail: null,
        liveReload: false,
      },
    }),
  }) as unknown as ConstructorParameters<typeof SystemStatusService>[4];

const RETENTION = {
  retentionDays: 90,
  maxRows: null,
  intervalMs: 0,
  batchSize: 500,
  maxBatchesPerPass: 10,
};

describe('system status (integration)', () => {
  let prisma: PrismaService;
  let outbox: AuditDeliveryOutbox;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    outbox = new AuditDeliveryOutbox(prisma);
    await prisma.auditDeliveryJob.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.encMaterializationJob.deleteMany();
    await prisma.managedNode.deleteMany();
    await prisma.user.deleteMany();
  });

  const service = (transport: IAuditTransport = new NoopAuditTransport(), absent: string[] = []) =>
    new SystemStatusService(
      prisma,
      outbox,
      projectorReporting(absent),
      transport,
      forwardingOff(),
      () => false,
      RETENTION,
      { enabled: false, allowedCertnames: [] },
    );

  const queueJob = (dedupeKey: string, over: Record<string, unknown> = {}) =>
    prisma.encMaterializationJob.create({
      data: { dedupeKey, certname: `${dedupeKey}.test`, reason: 'test', ...over },
    });

  describe('materialization', () => {
    it('reports an empty deployment as idle rather than broken', async () => {
      const status = await service().status(false);

      expect(status.materialization).toEqual({
        pending: 0,
        failed: 0,
        oldestDueAt: null,
        failures: [],
      });
    });

    it('counts queued work', async () => {
      await queueJob('node:a');
      await queueJob('node:b');

      const status = await service().status(false);

      expect(status.materialization.pending).toBe(2);
      expect(status.materialization.failed).toBe(0);
    });

    /**
     * The whole point. A FAILED job is a permanent tombstone: nothing retries
     * it, nothing clears it, and the node keeps its previous classification
     * indefinitely.
     */
    it('surfaces a permanently failed job as a stranded node', async () => {
      await queueJob('node:stranded', {
        status: 'FAILED',
        attempts: 3,
        lastError: 'InvalidEncDocumentError: "Bad::Name" is not a valid Puppet class name',
      });

      const status = await service().status(true);

      expect(status.materialization.failed).toBe(1);
      // Not counted as pending: it is not queued for anything.
      expect(status.materialization.pending).toBe(0);
      expect(status.materialization.failures[0]?.certname).toBe('node:stranded.test');
      expect(status.materialization.failures[0]?.attempts).toBe(3);
    });

    it('reports when the oldest queued job became due', async () => {
      const due = new Date(Date.now() - 600_000);
      await queueJob('node:old', { nextAttemptAt: due });
      await queueJob('node:new', { nextAttemptAt: new Date() });

      const status = await service().status(false);

      expect(status.materialization.oldestDueAt).toBe(due.toISOString());
    });

    /**
     * A pathological estate could strand thousands of nodes, and a status
     * endpoint returning thousands of error strings is a second outage rather
     * than a report on the first.
     */
    it('bounds how many failures it returns', async () => {
      for (let i = 0; i < 25; i += 1) {
        await queueJob(`node:${i}`, { status: 'FAILED', attempts: 3, lastError: 'boom' });
      }

      const status = await service().status(true);

      expect(status.materialization.failed).toBe(25);
      expect(status.materialization.failures).toHaveLength(20);
    });
  });

  describe('who may see error text', () => {
    /**
     * A materialization error carries filesystem paths; an audit delivery error
     * carries the collector's hostname. Counts are for anyone who may read the
     * inventory; the strings are for an administrator.
     */
    it('withholds error detail when detail was not requested', async () => {
      await queueJob('node:stranded', {
        status: 'FAILED',
        attempts: 3,
        lastError: 'EACCES: permission denied, open /etc/puppetlabs/nexuspuppet/nodes/x.yaml',
      });

      const status = await service().status(false);

      // The problem is still visible — only the explanation is withheld.
      expect(status.materialization.failed).toBe(1);
      expect(status.materialization.failures).toEqual([]);
      expect(status.includesDetail).toBe(false);
      expect(JSON.stringify(status)).not.toContain('/etc/puppetlabs');
    });

    it('includes it when detail was requested', async () => {
      await queueJob('node:stranded', {
        status: 'FAILED',
        attempts: 3,
        lastError: 'EACCES: permission denied',
      });

      const status = await service().status(true);

      expect(status.includesDetail).toBe(true);
      expect(status.materialization.failures[0]?.lastError).toContain('EACCES');
    });
  });

  describe('audit delivery', () => {
    /**
     * Core forwards audit records nowhere, and that is a complete product
     * rather than a fault. Reporting an empty queue for a deployment that was
     * never going to deliver anything would invite treating it as broken.
     */
    it('is absent when no transport is installed', async () => {
      const status = await service(new NoopAuditTransport()).status(true);

      expect(status.auditDelivery).toBeUndefined();
    });

    it('reports the queue when a transport is installed', async () => {
      const status = await service(new ConfiguredTransport()).status(false);

      expect(status.auditDelivery).toMatchObject({
        configured: true,
        transport: 'webhook',
        pending: 0,
      });
    });

    it('counts records waiting for a collector that is not accepting them', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'ops@example.com',
          displayName: 'Ops',
          role: 'ADMIN',
          roleId: await roleIdFor(prisma, 'ADMIN'),
          passwordHash: 'x',
          isActive: true,
        },
      });
      const row = await prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'x',
          entityType: 'NodeGroup',
        },
      });
      await prisma.$transaction((tx) => outbox.enqueue(tx, row.id));
      await prisma.auditDeliveryJob.updateMany({
        data: { attempts: 4, lastError: 'connect ECONNREFUSED siem.internal:8088' },
      });

      const status = await service(new ConfiguredTransport()).status(true);

      expect(status.auditDelivery?.pending).toBe(1);
      expect(status.auditDelivery?.failures[0]?.attempts).toBe(4);
      expect(status.auditDelivery?.failures[0]?.lastError).toContain('ECONNREFUSED');
    });

    it('withholds the collector hostname from a caller without detail', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'ops@example.com',
          displayName: 'Ops',
          role: 'ADMIN',
          roleId: await roleIdFor(prisma, 'ADMIN'),
          passwordHash: 'x',
          isActive: true,
        },
      });
      const row = await prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'x',
          entityType: 'NodeGroup',
        },
      });
      await prisma.$transaction((tx) => outbox.enqueue(tx, row.id));
      await prisma.auditDeliveryJob.updateMany({
        data: { attempts: 4, lastError: 'connect ECONNREFUSED siem.internal:8088' },
      });

      const status = await service(new ConfiguredTransport()).status(false);

      expect(status.auditDelivery?.pending).toBe(1);
      expect(JSON.stringify(status)).not.toContain('siem.internal');
    });
  });

  describe('projection', () => {
    it('reports estate size and staleness', async () => {
      const older = new Date(Date.now() - 900_000);
      await prisma.managedNode.create({
        data: { certname: 'a.test', facts: {}, environment: 'production', projectedAt: older },
      });
      await prisma.managedNode.create({
        data: { certname: 'b.test', facts: {}, environment: 'production' },
      });

      const status = await service().status(false);

      expect(status.projection.nodes).toBe(2);
      expect(status.projection.oldestProjectedAt).toBe(older.toISOString());
    });

    it('reports nothing stale for an empty estate', async () => {
      const status = await service().status(false);

      expect(status.projection).toEqual({
        nodes: 0,
        oldestProjectedAt: null,
        factsNoNodeReports: [],
      });
    });

    /**
     * A rule against a fact nothing reports can never match, and nothing about
     * the group would look wrong. This is the condition that cost this project
     * two releases to find.
     */
    it('names projected facts that no node reports', async () => {
      const status = await service(new NoopAuditTransport(), ['role', 'fqdn']).status(false);

      expect(status.projection.factsNoNodeReports).toEqual(['role', 'fqdn']);
    });
  });
});
