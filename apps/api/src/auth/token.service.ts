import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_PROVIDER,
  type AuthenticatedPrincipal,
  type IAuthProvider,
} from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { parseDuration, signJwt, verifyJwt, JwtError } from './jwt';

/**
 * Session issuance and refresh-token rotation (ADR-0006).
 *
 * Two tokens, doing different jobs:
 *
 *   access  — short-lived signed JWT (default 15m). Stateless, so no database
 *             round trip per request. The cost is that a revocation takes up to
 *             one access-token lifetime to bite.
 *   refresh — long-lived OPAQUE random value. Only its SHA-256 is stored; the
 *             plaintext exists in the cookie and nowhere else, so a database
 *             leak does not hand over live sessions.
 *
 * ROTATION WITH REUSE DETECTION
 * -----------------------------
 * Every refresh consumes its token and issues a new one in the same FAMILY.
 * Presenting an already-consumed token is the signature of a stolen refresh
 * token being replayed: either the attacker or the legitimate user is using a
 * token the other already spent.
 *
 * We cannot tell which party is which, so the only safe response is to revoke
 * the entire family and force a fresh login. That is deliberately more
 * disruptive than ignoring it — a session that might be compromised is worth
 * less than one login.
 *
 * Refresh tokens are hashed with plain SHA-256 rather than scrypt: they are
 * 256 bits of CSPRNG output, not a human-chosen secret, so there is no
 * dictionary to slow down and the per-request cost of a KDF would buy nothing.
 */

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export class RefreshTokenError extends Error {
  constructor(
    message: string,
    readonly reason: 'UNKNOWN' | 'EXPIRED' | 'REVOKED' | 'REUSED' | 'PRINCIPAL_GONE',
  ) {
    super(message);
    this.name = 'RefreshTokenError';
  }
}

