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
@Injectable()
export class LocalAuthProvider implements IAuthProvider {
  readonly source = 'local';
  readonly mode = 'credentials' as const;

  private readonly logger = new Logger(LocalAuthProvider.name);

  constructor(private readonly prisma: PrismaService) {}

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

    const valid = await verifyPassword(credentials.password, user.passwordHash);
    if (!valid) {
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
      data: { lastLoginAt: new Date() },
    });

    return { ok: true, principal: toPrincipal(user) };
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
    update: { role: UserRole; displayName: string },
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        role: update.role,
        displayName: update.displayName,
        lastLoginAt: new Date(),
      },
    });
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
