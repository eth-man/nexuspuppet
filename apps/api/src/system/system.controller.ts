import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type {
  ConsoleTlsStatus,
  DeploymentInfo,
  LogLevelSetting,
  OperationalCondition,
  SetLogLevel,
  SystemStatus,
  UpdateCheck,
  PropagationFront,
} from '@nexuspuppet/contracts';
import { setLogLevelSchema } from '@nexuspuppet/contracts';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { SystemStatusService } from './system-status.service';
import { PropagationService } from './propagation.service';
import { ConsoleTlsService } from './console-tls.service';
import { ConsoleTlsGrantService } from './console-tls-grant.service';
import { DeploymentService } from './deployment.service';
import { PrismaService } from '../prisma/prisma.service';
import { LogLevelService } from './log-level.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { openConditions } from '../notifications/notification-evaluator.service';

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
  constructor(
    private readonly status: SystemStatusService,
    private readonly tls: ConsoleTlsService,
    private readonly grants: ConsoleTlsGrantService,
    private readonly deploymentService: DeploymentService,
    private readonly prisma: PrismaService,
    private readonly logLevels: LogLevelService,
    private readonly propagation: PropagationService,
  ) {}

  /**
   * Gated on `inventory:read`, so anyone who may look at the estate may see
   * whether the console is keeping up with it. Error STRINGS are withheld
   * below unless the caller is an administrator: they carry filesystem paths
   * and collector hostnames, which is infrastructure detail a viewer should not
   * acquire from a dashboard card.
   */
  /**
   * What this deployment is. Cheap, and safe for anyone who can see the
   * dashboard: a version, a clock and one database round trip.
   */
  @RequirePermission('inventory:read')
  @Get('deployment')
  deployment(): Promise<DeploymentInfo> {
    return this.deploymentService.info();
  }

  /**
   * POST, and administrator-only, because it REACHES THE INTERNET.
   *
   * A GET invites a browser, a proxy or a prefetcher to make it happen without
   * anybody asking — and the entire point of this endpoint is that the outbound
   * call only ever happens when an operator presses the button. The verb is the
   * cheapest way to say that to every intermediary at once.
   */
  @RequirePermission('settings:manage')
  @Post('update-check')
  @HttpCode(HttpStatus.OK)
  updateCheck(): Promise<UpdateCheck> {
    return this.deploymentService.checkForUpdates();
  }

  @RequirePermission('inventory:read')
  @Get('status')
  get(@Req() request: AuthenticatedRequest): Promise<SystemStatus> {
    return this.status.status(request.principal?.role === 'ADMIN');
  }

  /**
   * Where the current classification has actually got to (#147).
   *
   * `inventory:read` rather than `settings:manage`: this answers "did my change
   * reach the estate", which is an operator's question during a rollout, not an
   * administrator's during configuration.
   */
  @RequirePermission('inventory:read')
  @Get('propagation')
  propagationFront(): Promise<PropagationFront> {
    return this.propagation.front();
  }

  /**
   * The operational conditions currently open (ADR-0021).
   *
   * Same permission as `status`: these describe the deployment's health, which
   * is what anyone who can read the inventory is already looking at. Nothing
   * here names a person or an action, so nothing here needs a stricter gate —
   * and if that ever stops being true, the constraint has been broken rather
   * than the permission being wrong.
   */
  /**
   * The log level in force, and whether it can be changed here.
   *
   * `settings:manage`, unlike the rest of this controller: raising the level to
   * debug makes the API louder for everybody and can surface internals in a
   * log an operator may be shipping elsewhere.
   */
  @RequirePermission('settings:manage')
  @Get('log-level')
  logLevel(): LogLevelSetting {
    return this.logLevels.describe();
  }

  @RequirePermission('settings:manage')
  @Put('log-level')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setLogLevel(
    @Body(new ZodValidationPipe(setLogLevelSchema)) body: SetLogLevel,
  ): Promise<void> {
    await this.logLevels.set(body.level);
  }

  /** Return to whatever the environment says. */
  @RequirePermission('settings:manage')
  @Delete('log-level')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearLogLevel(): Promise<void> {
    await this.logLevels.clear();
  }

  @RequirePermission('inventory:read')
  @Get('conditions')
  async conditions(): Promise<OperationalCondition[]> {
    const rows = await openConditions(this.prisma);
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      severity: row.severity === 'critical' ? 'critical' : 'warning',
      summary: row.summary,
      openedAt: row.openedAt.toISOString(),
    }));
  }

  /**
   * The certificate the console is served with, and how long is left on it.
   *
   * Gated on `settings:manage` rather than `inventory:read`: this is
   * infrastructure detail — issuer, subject alternative names, a filesystem path
   * in the error case — and it belongs to whoever administers the deployment
   * rather than to everyone who may look at the estate.
   *
   * Reports what is ON DISK. It deliberately does not ask any proxy what it
   * loaded: operators replace the bundled one with nginx, HAProxy or an
   * appliance, and a check coupled to a particular proxy would report a healthy
   * deployment as broken.
   */
  @RequirePermission('settings:manage')
  @Get('tls')
  async consoleTls(): Promise<ConsoleTlsStatus & { installable: boolean }> {
    // `installable` so the console can offer the upload form only where it can
    // work. A button that always 503s is worse than no button.
    return { ...(await this.tls.status()), installable: this.grants.available };
  }

  /**
   * Authorise a certificate installation. Returns a grant, never a certificate.
   *
   * POST because it mints a credential and writes an audit row; a GET that did
   * either would be replayed by every well-behaved cache and prefetcher on the
   * path.
   *
   * What happens NEXT does not involve this process: the browser posts the
   * certificate and key to /console-tls/install, which the proxy routes to the
   * cert-helper service. No key material reaches the API (ADR-0017).
   */
  @RequirePermission('settings:manage')
  @Post('tls/authorize')
  authorizeInstall(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ grant: string; expiresInSeconds: number }> {
    return this.grants.authorize(request);
  }
}
