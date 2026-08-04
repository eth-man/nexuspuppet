import { Injectable, Logger } from '@nestjs/common';
import type {
  AuthResult,
  AuthenticatedPrincipal,
  Credentials,
  DirectoryUser,
  IAuthProvider,
  IUserDirectory,
  UserRole,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, needsRehash, verifyPassword } from './password';

/**
 * Local account authentication (ADR-0006).
 *
 * Registered by core under the AUTH_PROVIDER token. The enterprise layer may
 * replace it with LDAP, SAML, or OIDC; nothing downstream changes, because
 * everything downstream consumes only AuthenticatedPrincipal.
 *
 * This class deliberately knows nothing about JWTs, cookies, refresh tokens, or
 * permissions. Session issuance lives in TokenService and authorization in
 * RbacPolicy, so swapping the provider cannot alter either.
 */
export interface LockoutPolicy {
  /** Consecutive failures before locking. 0 disables lockout. */
  maxFailedAttempts: number;
  /** How long the lock lasts. */
  lockoutMinutes: number;
}

@Injectable()
export class LocalAuthProvider implements IAuthProvider {
  readonly source = 'local';
  readonly mode = 'credentials' as const;

  private readonly logger = new Logger(LocalAuthProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lockout: LockoutPolicy = { maxFailedAttempts: 5, lockoutMinutes: 15 },
  ) {}

