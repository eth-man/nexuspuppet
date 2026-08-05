import { Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AuditRetentionSweeper,
  UNDELIVERED_DROPS_KEY,
  type AuditRetentionPolicy,
  type UndeliveredDrops,
} from './audit-retention.sweeper';

const NOW = new Date('2026-08-05T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

interface LogRow {
  id: string;
  createdAt: Date;
  /** Models the presence of an AuditDeliveryJob row. */
  pendingDelivery: boolean;
}

/**
 * The prisma surface the sweeper touches, in memory. Where-clause handling is
 * deliberately narrow: it implements exactly the queries the sweeper makes,
 * and throws on anything else rather than guessing.
 */
class FakeDb {
  logs: LogRow[] = [];
  readonly appSettings = new Map<string, { key: string; value: unknown }>();
  lockHeldElsewhere = false;

  private readonly tx = {
    auditLog: {
      findMany: async (args: {
        where?: { createdAt?: { lt: Date }; deliveryJob?: { is: null } };
        orderBy: { createdAt: 'asc' };
        take: number;
        select: { id: true; deliveryJob?: { select: { id: true } } };
      }): Promise<Array<{ id: string; deliveryJob?: { id: string } | null }>> => {
        let rows = [...this.logs];
        if (args.where?.createdAt !== undefined) {
          const cutoff = args.where.createdAt.lt;
          rows = rows.filter((row) => row.createdAt < cutoff);
        }
        if (args.where?.deliveryJob !== undefined) {
          rows = rows.filter((row) => !row.pendingDelivery);
        }
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        rows = rows.slice(0, args.take);

        return rows.map((row) =>
          args.select.deliveryJob === undefined
            ? { id: row.id }
            : {
                id: row.id,
                deliveryJob: row.pendingDelivery ? { id: `job-${row.id}` } : null,
              },
        );
      },

      count: async (): Promise<number> => this.logs.length,

      deleteMany: async (args: {
        where: { id: { in: string[] } };
      }): Promise<{ count: number }> => {
        const ids = new Set(args.where.id.in);
        const before = this.logs.length;
        // The delivery-job cascade is the schema's job; here a log row and its
        // pending flag simply vanish together.
        this.logs = this.logs.filter((row) => !ids.has(row.id));
        return { count: before - this.logs.length };
      },
    },

    appSetting: {
      findUnique: async (args: {
        where: { key: string };
      }): Promise<{ key: string; value: unknown } | null> =>
        this.appSettings.get(args.where.key) ?? null,

      upsert: async (args: {
        where: { key: string };
        create: { key: string; value: unknown };
        update: { value: unknown };
      }): Promise<{ key: string; value: unknown }> => {
        const existing = this.appSettings.get(args.where.key);
        const row =
          existing === undefined
            ? { key: args.create.key, value: args.create.value }
            : { ...existing, value: args.update.value };
        this.appSettings.set(args.where.key, row);
        return row;
      },
    },
  };

  readonly withAdvisoryLock = async <T>(
    _lock: bigint,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | null> => {
    if (this.lockHeldElsewhere) return null;
    return work(this.tx as unknown as Prisma.TransactionClient);
  };

  seed(count: number, options: { ageDays: number; pending?: boolean; prefix?: string }): void {
    for (let i = 0; i < count; i += 1) {
      this.logs.push({
        id: `${options.prefix ?? `d${options.ageDays}`}-${i}`,
        // Spread rows a millisecond apart so oldest-first is deterministic.
        createdAt: new Date(daysAgo(options.ageDays).getTime() + i),
        pendingDelivery: options.pending ?? false,
      });
    }
  }

  drops(): UndeliveredDrops | null {
    return (this.appSettings.get(UNDELIVERED_DROPS_KEY)?.value as UndeliveredDrops) ?? null;
  }
}

const POLICY: AuditRetentionPolicy = {
  retentionDays: 90,
  maxRows: null,
  intervalMs: 0,
  batchSize: 10,
  maxBatchesPerPass: 3,
};

function build(overrides?: Partial<AuditRetentionPolicy>): { sweeper: AuditRetentionSweeper; db: FakeDb } {
  const db = new FakeDb();
  const sweeper = new AuditRetentionSweeper(db as unknown as PrismaService, {
    ...POLICY,
    ...overrides,
  });
  return { sweeper, db };
}

describe('AuditRetentionSweeper', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('age-based sweeping', () => {
    it('deletes rows older than the window and keeps rows inside it', async () => {
      const { sweeper, db } = build();
      db.seed(5, { ageDays: 100, prefix: 'old' });
      db.seed(5, { ageDays: 10, prefix: 'young' });

      const result = await sweeper.sweep(NOW);

      expect(result.agedDeleted).toBe(5);
      expect(db.logs).toHaveLength(5);
      expect(db.logs.every((row) => row.id.startsWith('young'))).toBe(true);
    });

    it('does NOT delete an aged row that still has a pending delivery job', async () => {
      const { sweeper, db } = build();
      db.seed(3, { ageDays: 200, pending: true, prefix: 'stuck' });
      db.seed(2, { ageDays: 200, prefix: 'deliverable' });

      const result = await sweeper.sweep(NOW);

      expect(result.agedDeleted).toBe(2);
      expect(db.logs).toHaveLength(3);
      expect(db.logs.every((row) => row.pendingDelivery)).toBe(true);
    });

    it('does NOT delete a row exactly at the cutoff', async () => {
      const { sweeper, db } = build();
      db.logs.push({ id: 'boundary', createdAt: daysAgo(90), pendingDelivery: false });

      const result = await sweeper.sweep(NOW);

      expect(result.agedDeleted).toBe(0);
      expect(db.logs).toHaveLength(1);
    });
  });

  describe('row ceiling', () => {
    it('deletes nothing by count when no ceiling is configured, however large the table', async () => {
      const { sweeper, db } = build({ maxRows: null });
      db.seed(50, { ageDays: 1 });

      const result = await sweeper.sweep(NOW);

      expect(result.ceilingDeleted).toBe(0);
      expect(db.logs).toHaveLength(50);
    });

    it('deletes oldest-first down to the ceiling, pending deliveries included, and records the drops', async () => {
      const { sweeper, db } = build({ maxRows: 1_000 });
      db.seed(2, { ageDays: 30, pending: true, prefix: 'oldest-stuck' });
      db.seed(1_001, { ageDays: 5, prefix: 'young' });

      const result = await sweeper.sweep(NOW);

      expect(result.ceilingDeleted).toBe(3);
      expect(result.undeliveredDropped).toBe(2);
      expect(db.logs).toHaveLength(1_000);
      expect(db.logs.some((row) => row.id.startsWith('oldest-stuck'))).toBe(false);
      expect(db.drops()).toMatchObject({ total: 2, lastDroppedAt: NOW.toISOString() });
    });

    it('accumulates the dropped-undelivered count across passes', async () => {
      const { sweeper, db } = build({ maxRows: 1_000 });
      db.seed(1_002, { ageDays: 5, pending: true });
      await sweeper.sweep(NOW);

      db.seed(3, { ageDays: 4, pending: true, prefix: 'later' });
      await sweeper.sweep(NOW);

      expect(db.drops()?.total).toBe(5);
    });
  });

  describe('the per-pass budget', () => {
    it('stops rather than catching up in one pass, and finishes on later passes', async () => {
      const { sweeper, db } = build({ batchSize: 2, maxBatchesPerPass: 2 });
      db.seed(10, { ageDays: 100 });

      const first = await sweeper.sweep(NOW);
      expect(first.agedDeleted).toBe(4);
      expect(first.exhaustedBudget).toBe(true);
      expect(db.logs).toHaveLength(6);

      await sweeper.sweep(NOW);
      const third = await sweeper.sweep(NOW);
      expect(db.logs).toHaveLength(0);
      expect(third.exhaustedBudget).toBe(false);
    });

    it('spends what the age sweep left on the ceiling', async () => {
      const { sweeper, db } = build({ batchSize: 2, maxBatchesPerPass: 3, maxRows: 1_000 });
      db.seed(1, { ageDays: 100, prefix: 'aged' });
      db.seed(1_003, { ageDays: 5, prefix: 'young' });

      const result = await sweeper.sweep(NOW);

      // One partial age batch, then two ceiling batches (a full one and the
      // 1-row remainder) from the shared budget — and the pass reports itself
      // finished, because it is.
      expect(result.agedDeleted).toBe(1);
      expect(result.ceilingDeleted).toBe(3);
      expect(result.exhaustedBudget).toBe(false);
      expect(db.logs).toHaveLength(1_000);
    });
  });

  describe('leader election', () => {
    it('does nothing when another replica holds the lock', async () => {
      const { sweeper, db } = build();
      db.seed(5, { ageDays: 100 });
      db.lockHeldElsewhere = true;

      const result = await sweeper.sweep(NOW);

      expect(result.ranHere).toBe(false);
      expect(result.agedDeleted).toBe(0);
      expect(db.logs).toHaveLength(5);
    });
  });
});
