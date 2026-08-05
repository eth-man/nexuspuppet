import type { AuditForwardingView, IAuditTransport } from '@nexuspuppet/contracts';
import type { AuditDeliveryOutbox } from '../auth/audit-delivery.outbox';
import { LAST_DELIVERY_KEY } from '../auth/audit-delivery.worker';
import { UNDELIVERED_DROPS_KEY, type AuditRetentionPolicy } from '../auth/audit-retention.sweeper';
import type { AuditForwardingService } from '../settings/audit-forwarding.service';
import type { NodeProjectionService } from '../puppetdb/node-projection.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SystemStatusService } from './system-status.service';

/** An empty SettingsView of the right shape. */
function unset<T>(): AuditForwardingView['syslog'] & { config: T | null } {
  return {
    source: 'unset',
    config: null,
    disabled: false,
    secretsHeld: [],
    updatedAt: null,
    updatedByEmail: null,
    liveReload: false,
  } as AuditForwardingView['syslog'] & { config: T | null };
}

const OFF_VIEW: AuditForwardingView = { syslog: unset(), webhook: unset(), active: 'none' };

function udpView(): AuditForwardingView {
  return {
    active: 'syslog',
    syslog: {
      ...unset(),
      source: 'database',
      config: {
        host: 'siem.example.test',
        port: 514,
        protocol: 'udp',
        facility: 13,
        appName: 'nexuspuppet',
        timeoutMs: 10_000,
        tlsRejectUnauthorized: true,
      },
    },
    webhook: unset(),
  };
}

/** Only what the service touches; anything else is a wrong turn worth crashing on. */
function fakePrisma(appSettings: Record<string, unknown> = {}): PrismaService {
  return {
    encMaterializationJob: {
      count: async () => 0,
      findFirst: async () => null,
      findMany: async () => [],
    },
    auditDeliveryJob: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    managedNode: {
      count: async () => 0,
      findFirst: async () => null,
    },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key in appSettings ? { key: where.key, value: appSettings[where.key] } : null,
    },
  } as unknown as PrismaService;
}

const OUTBOX = { depth: async () => 3 } as unknown as AuditDeliveryOutbox;
const PROJECTION = { factsNoNodeReports: () => [] } as unknown as NodeProjectionService;

const POLICY: AuditRetentionPolicy = {
  retentionDays: 90,
  maxRows: null,
  intervalMs: 0,
  batchSize: 500,
  maxBatchesPerPass: 10,
};

function build(options?: {
  view?: AuditForwardingView;
  available?: boolean;
  configured?: boolean;
  appSettings?: Record<string, unknown>;
  policy?: Partial<AuditRetentionPolicy>;
}): SystemStatusService {
  const transport = {
    name: 'none',
    configured: options?.configured ?? false,
    deliver: async () => undefined,
  } as IAuditTransport;

  const forwarding = {
    describe: async () => options?.view ?? OFF_VIEW,
  } as unknown as AuditForwardingService;

  return new SystemStatusService(
    fakePrisma(options?.appSettings),
    OUTBOX,
    PROJECTION,
    transport,
    forwarding,
    () => options?.available ?? false,
    { ...POLICY, ...options?.policy },
  );
}

describe('SystemStatusService audit forwarding and retention', () => {
  it('reports the unlicensed case as a state, not an omission', async () => {
    const status = await build().status(false);

    expect(status.auditForwarding).toMatchObject({
      available: false,
      active: 'none',
      configured: false,
      unconfirmableDelivery: false,
      pending: 3,
      lastDelivery: null,
    });
    // The legacy block keeps its old rule: absent when nothing can send.
    expect(status.auditDelivery).toBeUndefined();
  });

  it('raises the unconfirmable flag only while UDP is the ACTIVE mode', async () => {
    const udp = await build({ view: udpView(), available: true, configured: true }).status(false);
    expect(udp.auditForwarding.unconfirmableDelivery).toBe(true);

    const tcp = udpView();
    tcp.syslog.config = { ...tcp.syslog.config!, protocol: 'tcp' };
    expect(
      (await build({ view: tcp, available: true, configured: true }).status(false)).auditForwarding
        .unconfirmableDelivery,
    ).toBe(false);

    // A stored UDP config that is NOT delivering proves nothing either way.
    const stored = udpView();
    stored.active = 'none';
    expect(
      (await build({ view: stored, available: true }).status(false)).auditForwarding
        .unconfirmableDelivery,
    ).toBe(false);
  });

  it('reports "no row ceiling configured" as null, and a configured one as its number', async () => {
    expect((await build().status(false)).retention).toMatchObject({
      ageDays: 90,
      maxRows: null,
      undeliveredDropped: { total: 0, lastDroppedAt: null },
    });

    expect((await build({ policy: { maxRows: 250_000 } }).status(false)).retention.maxRows).toBe(
      250_000,
    );
  });

  it('surfaces the sweeper-recorded drops, which persist because they are rows', async () => {
    const status = await build({
      appSettings: {
        [UNDELIVERED_DROPS_KEY]: { total: 41, lastDroppedAt: '2026-08-05T09:00:00.000Z' },
      },
    }).status(false);

    expect(status.retention.undeliveredDropped).toEqual({
      total: 41,
      lastDroppedAt: '2026-08-05T09:00:00.000Z',
    });
  });

  it('carries the last delivery outcome, withholding the error from non-admins', async () => {
    const appSettings = {
      [LAST_DELIVERY_KEY]: {
        at: '2026-08-05T10:00:00.000Z',
        ok: false,
        delivered: 0,
        error: 'connect ECONNREFUSED siem.example.test:6514',
      },
    };

    const everyone = await build({ appSettings }).status(false);
    expect(everyone.auditForwarding.lastDelivery).toMatchObject({ ok: false, error: null });

    const admin = await build({ appSettings }).status(true);
    expect(admin.auditForwarding.lastDelivery?.error).toContain('ECONNREFUSED');
  });
});