  async authenticate(credentials: Credentials): Promise<AuthResult> {
    const email = normalizeEmail(credentials.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Verify against a dummy hash when the user is absent so a missing account
    // and a wrong password take the same time. Returning early on "no such
    // user" turns login into a user-enumeration oracle.
    if (user === null || user.passwordHash === null) {
      await verifyPassword(credentials.password, DUMMY_HASH);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    // A locked account still pays the full scrypt cost before being refused.
    //
    // Skipping the hash here would make a locked account answer in a
    // millisecond while every other rejection takes ~100ms — turning lockout
    // itself into the enumeration oracle the dummy-hash path above exists to
    // prevent. The result is discarded on purpose.
    if (this.isLocked(user)) {
      await verifyPassword(credentials.password, user.passwordHash);
      this.logger.warn(
        `Rejected a login for ${user.email}: account is locked until ` +
          `${user.lockedUntil?.toISOString() ?? 'unknown'}.`,
      );
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const valid = await verifyPassword(credentials.password, user.passwordHash);
    if (!valid) {
      await this.recordFailure(user);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    // Checked AFTER the password so a disabled account cannot be distinguished
    // from a wrong password without knowing the password.
    if (!user.isActive) {
      return { ok: false, reason: 'ACCOUNT_DISABLED' };
    }

    // The self-describing hash format lets us raise cost factors later and
    // upgrade records transparently on next successful login.
    if (needsRehash(user.passwordHash)) {
      try {
        const upgraded = await hashPassword(credentials.password);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: upgraded },
        });
        this.logger.log(`Upgraded password hash parameters for ${user.email}.`);
      } catch (error) {
        // A failed upgrade must not fail an otherwise valid login.
        this.logger.warn(
          `Could not upgrade password hash for ${user.email}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        // Consecutive, not cumulative: one success clears the history. A
        // counter that only ever climbed would lock out anyone who mistyped
        // their password five times over a year.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    return { ok: true, principal: toPrincipal(user) };
  }

  /**
   * Whether the account is currently refusing passwords.
   *
   * An expired lock counts as unlocked without needing a sweep: the row is
   * tidied on the next failure or success. A background job to clear them would
   * be a moving part earning nothing.
   */
  private isLocked(user: { lockedUntil: Date | null }, now: Date = new Date()): boolean {
    return user.lockedUntil !== null && user.lockedUntil > now;
  }

  /**
   * Count a failure and lock the account once the threshold is crossed.
   *
   * A failure to WRITE this must not turn into a failed login for someone with
   * the right password, so it is best-effort and logged.
   */
  private async recordFailure(user: {
    id: string;
    email: string;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
  }): Promise<void> {
    if (this.lockout.maxFailedAttempts === 0) return;

    // Counted from the stored value rather than incremented blindly, so an
    // expired lock starts a fresh streak instead of resuming an old one.
    const attempts = this.isLocked(user) ? user.failedLoginAttempts + 1 : nextAttemptCount(user);
    const locked = attempts >= this.lockout.maxFailedAttempts;

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: locked ? 0 : attempts,
          lockedUntil: locked
            ? new Date(Date.now() + this.lockout.lockoutMinutes * 60_000)
            : user.lockedUntil,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not record a failed login for ${user.email}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (locked) {
      // Security-relevant and worth finding in a log. It is NOT told to the
      // caller: the response stays identical to a wrong password, or lockout
      // becomes a way to discover which addresses are real.
      this.logger.warn(
        `Locked ${user.email} for ${this.lockout.lockoutMinutes} minute(s) after ` +
          `${this.lockout.maxFailedAttempts} consecutive failed attempts.`,
      );
    }
  }

  /** Re-resolve on refresh, so a role change or deactivation takes effect. */
  async resolve(userId: string): Promise<AuthenticatedPrincipal | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null || !user.isActive) return null;
    return toPrincipal(user);
  }
}

/** Core's user directory: Postgres-backed and writable. */
@Injectable()
export class LocalUserDirectory implements IUserDirectory {
  private readonly logger = new Logger(LocalUserDirectory.name);

  readonly readOnly = false;

  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<DirectoryUser | null> {
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    return user === null ? null : toDirectoryUser(user);
  }

  async findById(userId: string): Promise<DirectoryUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user === null ? null : toDirectoryUser(user);
  }

  /**
   * Cache what an external authority asserted at login.
   *
   * Only ever called by a provider that is NOT LocalAuthProvider — a local
   * password login has no external authority to defer to, and its role is
   * already the row's own. Writing here for a local login would let a stale
   * value overwrite an administrator's deliberate change.
   *
   * `updatedAt` moves, which is intentional: an operator looking at a user row
   * should be able to see that the directory last confirmed this role.
   */
  async recordLogin(
    userId: string,
    // A role NAME, which since ADR-0018 may be a custom one a directory group
    // maps to — not only the built-in three.
    update: { role: string; displayName: string },
  ): Promise<void> {
    /*
     * BOTH columns, or they drift.
     *
     * This wrote `role` and left `roleId` pointing wherever the account was
     * provisioned. The schema comment already said the two move together; this
     * was the one place that did not, and the drift is invisible because the
     * console displays the NAME while every guard and count reads the KEY.
     *
     * It showed up as a directory user signing in as OPERATOR while the Roles
     * card reported OPERATOR held by nobody — and worse, silently: the
     * last-administrator guard counts by roleRef, so an admin whose key still
     * said VIEWER did not count as an administrator at all.
     */
    const role = await this.prisma.role.findUnique({
      where: { name: update.role },
      select: { id: true },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        role: update.role,
        // Left alone when the name resolves to nothing. The column is NOT NULL,
        // and pointing it at a guess would be worse than leaving it stale —
        // the account still resolves no permissions by name, which is the
        // documented behaviour for a mapping naming a role that does not exist
        // (ADR-0018 §5).
        ...(role === null ? {} : { roleId: role.id }),
        displayName: update.displayName,
        lastLoginAt: new Date(),
      },
    });

    if (role === null) {
      this.logger.warn(
        `Signed in a user whose directory role "${update.role}" is not a role this deployment ` +
          'defines. They will resolve no permissions until the mapping names an existing role.',
      );
    }
  }

  async list(options: { limit: number; offset: number }): Promise<{
    users: DirectoryUser[];
    total: number;
  }> {
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        take: options.limit,
        skip: options.offset,
        orderBy: { email: 'asc' },
      }),
      this.prisma.user.count(),
    ]);

    return { users: rows.map(toDirectoryUser), total };
  }
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  authSource: string;
}

interface DirectoryRow extends UserRow {
  isActive: boolean;
}

/**
 * The directory view carries account status; the principal deliberately does
 * not. A provider that cannot see `isActive` cannot enforce a deactivation.
 */
function toDirectoryUser(user: DirectoryRow): DirectoryUser {
  return { ...toPrincipal(user), isActive: user.isActive };
}

function toPrincipal(user: UserRow): AuthenticatedPrincipal {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role as UserRole,
    authSource: user.authSource,
  };
}

/**
 * The next value of the consecutive-failure counter.
 *
 * Resets to 1 when a previous lock has expired: the streak that produced that
 * lock is spent, and carrying it forward would lock the account again on the
 * very next mistake.
 */
function nextAttemptCount(user: { failedLoginAttempts: number; lockedUntil: Date | null }): number {
  const lockExpired = user.lockedUntil !== null && user.lockedUntil <= new Date();
  return lockExpired ? 1 : user.failedLoginAttempts + 1;
}

/** Emails are compared case-insensitively; stored lowercase (ADR-0005). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A real scrypt hash of a value nobody knows, used to equalise timing for
 * absent accounts. Generated once with the current parameters.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
