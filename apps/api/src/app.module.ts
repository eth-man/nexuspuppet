import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CapabilityRegistry } from './enterprise/capability.registry';
import { EnterpriseLoader } from './enterprise/enterprise.loader';
import { HealthController } from './health/health.controller';
import { loadEnv } from './config/env';
import type { CapabilityToken } from '@nexuspuppet/contracts';
import type { Provider } from '@nestjs/common';

/**
 * Root module.
 *
 * Composed asynchronously because the enterprise layer is discovered at
 * runtime (ADR-0002) and its registrations must be resolved before the
 * injector is built.
 *
 * Core defaults for every capability token are registered here as
 * implementations land. The map is intentionally exhaustive: a token with no
 * core default would mean the product is incomplete without the enterprise
 * layer, which ADR-0002 forbids.
 */
@Module({})
export class AppModule {
  static async bootstrap(): Promise<DynamicModule> {
    const enterprise = await EnterpriseLoader.load();

    const coreDefaults = new Map<CapabilityToken, Provider>();

    const { providers, registry } = CapabilityRegistry.buildProviders(
      coreDefaults,
      enterprise?.descriptor ?? null,
    );

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          // Fail at boot on a misconfigured deployment, not on first request.
          validate: loadEnv,
        }),
      ],
      controllers: [HealthController],
      providers: [...providers, { provide: CapabilityRegistry, useValue: registry }],
      exports: [CapabilityRegistry],
    };
  }
}
