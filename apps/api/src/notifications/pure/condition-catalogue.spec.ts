import type { SystemStatus } from '@nexuspuppet/contracts';
import {
  readConditions,
  CERT_EXPIRY_WARNING_DAYS,
  type CatalogueInput,
} from './condition-catalogue';

const STATUS: SystemStatus = {
  materialization: { pending: 0, failed: 0, oldestDueAt: null, failures: [] },
  auditForwarding: {
    available: false,
    active: 'none',
    configured: false,
    pending: 0,
    unconfirmableDelivery: false,
    lastDelivery: null,
  },
  retention: {
    ageDays: 90,
    maxRows: null,
    undeliveredDropped: { total: 0, lastDroppedAt: null },
  },
  projection: { nodes: 10, oldestProjectedAt: null, factsNoNodeReports: [] },
  includesDetail: false,
} as unknown as SystemStatus;

const INPUT: CatalogueInput = {
  status: STATUS,
  puppetDbReachable: true,
  puppetDbLastSuccessAt: '2026-08-07T10:00:00.000Z',
  consoleCertDaysRemaining: null,
  announcedUndeliveredDrops: 0,
  pruneSkippedReason: null,
};

const read = (over: Partial<CatalogueInput> = {}) => readConditions({ ...INPUT, ...over });
const find = (over: Partial<CatalogueInput>, key: string) => read(over).find((r) => r.key === key);
const failing = (over: Partial<CatalogueInput> = {}) =>
  read(over)
    .filter((r) => r.failing)
    .map((r) => r.key);

