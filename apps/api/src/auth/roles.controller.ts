import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotImplementedException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  CAPABILITIES,
  type CreateRole,
  type Role,
  type UpdateRole,
  createRoleSchema,
  updateRoleSchema,
} from '@nexuspuppet/contracts';
import { CapabilityRegistry } from '../enterprise/capability.registry';
import { RequireAnyPermission, RequirePermission, type AuthenticatedRequest } from './auth.guard';
import { RolesService } from './roles.service';

/**
 * Role administration (ADR-0018 §6).
 *
 * READING is core. Every deployment has roles, and a console that could not
 * show them would be hiding how its own authorization works.
 *
 * WRITING is licensed. The routes exist regardless and answer 501 naming the
 * capability, rather than 404 — the feature exists, this deployment does not
 * have it. A capability check, not a separate code path (ADR-0002): one
 * implementation, one set of tests.
 */
@Controller('roles')
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly capabilities: CapabilityRegistry,
  ) {}

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
    this.assertLicensed();
    return this.roles.create(createRoleSchema.parse(body) as CreateRole, request);
  }

  @RequirePermission('settings:manage')
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<Role> {
    this.assertLicensed();
    return this.roles.update(id, updateRoleSchema.parse(body) as UpdateRole, request);
  }

  @RequirePermission('settings:manage')
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    this.assertLicensed();
    return this.roles.remove(id, request);
  }

  private assertLicensed(): void {
    if (this.capabilities.has(CAPABILITIES.RBAC_CUSTOM)) return;

    throw new NotImplementedException({
      error: 'CAPABILITY_UNAVAILABLE',
      capability: CAPABILITIES.RBAC_CUSTOM,
      message:
        'This deployment cannot create or edit roles. The three built-in roles are available ' +
        'and behave exactly as they always have; defining your own requires the ' +
        `"${CAPABILITIES.RBAC_CUSTOM}" capability.`,
    });
  }
}
