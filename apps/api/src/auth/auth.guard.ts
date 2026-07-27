import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'nexuspuppet:isPublic';

/** Opt a route out of authentication. Everything else is protected by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Global authentication guard (ADR-0006).
 *
 * Applied globally so a new controller is protected by default and forgetting
 * a decorator fails CLOSED. Opting out is explicit, visible in review, and
 * greppable.
 *
 * ---------------------------------------------------------------------------
 * INTERIM STATE — authentication is not yet implemented.
 *
 * LocalAuthProvider, the JWT issuance/refresh flow, and the RBAC policy are
 * still to be built. Until they land this guard has no way to identify a
 * caller, and the endpoints behind it proxy an mTLS certificate that can read
 * the ENTIRE estate (ADR-0004). Shipping that ungated would be an open
 * read-proxy for the whole Puppet infrastructure.
 *
 * So it fails closed where it matters:
 *
 *   production   → 503. The API refuses to serve protected routes at all until
 *                  a real auth provider is wired in. Loud, not silent.
 *   development  → allowed, with a warning logged once per process.
 *
 * The dev allowance exists so the walking skeleton is usable before auth is
 * finished. It is keyed off NODE_ENV rather than a config flag on purpose:
 * there is no setting an operator can flip to get this behaviour in
 * production.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private static readonly logger = new Logger(AuthGuard.name);
  private static warned = false;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) return true;

    if (process.env['NODE_ENV'] === 'production') {
      throw new ServiceUnavailableException({
        error: 'AUTH_NOT_CONFIGURED',
        message:
          'Authentication is not yet implemented in this build. Protected routes are disabled in production ' +
          'rather than served without an identity, because they proxy an estate-wide PuppetDB credential.',
      });
    }

    if (!AuthGuard.warned) {
      AuthGuard.warned = true;
      AuthGuard.logger.warn(
        'AUTHENTICATION IS NOT IMPLEMENTED. Protected routes are open in this development process. ' +
          'This build must not be exposed to an untrusted network, and will refuse to serve them under NODE_ENV=production.',
      );
    }

    return true;
  }
}

/** Placeholder for the eventual UnauthorizedException path, kept for symmetry. */
export const unauthenticated = (): never => {
  throw new UnauthorizedException();
};
