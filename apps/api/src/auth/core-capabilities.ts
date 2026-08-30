import { Injectable, Logger } from '@nestjs/common';
import type { AuditRecord, AuditTransaction, IAuditSink } from '@nexuspuppet/contracts';
import { auditLabel } from './audit-label';
import { currentRequestId } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from './password';
import { normalizeEmail } from './local-auth.provider';
import { builtInRoleId } from './users.service';

/**
 * Core implementations of the remaining capability tokens.
 *
 * ADR-0002 requires a core default for EVERY token. A token with no core
 * implementation would mean the product is incomplete without the enterprise
 * layer, which is exactly what open core must not be.
 */

/**
 * Writes audit records to Postgres.
 *
 * `record` takes an optional transaction client because a classification change
 * and its audit row must land together (ADR-0005). An audit trail that can be
 * missing entries for changes that did happen is worse than none, because it
 * looks authoritative.
 */
@Injectable()
export class PrismaAuditSink implements IAuditSink {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditRecord, tx?: AuditTransaction): Promise<string> {
    // Narrowed here rather than in the interface: what a transaction IS belongs
    // to this implementation, not to the contract every sink shares.
    const client = (tx as AuditCapableClient | undefined) ?? this.prisma;
    const row = await client.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        // Prisma distinguishes SQL NULL from JSON null on nullable Json
        // columns; omitting the key is how you write SQL NULL.
        ...(entry.before === undefined || entry.before === null
          ? {}
          : { before: entry.before as object }),
        ...(entry.after === undefined || entry.after === null
          ? {}
          : { after: entry.after as object }),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        // Both filled HERE, not at the twenty call sites that write audit rows.
        // A field each caller has to remember is a field some caller forgets,
        // and a row missing from a correlation query is invisible.
        //
        // An explicit value still wins: a sink used outside a request, or a
        // caller that genuinely knows better, can pass its own.
        requestId: entry.requestId ?? currentRequestId(),
        entityLabel: entry.entityLabel ?? auditLabel(entry.before, entry.after),
      },
      select: { id: true },
    });
    return row.id;
  }
}

/**
 * The narrow slice of a Prisma client this sink uses.
 *
 * Deliberately structural rather than Prisma's own type: the transaction
 * arrives through the contract as an opaque handle, and re-deriving Prisma's
 * full client type here would tie the contract to the ORM.
 *
 * `create` is declared to return the id because the interface now returns it —
 * a composing sink has to be able to reference the record its delegate wrote.
 */
export interface AuditCapableClient {
  auditLog: {
    create(args: { data: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }>;
  };
}

/**
 * Seeds the first administrator on an empty database.
 *
 * Without this, a fresh deployment has no way in: every route requires
 * authentication, and creating a user requires being authenticated. Seeding
 * runs only when the users table is EMPTY, so it can never silently reset or
 * re-create an account on an existing installation.
 */
@Injectable()
export class BootstrapService {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: string | undefined,
    private readonly password: string | undefined,
  ) {}

  async seedAdminIfEmpty(): Promise<void> {
    const existing = await this.prisma.user.count();
    if (existing > 0) return;

    if (this.email === undefined || this.password === undefined) {
      this.logger.warn(
        'No users exist and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are unset. ' +
          'Nobody can log in. Set both, restart, and remove them once the account exists.',
      );
      return;
    }

    await this.prisma.user.create({
      data: {
        email: normalizeEmail(this.email),
        displayName: 'Administrator',
        passwordHash: await hashPassword(this.password),
        role: 'ADMIN',
        // In lockstep with the enum from the very first user onwards (ADR-0018).
        roleId: await builtInRoleId(this.prisma, 'ADMIN'),
        authSource: 'local',
      },
    });

    this.logger.warn(
      `Created the initial administrator ${normalizeEmail(this.email)} from BOOTSTRAP_ADMIN_*. ` +
        'Remove those variables from the environment now that the account exists.',
    );
  }
}

/**
 * Rate limits login attempts.
 *
 * scrypt is deliberately expensive (~100ms and 32 MiB per verification), which
 * protects stolen hashes but makes an unthrottled login endpoint a cheap
 * denial-of-service: a few hundred concurrent attempts will exhaust CPU and
 * memory. Throttling is therefore part of the password design, not an extra.
 *
 * In-memory and per-process. Behind multiple replicas the effective limit is
 * per replica; a shared store is the obvious upgrade, and is noted rather than
 * pretended away.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 60_000,
  ) {}

  /** @returns true when the attempt is allowed. */
  consume(key: string, now: number = Date.now()): boolean {
    this.sweep(now);

    const entry = this.attempts.get(key);

    if (entry === undefined || now >= entry.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxAttempts) return false;

    entry.count += 1;
    return true;
  }

  /** Called after a successful login so a legitimate user is not penalised. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  private sweep(now: number): void {
    // Bounded cleanup: without it the map grows with every distinct source
    // address, which is itself a memory-exhaustion vector.
    if (this.attempts.size < 10_000) return;
    for (const [key, entry] of this.attempts) {
      if (now >= entry.resetAt) this.attempts.delete(key);
    }
  }
}