export interface TokenServiceOptions {
  secret: string;
  accessTtl: string;
  refreshTtl: string;
  issuer?: string;
  audience?: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_PROVIDER) private readonly authProvider: IAuthProvider,
    private readonly options: TokenServiceOptions,
  ) {
    this.accessTtlSeconds = parseDuration(options.accessTtl);
    this.refreshTtlSeconds = parseDuration(options.refreshTtl);
  }

  /** Begin a new session. Starts a new rotation family. */
  async issue(
    principal: AuthenticatedPrincipal,
    context: SessionContext = {},
  ): Promise<SessionTokens> {
    return this.mint(principal, randomUUID(), context);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * @throws RefreshTokenError — the caller must clear cookies and force login.
   */
  async rotate(presented: string, context: SessionContext = {}): Promise<SessionTokens> {
    const tokenHash = hashToken(presented);

    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (record === null) {
      // Not a token we ever issued, or one already cleaned up.
      throw new RefreshTokenError('Refresh token is not recognised.', 'UNKNOWN');
    }

    if (record.revokedAt !== null) {
      throw new RefreshTokenError('Refresh token has been revoked.', 'REVOKED');
    }

    if (record.consumedAt !== null) {
      // REUSE. Someone is replaying a spent token; we cannot tell whether it is
      // the attacker or the victim, so the whole family dies.
      await this.revokeFamily(record.familyId, 'refresh token reuse detected');
      this.logger.error(
        `Refresh token reuse detected for user ${record.userId}; revoked session family ${record.familyId}.`,
      );
      throw new RefreshTokenError(
        'Refresh token has already been used; the session family has been revoked.',
        'REUSED',
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new RefreshTokenError('Refresh token has expired.', 'EXPIRED');
    }

    // Re-resolve through the provider so a role change, a deactivation, or a
    // directory removal takes effect at refresh rather than at token expiry.
    const principal = await this.authProvider.resolve(record.userId);
    if (principal === null) {
      await this.revokeFamily(record.familyId, 'principal no longer resolvable');
      throw new RefreshTokenError(
        'The account for this session is no longer active.',
        'PRINCIPAL_GONE',
      );
    }

    // Consume and re-issue atomically: a crash between the two must not leave a
    // session that is neither usable nor revoked.
    return this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });

      return this.mint(principal, record.familyId, context, tx);
    });
  }

  /** End one session. Idempotent — logging out twice is not an error. */
  async revoke(presented: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** End every session in a family. */
  async revokeFamily(familyId: string, _reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** End every session for a user, e.g. after a password change. */
  /**
   * Revoke every session for a user, optionally sparing one.
   *
   * `exceptRefreshToken` spares the rotation FAMILY that token belongs to, not
   * the single row. Refresh rotates: the presented token is consumed and
   * replaced within its family on the next refresh, so excluding one row would
   * spare a token that is about to stop existing and log the caller out anyway.
   *
   * A caller who has just proved possession of the current password should not
   * be signed out by the act of changing it — see changeOwnPassword.
   */
  async revokeAllForUser(userId: string, exceptRefreshToken?: string): Promise<void> {
    let keepFamilyId: string | undefined;

    if (exceptRefreshToken !== undefined && exceptRefreshToken !== '') {
      const current = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(exceptRefreshToken) },
        select: { familyId: true, userId: true },
      });
      // Only ever spare a family belonging to this user. A token from elsewhere
      // must not be able to survive someone else's revocation.
      if (current !== null && current.userId === userId) keepFamilyId = current.familyId;
    }

    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepFamilyId === undefined ? {} : { familyId: { not: keepFamilyId } }),
      },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Verify an access token and rebuild the principal from its claims.
   *
   * Claims rather than a database lookup: this runs on every request, and a
   * query per request would put Postgres on the read path of the whole API. The
   * trade is that a role change lags by up to one access-token lifetime, which
   * is why that lifetime is short and why refresh re-resolves through the
   * provider.
   */
  verifyAccessToken(token: string): AuthenticatedPrincipal {
    const claims = verifyJwt(token, {
      secret: this.options.secret,
      ...(this.options.issuer === undefined ? {} : { issuer: this.options.issuer }),
      ...(this.options.audience === undefined ? {} : { audience: this.options.audience }),
      clockToleranceSeconds: 30,
    });

    const role = claims['role'];
    const email = claims['email'];
    const displayName = claims['name'];
    const authSource = claims['src'];

    if (typeof role !== 'string' || typeof email !== 'string') {
      throw new JwtError('Token is missing identity claims.', 'MALFORMED');
    }

    const scopedGroupIds = claims['sgi'];
    const scopedEnvironments = claims['sev'];

    return {
      userId: claims.sub,
      email,
      displayName: typeof displayName === 'string' ? displayName : email,
      role: role as AuthenticatedPrincipal['role'],
      authSource: typeof authSource === 'string' ? authSource : 'unknown',
      // Enterprise scoped RBAC travels in the token so authorization stays a
      // pure function of the principal (ADR-0006).
      ...(Array.isArray(scopedGroupIds) ? { scopedGroupIds: scopedGroupIds as string[] } : {}),
      ...(Array.isArray(scopedEnvironments)
        ? { scopedEnvironments: scopedEnvironments as string[] }
        : {}),
    };
  }

  private async mint(
    principal: AuthenticatedPrincipal,
    familyId: string,
    context: SessionContext,
    tx?: TxLike,
  ): Promise<SessionTokens> {
    const now = new Date();
    const client = tx ?? this.prisma;

    const accessToken = signJwt({
      secret: this.options.secret,
      subject: principal.userId,
      expiresInSeconds: this.accessTtlSeconds,
      now,
      ...(this.options.issuer === undefined ? {} : { issuer: this.options.issuer }),
      ...(this.options.audience === undefined ? {} : { audience: this.options.audience }),
      claims: {
        email: principal.email,
        name: principal.displayName,
        role: principal.role,
        src: principal.authSource,
        ...(principal.scopedGroupIds === undefined ? {} : { sgi: principal.scopedGroupIds }),
        ...(principal.scopedEnvironments === undefined
          ? {}
          : { sev: principal.scopedEnvironments }),
      },
    });

    // 256 bits of CSPRNG. Opaque by design: it carries no claims, so it cannot
    // be read or trusted by anything but this service.
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTtlSeconds * 1000);

    await client.refreshToken.create({
      data: {
        userId: principal.userId,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: refreshExpiresAt,
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(now.getTime() + this.accessTtlSeconds * 1000),
      refreshExpiresAt,
    };
  }

  /** Housekeeping: drop expired and long-revoked rows. */
  async pruneExpired(olderThan: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: olderThan } },
    });
    return count;
  }
}

/** SHA-256 is right here: the input is 256 bits of CSPRNG, not a human secret. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type TxLike = { refreshToken: { create(args: { data: RefreshTokenCreate }): Promise<unknown> } };

interface RefreshTokenCreate {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}
