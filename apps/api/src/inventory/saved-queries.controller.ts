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
  UnauthorizedException,
} from '@nestjs/common';
import {
  createSavedQuerySchema,
  updateSavedQuerySchema,
  type AuthenticatedPrincipal,
  type SavedQuery,
} from '@nexuspuppet/contracts';
import { RequirePermission } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SavedQueriesService } from './saved-queries.service';

/**
 * Saved queries (ADR-0026).
 *
 * `inventory:read` is the FLOOR, not the whole rule. Every signed-in user holds
 * it, so it gates the surface; which queries a caller may actually see is
 * decided per row by the service, because a resource query requires
 * `resources:read` and its NAME alone discloses what somebody is watching.
 *
 * Route-level permissions cannot express that — they answer yes or no for the
 * whole endpoint — so this deliberately does not try.
 */
@RequirePermission('inventory:read')
@Controller('saved-queries')
export class SavedQueriesController {
  constructor(private readonly savedQueries: SavedQueriesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<SavedQuery[]> {
    return this.savedQueries.list(principalOf(request));
  }

  @Post()
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<SavedQuery> {
    return this.savedQueries.create(
      createSavedQuerySchema.parse(body),
      principalOf(request),
      contextOf(request),
    );
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<SavedQuery> {
    return this.savedQueries.update(
      id,
      updateSavedQuerySchema.parse(body),
      principalOf(request),
      contextOf(request),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.savedQueries.remove(id, principalOf(request), contextOf(request));
  }
}

/**
 * The principal, or a 401.
 *
 * The guard has already run, so this is unreachable in practice — but ownership
 * is decided from `userId`, and a silent `undefined` there would compare equal
 * to a row whose owner has been deleted, handing somebody else's orphaned
 * queries to whoever asked.
 */
function principalOf(request: AuthenticatedRequest): AuthenticatedPrincipal {
  if (request.principal === undefined) throw new UnauthorizedException();
  return request.principal;
}

function contextOf(request: AuthenticatedRequest): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
