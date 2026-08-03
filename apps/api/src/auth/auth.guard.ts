import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUTHORIZATION_POLICY,
  type AuthenticatedPrincipal,
  type AuthorizationTarget,
  type IAuthorizationPolicy,
  type Permission,
} from '@nexuspuppet/contracts';
import type { Request } from 'express';
import { TokenService } from './token.service';
import { JwtError } from './jwt';

export const IS_PUBLIC = 'nexuspuppet:isPublic';
export const REQUIRED_PERMISSION = 'nexuspuppet:permission';
export const REQUIRED_ANY_PERMISSION = 'nexuspuppet:any-permission';

/** Opt a route out of authentication. Everything else is protected by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Declare the permission a route requires.
 *
 * A protected route with no permission is authenticated but unauthorized-by-
 * default: AuthGuard rejects it. Access must be granted deliberately, never by
 * omission.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/**
 * Grants a route to a principal holding ANY of these permissions.
 *
 * A separate decorator and a separate metadata key, deliberately: the
 * single-permission path above is unchanged, and a reader can tell which rule
 * applies from the decorator name alone. Folding OR semantics into
 * `RequirePermission` would have made every existing route's meaning depend on
 * whether somebody had passed one argument or two.
 *
 * The case that needs it: assigning a role to a user requires `users:manage`,
 * but the list of role names to assign FROM was readable only with
 * `settings:manage`. A role granting just `users:manage` could therefore
 * administer users while being unable to see a single role to give them.
 */
export const RequireAnyPermission = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_ANY_PERMISSION, permissions);

/** The authenticated principal, attached by AuthGuard. */
export interface AuthenticatedRequest extends Request {
  principal?: AuthenticatedPrincipal;
}

export const ACCESS_COOKIE = 'nexuspuppet_access';
export const REFRESH_COOKIE = 'nexuspuppet_refresh';

/**
 * Authentication and authorization for every route (ADR-0006).
 *
 * Applied globally, so a new controller is protected by default and forgetting
 * a decorator FAILS CLOSED. Both opt-outs are explicit, greppable, and visible
 * in review.
 *
 * Authorization is resolved through the AUTHORIZATION_POLICY token rather than
 * a concrete class, so the enterprise layer's scoped RBAC replaces it without
 * this guard changing. Likewise the principal arrives from whichever provider
 * is registered; this guard never learns whether it came from a local password,
 * an LDAP bind, or a SAML assertion.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @Inject(AUTHORIZATION_POLICY) private readonly policy: IAuthorizationPolicy,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractToken(request);

    if (token === null) {
      throw new UnauthorizedException('Authentication required.');
    }

    let principal: AuthenticatedPrincipal;
    try {
      principal = this.tokens.verifyAccessToken(token);
    } catch (error) {
      // Distinguish expiry so the client knows to refresh rather than to
      // re-prompt for a password.
      if (error instanceof JwtError && error.reason === 'EXPIRED') {
        throw new UnauthorizedException({
          error: 'TOKEN_EXPIRED',
          message: 'Access token has expired; refresh the session.',
        });
      }
      throw new UnauthorizedException('Invalid access token.');
    }

    request.principal = principal;

    const permission = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);

    const anyOf = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_ANY_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Authenticated but with no declared permission: deny. Access is granted by
    // an explicit @RequirePermission or @RequireAnyPermission, never by
    // forgetting one.
    if (permission === undefined && anyOf === undefined) {
      throw new ForbiddenException(
        'This route declares no required permission and is therefore denied.',
      );
    }

    if (permission === undefined) {
      const target = targetFrom(request);
      if (!anyOf.some((candidate) => this.policy.can(principal, candidate, target))) {
        throw new ForbiddenException({
          error: 'INSUFFICIENT_PERMISSION',
          message: `Your role (${principal.role}) grants none of: ${anyOf.join(', ')}.`,
          required: anyOf,
        });
      }
      return true;
    }

    if (!this.policy.can(principal, permission, targetFrom(request))) {
      throw new ForbiddenException({
        error: 'INSUFFICIENT_PERMISSION',
        message: `Your role (${principal.role}) does not grant "${permission}".`,
        required: permission,
      });
    }

    return true;
  }
}

/**
 * Accept the session cookie first, then a bearer header.
 *
 * The cookie is HttpOnly, so browser JavaScript cannot read it and an XSS
 * cannot exfiltrate the session. The bearer header exists for scripts and
 * CI, which have no cookie jar.
 */
function extractToken(request: Request): string | null {
  const cookie = parseCookies(request.headers.cookie)[ACCESS_COOKIE];
  if (cookie !== undefined && cookie !== '') return cookie;

  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value !== '') return value;
  }

  return null;
}

/**
 * Minimal cookie parsing, to avoid a dependency for one header.
 * Only the first occurrence of a name is honoured, so a duplicated cookie
 * cannot be used to smuggle a second value past the first.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;

    const name = part.slice(0, index).trim();
    if (name === '' || Object.prototype.hasOwnProperty.call(out, name)) continue;

    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[name] = part.slice(index + 1).trim();
    }
  }

  return out;
}

/**
 * Derive the authorization target from the route, so scoped principals are
 * checked against the thing they are acting on rather than in the abstract.
 */
function targetFrom(request: Request): AuthorizationTarget | undefined {
  const params = request.params as Record<string, string | undefined>;
  const query = request.query as Record<string, unknown>;

  const groupId = params['groupId'] ?? params['id'];
  const certname = params['certname'];
  const environment = typeof query['environment'] === 'string' ? query['environment'] : undefined;

  if (groupId === undefined && certname === undefined && environment === undefined) {
    return undefined;
  }

  return {
    ...(groupId === undefined ? {} : { groupId }),
    ...(certname === undefined ? {} : { certname }),
    ...(environment === undefined ? {} : { environment }),
  };
}
