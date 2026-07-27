import { Injectable, Logger, type Provider } from '@nestjs/common';
import {
  CAPABILITIES,
  type CapabilityName,
  type CapabilityToken,
  type EnterpriseModuleDescriptor,
} from '@nexuspuppet/contracts';

/**
 * Resolves core defaults against optional enterprise overrides (ADR-0002).
 *
 * Core provides a default implementation of EVERY token. The enterprise layer
 * may replace them; it may never introduce a token core does not declare, and
 * it may never import core internals. Registration is one-way.
 */
@Injectable()
export class CapabilityRegistry {
  private static readonly logger = new Logger(CapabilityRegistry.name);

  private readonly available = new Set<CapabilityName>();

  constructor(private readonly enterpriseVersion: string | null = null) {}

  get edition(): 'core' | 'enterprise' {
    return this.enterpriseVersion === null ? 'core' : 'enterprise';
  }

  get version(): string | null {
    return this.enterpriseVersion;
  }

  has(capability: CapabilityName): boolean {
    return this.available.has(capability);
  }

  list(): CapabilityName[] {
    return [...this.available].sort();
  }

  private markAvailable(capabilities: readonly CapabilityName[]): void {
    const known = new Set<string>(Object.values(CAPABILITIES));
    for (const capability of capabilities) {
      if (!known.has(capability)) {
        // A capability core has never heard of cannot be gated by core, so it
        // cannot be honoured. Warn rather than fail — the enterprise build may
        // simply be newer.
        CapabilityRegistry.logger.warn(
          `Enterprise layer advertises unknown capability "${capability}"; ignoring.`,
        );
        continue;
      }
      this.available.add(capability);
    }
  }

  /**
   * Build the provider list: core defaults, with enterprise registrations
   * layered on top for the tokens they claim.
   *
   * @param coreDefaults one entry per token declared in contracts.
   */
  static buildProviders(
    coreDefaults: ReadonlyMap<CapabilityToken, Provider>,
    descriptor: EnterpriseModuleDescriptor | null,
  ): { providers: Provider[]; registry: CapabilityRegistry } {
    const resolved = new Map<CapabilityToken, Provider>(coreDefaults);
    const registry = new CapabilityRegistry(descriptor?.version ?? null);

    if (descriptor !== null) {
      for (const registration of descriptor.registrations) {
        const token = registration.token;

        if (!coreDefaults.has(token)) {
          // Enterprise may only override seams core declared. Anything else
          // would be an undocumented extension point.
          CapabilityRegistry.logger.warn(
            `Enterprise layer tried to register unknown token ${String(token)}; ignoring.`,
          );
          continue;
        }

        resolved.set(token, {
          provide: token,
          useClass: registration.provider as Provider & (new (...args: never[]) => unknown),
        } as Provider);

        CapabilityRegistry.logger.log(`Enterprise override applied for ${String(token)}`);
      }

      registry.markAvailable(descriptor.capabilities);
    }

    return { providers: [...resolved.values()], registry };
  }
}
