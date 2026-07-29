import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

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

  /*
   * A KNOWN DEPRECATION, deliberately not worked around.
   *
   *   DeprecationWarning: Calling client.query() when the client is already
   *   executing a query is deprecated and will be removed in pg@9.0.
   *
   * An interactive transaction pins one connection, and Prisma's interpreter
   * loads `include` relations concurrently over it. Measured, rather than
   * guessed at — every shape tested against this schema:
   *
   *   tx + findUnique, four include relations ....... WARNS
   *   tx + findUnique, one include relation ......... clean
   *   tx + findUnique, no include ................... clean
   *   tx + two sequential queries ................... clean
   *   tx + two concurrent queries (Promise.all) ..... clean
   *   pooled (no tx) + four include relations ....... clean
   *
   * Two things follow, and both are counterintuitive enough to be worth
   * writing down. `Promise.all` over a transaction client is NOT the cause —
   * Prisma serialises those above the adapter. And the trigger is not raw SQL
   * or anything this codebase does by hand: it is `loadOrThrow`'s
   * `include: { rules, classes, parameters, pins }` running inside the
   * transaction that every classification write needs (ADR-0005 Rule 5).
   *
   * Avoiding it would mean fetching those four relations ourselves, in
   * sequence, on the pinned connection of a transaction already holding locks
   * — four extra round-trips per write to silence a warning that belongs to
   * @prisma/adapter-pg. Not worth it while it is only noise.
   *
   * IT STOPS BEING NOISE AT pg 9. Before that upgrade, re-run the shapes above:
   * if the adapter has not learned to serialise, the transaction the whole
   * classification write path depends on begins to throw.
   */

  /**
   * Run `work` while holding a Postgres advisory lock, or skip it entirely if
   * another replica already holds the lock.
   *
   * TRANSACTION-SCOPED, NOT SESSION-SCOPED. This distinction is the whole
   * reason this method is subtle enough to need a comment.
   *
   * `pg_advisory_lock` / `pg_advisory_unlock` are scoped to a SESSION — that
   * is, to one connection. Prisma runs every query through a connection POOL,
   * so a lock taken by one `$queryRaw` and released by another can easily be
   * taken on connection A and released on connection B. The release then
   * no-ops (Postgres merely warns), connection A keeps the lock for as long as
   * the pool keeps it alive, and the materializer never runs again. It would
   * deadlock itself permanently after its first tick, silently, in production.
   *
   * `pg_try_advisory_xact_lock` is held for the duration of a transaction and
   * released automatically on commit or rollback. Prisma's interactive
   * transactions pin a single connection, so lock and release are guaranteed to
   * be the same session. There is no unlock call to get wrong.
   *
   * The transaction exists only to scope the lock; `work` uses the pool
   * normally. Mutual exclusion still holds, because exclusion comes from the
   * lock rather than from the transaction's isolation.
   *
   * Deliberately non-blocking (`try`): a materializer tick that cannot get the
   * lock returns immediately and lets the holder proceed rather than queueing
   * behind it. The next tick tries again.
   *
   * @returns the result of `work`, or null if the lock was not acquired.
   */
  async withAdvisoryLock<T>(
    lockKey: bigint,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T | null> {
    // A full reconcile over a large estate can outlast Prisma's 5s default.
    const timeout = options.timeoutMs ?? 120_000;

    return this.$transaction(
      async (tx) => {
        const [acquired] = await tx.$queryRaw<[{ locked: boolean }]>`
          SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS locked
        `;

        if (acquired?.locked !== true) return null;

        // The transaction client is HANDED to the work rather than merely held
        // around it. Work that reaches for the top-level client instead runs on
        // a different connection and commits independently — so a rollback here
        // would leave it applied, which for the outbox means claimed jobs vanish
        // while their work is unfinished.
        return work(tx);
      },
      { timeout, maxWait: 5_000 },
    );
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
  /** Held by the single active audit delivery worker (ADR-0005). */
  AUDIT_DELIVERY: 8_442_004n,
} as const;
