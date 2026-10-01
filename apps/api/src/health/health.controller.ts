import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';

/**
 * Liveness.
 *
 * `GET /capabilities` lived here until ADR-0027. It reported which "edition"
 * was running and which licensed features it had, so the console could hide
 * the ones it lacked. Every deployment now has every feature; what varies is
 * configuration, and each settings surface reports its own.
 */
@Controller()
export class HealthController {
  /** Liveness: is the process up? Deliberately dependency-free. */
  // A liveness probe that requires a session is useless to a load balancer.
  @Public()
  @Get('healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
