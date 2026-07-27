import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma access (ADR-0005).
 *
 * Prisma 7 takes its connection through a driver adapter rather than a `url` in
 * schema.prisma; the migration CLI reads ../prisma.config.ts instead.
 *
 * This is also the ONLY place raw SQL is permitted, and only for advisory
 * locks, which Prisma does not model. Advisory locks are what elect a single
 * materializer across multiple api replicas without adding Redis or a
 * leader-election sidecar.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(connectionString: string) {
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `work` while holding a Postgres session-level advisory lock, or skip it
   * entirely if another replica already holds the lock.
   *
   * Deliberately non-blocking (`pg_try_advisory_lock`): a materializer tick that
   * cannot get the lock should return immediately and let the holder proceed,
   * not queue up behind it. The next tick will try again.
   *
   * @returns the result of `work`, or null if the lock was not acquired.
   */
  async withAdvisoryLock<T>(lockKey: bigint, work: () => Promise<T>): Promise<T | null> {
    const [acquired] = await this.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_lock(${lockKey}::bigint) AS locked
    `;

    if (acquired?.locked !== true) {
      return null;
    }

    try {
      return await work();
    } finally {
      // Must always release: a session-level lock outlives the transaction and
      // would otherwise wedge materialization until the connection is recycled.
      await this.$queryRaw`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
    }
  }
}

/**
 * Stable lock identifiers. Chosen constants rather than hashes so that two
 * versions of the code can never disagree about which lock is which.
 */
export const ADVISORY_LOCKS = {
  /** Held by the single active ENC materializer (ADR-0003). */
  ENC_MATERIALIZER: 8_442_001n,
  /** Held during a full reconcile sweep. */
  ENC_RECONCILER: 8_442_002n,
  /** Held while projecting PuppetDB into ManagedNode (ADR-0004). */
  NODE_PROJECTION: 8_442_003n,
} as const;
