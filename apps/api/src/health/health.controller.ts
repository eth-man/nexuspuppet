import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { CapabilityRegistry } from '../enterprise/capability.registry';
import type { DeploymentCapabilities } from '@nexuspuppet/contracts';

/**
 * Liveness, readiness, and capability advertisement.
 *
 * `/capabilities` is what lets the web tier hide or disable enterprise features
 * it cannot use. Note this is a UI affordance only — the API independently
 * returns 501 for an unavailable capability regardless of what the UI shows
 * (ADR-0002, ADR-0006).
 */
@Controller()
export class HealthController {
  constructor(private readonly capabilities: CapabilityRegistry) {}

  /** Liveness: is the process up? Deliberately dependency-free. */
  // A liveness probe that requires a session is useless to a load balancer.
  @Public()
  @Get('healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // The login screen needs this before a session exists, to know whether to
  // render a password form or an SSO button.
  @Public()
  @Get('capabilities')
  deployment(): DeploymentCapabilities {
    return {
      edition: this.capabilities.edition,
      enterpriseVersion: this.capabilities.version,
      capabilities: this.capabilities.list(),
    };
  }
}
