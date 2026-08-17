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

/*
 * A peer that fetches and never reports (ADR-0022).
 *
 * FOUND IN OUR OWN LAB. The receipts collector was pointed at a different
 * instance from the one serving the tree, so a Puppet server fetched 2705 times
 * and reported nothing. The estate converged perfectly; the console said
 * `compiled 0/N` for ever with no way to tell that from "no agent has run yet".
 */
describe('replication.not-reporting', () => {
  const HOUR = 3600;

  const peer = (over: Record<string, unknown> = {}) => ({
    certname: 'puppet.corp.local',
    lastFetchAt: '2026-08-17T00:00:00.000Z',
    lastStatus: 304,
    lastChangedAt: '2026-08-14T00:00:00.000Z',
    fetchCount: 2705,
    behind: false,
    reportedCount: 0,
    secondsSinceChange: 72 * HOUR,
    ...over,
  });

  const statusWith = (p: Record<string, unknown>) =>
    ({
      ...INPUT.status,
      replication: {
        enabled: true,
        allowedCertnames: ['puppet.corp.local'],
        lastMaterializedAt: '2026-08-14T00:00:00.000Z',
        peers: [peer(p)],
      },
    }) as CatalogueInput['status'];

  const key = 'replication.not-reporting:puppet.corp.local';

  it('fires when a peer has held a tree for days and reported nothing', () => {
    expect(failing({ status: statusWith({}) })).toContain(key);
  });

  it('names the likely cause rather than the symptom', () => {
    const reading = find({ status: statusWith({}) }, key);

    expect(reading?.summary).toContain('collector');
    expect(reading?.summary).toContain('different origin');
    // The point of the condition: it says WHY the front is stuck.
    expect(reading?.summary).toContain('cannot tell which nodes have applied');
  });

  /*
   * THE FALSE ALARM THIS AVOIDS. Receipts appear only when an agent runs, and
   * Puppet's default runinterval is 30 minutes — so a peer holding a tree it
   * received five minutes ago has nothing to report YET, and saying otherwise
   * would fire on every fresh install.
   */
  it('stays quiet inside the grace window', () => {
    expect(failing({ status: statusWith({ secondsSinceChange: 5 * 60 }) })).not.toContain(key);
    expect(failing({ status: statusWith({ secondsSinceChange: 90 * 60 }) })).not.toContain(key);
  });

  it('fires only once past four run intervals', () => {
    expect(failing({ status: statusWith({ secondsSinceChange: 2 * HOUR - 1 }) })).not.toContain(
      key,
    );
    expect(failing({ status: statusWith({ secondsSinceChange: 2 * HOUR + 1 }) })).toContain(key);
  });

  it('stays quiet once the peer reports anything at all', () => {
    expect(failing({ status: statusWith({ reportedCount: 1 }) })).not.toContain(key);
  });

  /*
   * A peer that has NEVER received a tree has nothing to report on, and is
   * already covered by replication.behind. Firing both would be two alerts for
   * one fault.
   */
  it('stays quiet for a peer that has never received a tree', () => {
    expect(
      failing({ status: statusWith({ lastChangedAt: null, secondsSinceChange: null }) }),
    ).not.toContain(key);
  });

  it('is a warning, not critical — the estate is converging fine', () => {
    expect(find({ status: statusWith({}) }, key)?.severity).toBe('warning');
  });
});

/*
 * The mirror of replication.not-reporting, and the other half of one real fault:
 * two deployments sharing a Puppet server whose collector posts receipts to one
 * while its tree comes from the other. Measured on the affected instance:
 *
 *   receipts held: 1, peers that ever fetched: 0
 */
describe('replication.unexpected-receipts', () => {
  const statusWith = (reportingStrangers: string[]) =>
    ({
      ...INPUT.status,
      replication: {
        enabled: true,
        allowedCertnames: [],
        lastMaterializedAt: null,
        peers: [],
        reportingStrangers,
      },
    }) as CatalogueInput['status'];

  it('fires for a peer that reports without ever fetching', () => {
    expect(failing({ status: statusWith(['puppet.corp.local']) })).toContain(
      'replication.unexpected-receipts:puppet.corp.local',
    );
  });

  it('says where the reports actually belong', () => {
    const reading = find(
      { status: statusWith(['puppet.corp.local']) },
      'replication.unexpected-receipts:puppet.corp.local',
    );

    expect(reading?.summary).toContain('never');
    expect(reading?.summary).toContain('somebody else served');
    expect(reading?.summary).toContain('the origin it fetches from');
  });

  it('says nothing when every reporting peer also fetches', () => {
    expect(
      failing({ status: statusWith([]) }).filter((k) => k.startsWith('replication.unexpected')),
    ).toEqual([]);
  });

  it('reports one condition per stranger, so each can be resolved on its own', () => {
    const keys = failing({ status: statusWith(['a.example.com', 'b.example.com']) }).filter((k) =>
      k.startsWith('replication.unexpected-receipts'),
    );

    expect(keys).toHaveLength(2);
  });

  it('is a warning — the estate is fine, the bookkeeping is not', () => {
    expect(
      find(
        { status: statusWith(['x.example.com']) },
        'replication.unexpected-receipts:x.example.com',
      )?.severity,
    ).toBe('warning');
  });
});
