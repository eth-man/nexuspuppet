import { Controller, Get } from '@nestjs/common';
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
  @Get('healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('capabilities')
  deployment(): DeploymentCapabilities {
    return {
      edition: this.capabilities.edition,
      enterpriseVersion: this.capabilities.version,
      capabilities: this.capabilities.list(),
    };
  }
}
