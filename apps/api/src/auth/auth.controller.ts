import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AUTH_PROVIDER,
  credentialsSchema,
  type AuthenticatedPrincipal,
  type Credentials,
  type IAuthProvider,
} from '@nexuspuppet/contracts';
import type { AuthProviderDescription } from '@nexuspuppet/contracts';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { permissionsFor } from './rbac.policy';
import {
  ACCESS_COOKIE,
  Public,
  REFRESH_COOKIE,
  RequirePermission,
  parseCookies,
  type AuthenticatedRequest,
} from './auth.guard';
import { RefreshTokenError, TokenService, type SessionTokens } from './token.service';
import { LoginRateLimiter } from './core-capabilities';

/**
 * Session endpoints (ADR-0006).
 *
 * These routes are FIXED regardless of which provider is registered. A
 * redirect-mode provider (SAML/OIDC from the enterprise layer) answers the same
 * POST /auth/login with a challenge instead of a session, so the enterprise
 * layer never has to add routes and core never has to know they exist —
 * exactly the coupling ADR-0002 forbids.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: IAuthProvider,
    private readonly tokens: TokenService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  /** Advertises how to log in, so the UI renders a form or an SSO button. */
  @Public()
  @Get('mode')
  mode(): { mode: string; source: string } {
    return { mode: this.provider.mode ?? 'credentials', source: this.provider.source };
  }

  /**
   * The provider's configuration, for an administrator.
   *
   * Deliberately NOT @Public, unlike /auth/mode: group DNs and a directory URL
   * are internal topology, and an unauthenticated caller has no business
   * learning how the estate maps groups to privilege. Gated on settings:manage
   * rather than users:manage — this is deployment configuration, not user
   * administration.
   *
   * Core renders whatever the provider returns without interpreting it, which
   * is what lets an LDAP layer explain itself without core knowing what LDAP is
   * (ADR-0002).
   */
  @RequirePermission('settings:manage')
  @Get('provider')
  describeProvider(): AuthProviderDescription {
    return (
      this.provider.describe?.() ?? {
        source: this.provider.source,
        roleMappings: [],
        refusesUnmappedUsers: false,
        details: [],
      }
    );
  }

  @Public()
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(credentialsSchema)) credentials: Credentials,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ principal: AuthenticatedPrincipal; permissions: string[]; expiresAt: string }> {
    if ((this.provider.mode ?? 'credentials') === 'redirect') {
      throw new BadRequestException({
        error: 'REDIRECT_LOGIN_REQUIRED',
        message: 'This deployment uses an external identity provider. Begin at /auth/redirect.',
      });
    }

    // scrypt costs ~100ms and 32 MiB per attempt, so an unthrottled endpoint is
    // a cheap denial of service. Keyed by source address AND account, so one
    // noisy client cannot lock out an unrelated user.
    const limitKey = `${request.ip ?? 'unknown'}|${credentials.email.toLowerCase()}`;
    if (!this.rateLimiter.consume(limitKey)) {
      throw new HttpException(
        { error: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again shortly.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const result = await this.provider.authenticate(credentials);

    if (!result.ok) {
      // One message for every failure. Distinguishing "no such user" from
      // "wrong password" turns login into a user-enumeration oracle, and
      // naming a disabled account confirms it exists.
      throw new UnauthorizedException('Invalid email or password.');
    }

    this.rateLimiter.reset(limitKey);

    const session = await this.tokens.issue(result.principal, contextOf(request));
    setSessionCookies(response, session, request);

    return {
      principal: result.principal,
      permissions: permissionsFor(result.principal.role),
      expiresAt: session.accessExpiresAt.toISOString(),
    };
  }

  /**
   * Exchange the refresh cookie for a new session.
   *
   * Any failure clears the cookies. A client holding a token we have revoked
   * must not be left retrying it forever — and on reuse detection the whole
   * family is already gone.
   */
  @Public()
  @Post('refresh')
  async refresh(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ expiresAt: string }> {
    const presented = parseCookies(request.headers.cookie)[REFRESH_COOKIE];

    if (presented === undefined || presented === '') {
      throw new UnauthorizedException('No refresh token presented.');
    }

    try {
      const session = await this.tokens.rotate(presented, contextOf(request));
      setSessionCookies(response, session, request);
      return { expiresAt: session.accessExpiresAt.toISOString() };
    } catch (error) {
      clearSessionCookies(response, request);

      if (error instanceof RefreshTokenError) {
        throw new UnauthorizedException({
          error: `REFRESH_${error.reason}`,
          message:
            error.reason === 'REUSED'
              ? 'This session has been revoked because a refresh token was replayed. Please log in again.'
              : 'Session expired. Please log in again.',
        });
      }
      throw error;
    }
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    const presented = parseCookies(request.headers.cookie)[REFRESH_COOKIE];
    if (presented !== undefined && presented !== '') {
      await this.tokens.revoke(presented);
    }

    // Always clear, even when no token was presented: logging out must never
    // leave a cookie behind.
    clearSessionCookies(response, request);
    return { ok: true };
  }

  /**
   * The current session. Requires only the lowest permission every role has, so
   * any authenticated user can discover who they are and what they may do.
   */
  @RequirePermission('inventory:read')
  @Get('me')
  me(@Req() request: AuthenticatedRequest): {
    principal: AuthenticatedPrincipal;
    permissions: string[];
  } {
    const principal = request.principal;
    if (principal === undefined) throw new UnauthorizedException();

    return { principal, permissions: permissionsFor(principal.role) };
  }
}

function contextOf(request: AuthenticatedRequest): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
  };
}

/**
 * HttpOnly so browser JavaScript cannot read them — an XSS cannot exfiltrate
 * the session. SameSite=Lax blocks cross-site POSTs while keeping ordinary
 * top-level navigation working.
 *
 * The refresh cookie is scoped to /auth so it is not sent on every API request;
 * only the endpoints that consume it ever see it.
 */
function setSessionCookies(
  response: Response,
  session: SessionTokens,
  request: AuthenticatedRequest,
): void {
  const secure = isSecure(request);

  response.cookie(ACCESS_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: session.accessExpiresAt,
  });

  response.cookie(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/auth',
    expires: session.refreshExpiresAt,
  });
}

function clearSessionCookies(response: Response, request: AuthenticatedRequest): void {
  const secure = isSecure(request);
  response.clearCookie(ACCESS_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
  response.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/auth' });
}

/**
 * `secure` would make cookies undeliverable over plain HTTP, which is how the
 * dev stack runs. Derived from the request rather than hardcoded, so a
 * production deployment behind TLS gets it automatically.
 */
function isSecure(request: AuthenticatedRequest): boolean {
  return request.secure || request.headers['x-forwarded-proto'] === 'https';
}
