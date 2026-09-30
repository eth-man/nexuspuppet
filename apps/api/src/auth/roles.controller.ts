import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  type CreateRole,
  type Role,
  type UpdateRole,
  createRoleSchema,
  updateRoleSchema,
} from '@nexuspuppet/contracts';
import { RequireAnyPermission, RequirePermission, type AuthenticatedRequest } from './auth.guard';
import { RolesService } from './roles.service';

/**
 * Role administration (ADR-0018 §6).
 *
 * Every deployment can define its own roles (ADR-0027). Until then, writing
 * answered 501 without the `rbac.custom` capability; that gate is gone. The
 * lockout rules that make editing safe live in RolesService and are unchanged.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /*
   * Readable by anybody who can act on it. Assigning a role to a user needs
   * `users:manage`; without this, such a principal could administer users and
   * see no role to give them. Only the LIST is widened — creating, editing and
   * deleting remain `settings:manage`.
   */
  @RequireAnyPermission('settings:manage', 'users:manage')
  @Get()
  list(): Promise<Role[]> {
    return this.roles.list();
  }

  @RequirePermission('settings:manage')
  @Post()
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<Role> {
    return this.roles.create(createRoleSchema.parse(body) as CreateRole, request);
  }

  @RequirePermission('settings:manage')
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<Role> {
    return this.roles.update(id, updateRoleSchema.parse(body) as UpdateRole, request);
  }

  @RequirePermission('settings:manage')
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.roles.remove(id, request);
  }
}