describe('condition catalogue', () => {
  it('reports nothing failing on a healthy deployment', () => {
    expect(failing()).toEqual([]);
  });

  /*
   * BINDING CONSTRAINT, ADR-0021 §1. The moment a summary names a person or an
   * action, this feature is audit forwarding without the capability. Asserted
   * rather than trusted, because it is the constraint most likely to erode by
   * accident — one plausible-looking feature request at a time.
   */
  it('never names a person or an action in any summary', () => {
    const everyFailing = read({
      status: {
        ...STATUS,
        materialization: { ...STATUS.materialization, failed: 3 },
        retention: {
          ageDays: 90,
          maxRows: null,
          undeliveredDropped: { total: 5, lastDroppedAt: null },
        },
      } as unknown as SystemStatus,
      puppetDbReachable: false,
      pruneSkippedReason: 'the estate looked implausibly small',
      consoleCertDaysRemaining: 3,
    });

    for (const reading of everyFailing) {
      expect(reading.summary).not.toMatch(/\b(user|by |actor|changed by|alice|admin@)/i);
    }
  });

  describe('classification is not reaching disk', () => {
    it('fails when jobs are stranded', () => {
      const status = { ...STATUS, materialization: { ...STATUS.materialization, failed: 2 } };
      expect(failing({ status: status as unknown as SystemStatus })).toContain(
        'materialization.stranded',
      );
    });
  });

  describe('replication', () => {
    const withReplication = (peers: unknown[], enabled = true) =>
      ({
        ...STATUS,
        replication: {
          enabled,
          allowedCertnames: ['puppet.corp.local'],
          lastMaterializedAt: null,
          peers,
        },
      }) as unknown as SystemStatus;

    it('is silent when the deployment does not replicate', () => {
      expect(failing({ status: withReplication([], false) })).toEqual([]);
    });

    it('fails when nothing has ever fetched', () => {
      expect(failing({ status: withReplication([]) })).toContain('replication.no-peer');
    });

    it('fails per peer that is behind, keyed by certname', () => {
      const status = withReplication([
        {
          certname: 'a.corp.local',
          lastFetchAt: 'x',
          lastStatus: 304,
          lastChangedAt: 'y',
          fetchCount: 1,
          behind: true,
        },
        {
          certname: 'b.corp.local',
          lastFetchAt: 'x',
          lastStatus: 304,
          lastChangedAt: 'y',
          fetchCount: 1,
          behind: false,
        },
      ]);

      expect(failing({ status })).toContain('replication.behind:a.corp.local');
      expect(failing({ status })).not.toContain('replication.behind:b.corp.local');
    });

    it('distinguishes never-received from merely behind', () => {
      const status = withReplication([
        {
          certname: 'a.corp.local',
          lastFetchAt: 'x',
          lastStatus: 304,
          lastChangedAt: null,
          fetchCount: 9,
          behind: true,
        },
      ]);

      expect(find({ status }, 'replication.behind:a.corp.local')?.summary).toContain(
        'never received',
      );
    });
  });

  describe('puppetdb', () => {
    it('fails when unreachable, and says what still works', () => {
      const reading = find({ puppetDbReachable: false }, 'puppetdb.unreachable');

      expect(reading?.failing).toBe(true);
      // Warning, not critical: agents keep converging from disk (ADR-0003).
      expect(reading?.severity).toBe('warning');
    });
  });

  describe('the prune guard', () => {
    it('fails when the projector refused to prune, and quotes the reason', () => {
      const reading = find(
        { pruneSkippedReason: 'response too small' },
        'projection.prune-refused',
      );

      expect(reading?.failing).toBe(true);
      expect(reading?.summary).toContain('response too small');
      expect(reading?.summary).toContain('Nothing was deleted');
    });
  });

  describe('audit delivery', () => {
    it('is absent where the capability is, rather than reported healthy', () => {
      expect(read().some((r) => r.key === 'audit.delivery-failing')).toBe(false);
    });

    it('fails when the last delivery failed', () => {
      const status = {
        ...STATUS,
        auditForwarding: {
          ...STATUS.auditForwarding,
          available: true,
          active: 'syslog',
          lastDelivery: { ok: false, at: 'x', error: null },
        },
      } as unknown as SystemStatus;

      expect(failing({ status })).toContain('audit.delivery-failing');
    });
  });

  describe('dropped audit records (self-resolving)', () => {
    const dropped = (total: number) =>
      ({
        ...STATUS,
        retention: {
          ageDays: 90,
          maxRows: null,
          undeliveredDropped: { total, lastDroppedAt: null },
        },
      }) as unknown as SystemStatus;

    it('fails when new drops appear, and is marked self-resolving', () => {
      const reading = find(
        { status: dropped(5), announcedUndeliveredDrops: 0 },
        'audit.records-dropped',
      );

      expect(reading?.failing).toBe(true);
      expect(reading?.selfResolving).toBe(true);
    });

    /*
     * The counter is cumulative. Comparing it against what has already been
     * announced is what stops it re-opening on every evaluation, forever,
     * about a drop from last March.
     */
    it('does not re-fire for drops already announced', () => {
      expect(failing({ status: dropped(5), announcedUndeliveredDrops: 5 })).not.toContain(
        'audit.records-dropped',
      );
    });

    it('reports only the NEW drops', () => {
      expect(
        find({ status: dropped(8), announcedUndeliveredDrops: 5 }, 'audit.records-dropped')
          ?.summary,
      ).toContain('3 audit record');
    });
  });

  describe('console certificate', () => {
    it('is absent when no certificate is configured — not a fault', () => {
      expect(
        read({ consoleCertDaysRemaining: null }).some((r) => r.key === 'console-cert.expiring'),
      ).toBe(false);
    });

    it('is healthy well before expiry', () => {
      expect(failing({ consoleCertDaysRemaining: CERT_EXPIRY_WARNING_DAYS + 1 })).toEqual([]);
    });

    it('fails at the threshold', () => {
      expect(failing({ consoleCertDaysRemaining: CERT_EXPIRY_WARNING_DAYS })).toContain(
        'console-cert.expiring',
      );
    });

    it('is critical once expired', () => {
      expect(find({ consoleCertDaysRemaining: 0 }, 'console-cert.expiring')?.severity).toBe(
        'critical',
      );
    });
  });
});
