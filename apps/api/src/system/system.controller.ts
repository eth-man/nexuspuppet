import { Controller, Get, Req } from '@nestjs/common';
import type { SystemStatus } from '@nexuspuppet/contracts';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { SystemStatusService } from './system-status.service';

/**
 * Operational status for the console.
 *
 * Separate from HealthController's `/healthz` on purpose. That is an
 * unauthenticated liveness probe for a load balancer and must stay trivial;
 * this requires a session and reads the database. Merging them would either
 * leak estate information to anything that can reach the port, or make a
 * liveness check expensive enough to fail under load.
 */
@Controller('system')
export class SystemController {
  constructor(private readonly status: SystemStatusService) {}

  /**
   * Gated on `inventory:read`, so anyone who may look at the estate may see
   * whether the console is keeping up with it. Error STRINGS are withheld
   * below unless the caller is an administrator: they carry filesystem paths
   * and collector hostnames, which is infrastructure detail a viewer should not
   * acquire from a dashboard card.
   */
  @RequirePermission('inventory:read')
  @Get('status')
  get(@Req() request: AuthenticatedRequest): Promise<SystemStatus> {
    return this.status.status(request.principal?.role === 'ADMIN');
  }
}
