import { Injectable, Logger } from '@nestjs/common';
import type { DeploymentInfo, UpdateCheck } from '@nexuspuppet/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { isNewer } from './pure/version';

/**
 * Where releases are published. The PUBLIC repository — there is nothing
 * private to ask, and an operator can open this URL themselves to check what
 * the console is being told.
 */
const RELEASES_URL = 'https://api.github.com/repos/eth-man/nexuspuppet/releases/latest';

/**
 * Short, because an air-gapped host does not refuse the connection — it black
 * holes it. Without a deadline the request hangs until the platform gives up,
 * which is minutes, and the operator is left looking at a spinner wondering
 * whether the appliance is broken.
 */
const CHECK_TIMEOUT_MS = 5_000;

@Injectable()
export class DeploymentService {
  private readonly logger = new Logger(DeploymentService.name);
  private readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly version: string,
  ) {}

  async info(): Promise<DeploymentInfo> {
    const began = Date.now();
    let connected = false;
    let latencyMs: number | null = null;

    try {
      /*
       * A real round trip, not a flag on the client.
       *
       * The Prisma client reports itself connected long after the database has
       * gone away — the pool only discovers it on the next query. A health
       * indicator that reads a cached boolean is green during exactly the
       * incident it exists to show.
       */
      await this.prisma.ping();
      connected = true;
      latencyMs = Date.now() - began;
    } catch (error) {
      this.logger.warn(
        `Database health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      version: this.version,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      database: { connected, latencyMs },
    };
  }

  /**
   * Ask GitHub what the latest release is. ONLY when asked.
   *
   * Never called on boot, never on a timer, never when a page loads — an
   * appliance that reaches the internet unprompted is disqualifying in the
   * estates this product is aimed at, and "it was only a version check" is not
   * a defence anybody accepts after the fact.
   *
   * The request carries nothing about this deployment: no version, no
   * identifier, no telemetry. It is the same GET anybody could make, and the
   * comparison happens here.
   *
   * Being offline is a RESULT, not an error. `reachable: false` is the normal
   * and expected answer on an air-gapped host, and rendering it as a failure
   * would train operators to ignore a red state that means nothing.
   */
  async checkForUpdates(): Promise<UpdateCheck> {
    const base: UpdateCheck = {
      current: this.version,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      reachable: false,
      message: null,
    };

    try {
      const response = await fetch(RELEASES_URL, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });

      if (!response.ok) {
        /*
         * 403 IS ALMOST ALWAYS RATE LIMITING, NOT PERMISSION.
         *
         * GitHub returns 403 rather than 429 when an unauthenticated caller
         * exhausts its 60-per-hour allowance, and that allowance is per SOURCE
         * ADDRESS — so behind corporate NAT it is shared with everyone else on
         * the network and can be gone without this deployment having asked once.
         *
         * Reported by an operator who reasonably read 403 as "this repository
         * is private" or "my deployment is unlicensed". It is neither: the
         * repository is public and nothing about this deployment is sent.
         */
        if (response.status === 403 || response.status === 429) {
          const remaining = response.headers.get('x-ratelimit-remaining');
          const limited = remaining === '0' || response.status === 429;
          return {
            ...base,
            message: limited
              ? 'GitHub rate-limited this check. The allowance is per source address ' +
                'and shared across your network, so it can be exhausted by other traffic. ' +
                'It resets hourly; nothing is wrong with this deployment.'
              : 'The release service refused the request (403). This is usually rate ' +
                'limiting or an outbound proxy — the release list is public and no ' +
                'credential is involved.',
          };
        }

        return {
          ...base,
          message:
            response.status === 404
              ? 'No releases have been published yet.'
              : `The release service answered ${response.status}.`,
        };
      }

      const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name : null;
      if (latest === null) {
        return { ...base, reachable: true, message: 'The release service returned no version.' };
      }

      return {
        current: this.version,
        latest,
        updateAvailable: isNewer(latest, this.version),
        releaseUrl: typeof body.html_url === 'string' ? body.html_url : null,
        reachable: true,
        message: null,
      };
    } catch (error) {
      // Timeout, DNS failure, blocked egress. All the same thing to an
      // operator: this host cannot reach the internet, which is often on
      // purpose.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      this.logger.log(
        `Update check could not reach the release service: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ...base,
        message: timedOut
          ? 'No answer within 5 seconds. This host may have no route to the internet.'
          : 'Could not reach the release service. This host may be offline or air-gapped.',
      };
    }
  }
}
