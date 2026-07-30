import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  changePasswordSchema,
  createUserSchema,
  resetPasswordSchema,
  updateUserSchema,
  type ChangePassword,
  type CreateUser,
  type ManagedUser,
  type ResetPassword,
  type UpdateUser,
} from '@nexuspuppet/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UuidParam } from '../common/uuid-param';
import {
  REFRESH_COOKIE,
  RequirePermission,
  parseCookies,
  type AuthenticatedRequest,
} from './auth.guard';
import { UsersService, type AuditContext } from './users.service';

/**
 * User administration.
 *
 * Everything except the self-service password change requires `users:manage`,
 * which only ADMIN holds (ADR-0006).
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('users:manage')
  @Get()
  list(): Promise<ManagedUser[]> {
    return this.users.list();
  }

  @RequirePermission('users:manage')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.create(body, principalOf(request), contextOf(request));
  }

  @RequirePermission('users:manage')
  @Patch(':id')
  update(
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.update(id, body, principalOf(request), contextOf(request));
  }

  /**
   * Deactivate rather than delete.
   *
   * Audit rows reference the actor, and a deleted user would leave the trail
   * describing changes made by nobody. Deactivation preserves the history and
   * is reversible.
   */
  @RequirePermission('users:manage')
  @Delete(':id')
  deactivate(
    @Param('id', UuidParam) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.deactivate(id, principalOf(request), contextOf(request));
  }

  @RequirePermission('users:manage')
  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPassword,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.resetPassword(id, body.newPassword, principalOf(request), contextOf(request));
  }
}

/**
 * Self-service password change.
 *
 * Separate controller because it needs no administrative permission — any
 * authenticated user may change their own password, and requiring
 * `users:manage` would mean only admins could.
 */
@Controller('account')
export class AccountController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('inventory:read')
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePassword,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    // parseCookies, NOT request.cookies. This application registers no
    // cookie-parser, so request.cookies is always undefined — a route that
    // relied on it once shipped with fifteen passing tests, because the fake
    // request those tests built supplied a field the app never produces.
    const currentRefreshToken = parseCookies(request.headers.cookie)[REFRESH_COOKIE];

    await this.users.changeOwnPassword(
      principalOf(request),
      body.currentPassword,
      body.newPassword,
      contextOf(request),
      currentRefreshToken,
    );
  }
}

function principalOf(
  request: AuthenticatedRequest,
): NonNullable<AuthenticatedRequest['principal']> {
  if (request.principal === undefined) throw new UnauthorizedException();
  return request.principal;
}

function contextOf(request: AuthenticatedRequest): AuditContext {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
  };
}
