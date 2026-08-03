import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
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
import { RoleRegistry } from './role-registry';
import {
  ACCESS_COOKIE,
  Public,
  REFRESH_COOKIE,
  RequirePermission,
  parseCookies,
  type AuthenticatedRequest,
} from './auth.guard';
import { AuthProviderResolver } from './auth-provider.resolver';
import { RefreshTokenError, TokenService, type SessionTokens } from './token.service';
import { LoginRateLimiter } from './core-capabilities';

/**
 * Correlates the two legs of an external login.
 *
 * Scoped to /auth so it is not sent with every request, and short-lived: it is
 * only needed for the seconds a user spends at the identity provider. A long
 * TTL would widen the window in which a stolen state is useful.
 */
const REDIRECT_STATE_COOKIE = 'nexuspuppet_redirect_state';
const REDIRECT_STATE_TTL_MS = 10 * 60 * 1000;

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
    private readonly resolver: AuthProviderResolver,
    @Inject(AUTH_PROVIDER) private readonly provider: IAuthProvider,
    private readonly tokens: TokenService,
    private readonly rateLimiter: LoginRateLimiter,
    private readonly roles: RoleRegistry,
  ) {}

  /** Advertises how to log in, so the UI renders a form or an SSO button. */
  @Public()
  @Get('mode')
  mode(): { mode: string; source: string; identifierLabel: string } {
    return {
      mode: this.provider.mode ?? 'credentials',
      source: this.provider.source,
      // Public on purpose, like the rest of this endpoint: the login form needs
      // it before anyone has authenticated. It reveals only what a user is
      // expected to type.
      identifierLabel: this.provider.identifierLabel ?? 'Email',
    };
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
    const described = this.resolver.describableProvider() ?? this.provider;

    return (
      described.describe?.() ?? {
        source: described.source,
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

    const result = await this.resolver.authenticate(credentials);

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
      permissions: permissionsFor(this.roles, result.principal),
      expiresAt: session.accessExpiresAt.toISOString(),
    };
  }

  /**
   * Begin an external login.
   *
   * The login screen already links here for a redirect-mode provider; until now
   * the route did not exist, so that button produced a 404 and a redirect
   * provider could not be used at all.
   *
   * Core owns the correlation, not the provider: the state the provider mints is
   * stored in a short-lived cookie and required to match on the way back. That
   * is what binds a callback to the browser that started it, and it is the
   * defence against an attacker completing someone else's login in their victim's
   * session (an OAuth login-CSRF).
   */
  @Public()
  @Get('redirect')
  async beginRedirect(
    @Query('returnTo') returnTo: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const redirect = this.resolver.redirectProvider();
    const begin = redirect?.beginRedirect?.bind(redirect);
    if (redirect === null || begin === undefined) {
      throw new BadRequestException({
        error: 'REDIRECT_NOT_SUPPORTED',
        message: 'This deployment does not use an external identity provider.',
      });
    }

    const safeReturnTo = sanitiseReturnTo(returnTo);
    const challenge = await begin(safeReturnTo);

    response.cookie(REDIRECT_STATE_COOKIE, `${challenge.state}|${safeReturnTo}`, {
      httpOnly: true,
      // LAX, not strict. The browser arrives at the callback from the identity
      // provider's domain, and a strict cookie would not be sent on that
      // navigation — the login would fail for everyone, always.
      sameSite: 'lax',
      secure: isSecure(request),
      path: '/auth',
      maxAge: REDIRECT_STATE_TTL_MS,
    });

    response.redirect(challenge.location);
  }

  /**
   * Complete an external login from the identity provider's callback.
   *
   * Everything the provider needs arrives in the query string, and everything
   * core needs to trust it arrives in the cookie. The provider validates the
   * assertion — signature, issuer, audience, nonce; core validates that this
   * browser is the one that asked.
   */
  @Public()
  @Get('callback')
  async completeRedirect(
    @Query() params: Record<string, string>,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const redirect = this.resolver.redirectProvider();
    const complete = redirect?.completeRedirect?.bind(redirect);
    if (redirect === null || complete === undefined) {
      throw new BadRequestException({
        error: 'REDIRECT_NOT_SUPPORTED',
        message: 'This deployment does not use an external identity provider.',
      });
    }

    // parseCookies, NOT request.cookies. This application registers no
    // cookie-parser middleware — every other cookie read here goes through the
    // same helper, and `request.cookies` is permanently undefined.
    const cookie = parseCookies(request.headers.cookie)[REDIRECT_STATE_COOKIE];
    // Single use, cleared before anything can go wrong with it. A state that
    // survived a failed attempt could be replayed.
    response.clearCookie(REDIRECT_STATE_COOKIE, { path: '/auth' });

    if (typeof cookie !== 'string' || cookie.length === 0) {
      throw new UnauthorizedException('Login session expired. Start again.');
    }

    const separator = cookie.indexOf('|');
    const expectedState = separator === -1 ? cookie : cookie.slice(0, separator);
    const returnTo = separator === -1 ? '/' : sanitiseReturnTo(cookie.slice(separator + 1));

    // Constant-time, and length-checked first: a plain !== leaks the position of
    // the first differing byte to a patient attacker.
    if (!statesMatch(expectedState, params['state'])) {
      throw new UnauthorizedException('Login session expired. Start again.');
    }

    const result = await complete(params);
    if (!result.ok) {
      // One message, as for password login: distinguishing failures here would
      // say whether an account exists in the directory.
      throw new UnauthorizedException('Sign-in was refused by the identity provider.');
    }

    const session = await this.tokens.issue(result.principal, contextOf(request));
    setSessionCookies(response, session, request);

    response.redirect(returnTo);
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

    return { principal, permissions: permissionsFor(this.roles, principal) };
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
/**
 * Where the browser may be sent after a successful external login.
 *
 * A RELATIVE PATH ONLY. `returnTo` arrives from the query string and is
 * reflected into a redirect, which is the textbook open-redirect: an attacker
 * sends a victim to a legitimate NexusPuppet login URL that lands them on a
 * lookalike site holding a real session cookie.
 *
 * Rejected: anything with a scheme, anything protocol-relative (`//evil.test`
 * is a HOST, not a path), and anything not starting with a single slash.
 */
export function sanitiseReturnTo(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  // A backslash is treated as a slash by some browsers when resolving a URL,
  // so `/\evil.test` can escape the origin on those.
  if (raw.startsWith('/\\')) return '/';
  if (raw.includes('://')) return '/';
  return raw;
}

/** Constant-time comparison of the correlation state. */
function statesMatch(expected: string, received: string | undefined): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
