import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ENC_FILE_WRITER, PUPPETDB_CLIENT, type CapabilityToken } from '@nexuspuppet/contracts';
import { CapabilityRegistry } from './enterprise/capability.registry';
import { EnterpriseLoader } from './enterprise/enterprise.loader';
import { HealthController } from './health/health.controller';
import { NodesController } from './inventory/nodes.controller';
import { ReportsController } from './reports/reports.controller';
import { PuppetDbClient } from './puppetdb/puppetdb.client';
import { EncFileWriter } from './materialization/enc-file-writer';
import { MaterializerService } from './materialization/materializer.service';
import { MaterializationService } from './materialization/materialization.service';
import { ReconcilerService } from './materialization/reconciler.service';
import { PrismaService } from './prisma/prisma.service';
import { PuppetDbExceptionFilter } from './common/puppetdb-exception.filter';
import { AuthGuard } from './auth/auth.guard';
import { loadEnv, type Env } from './config/env';

/**
 * Root module.
 *
 * Composed asynchronously because the enterprise layer is discovered at
 * runtime (ADR-0002) and its registrations must resolve before the injector is
 * built.
 *
 * `coreDefaults` must contain an implementation for EVERY capability token.
 * A token with no core default would mean the product is incomplete without
 * the enterprise layer, which ADR-0002 forbids.
 */
@Module({})
export class AppModule {
  static async bootstrap(): Promise<DynamicModule> {
    const env = loadEnv();
    const enterprise = await EnterpriseLoader.load();

    const coreDefaults = new Map<CapabilityToken, Provider>([
      [PUPPETDB_CLIENT, puppetDbProvider(env)],
      [ENC_FILE_WRITER, encWriterProvider()],
    ]);

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
      controllers: [HealthController, NodesController, ReportsController],
      providers: [
        ...providers,
        { provide: CapabilityRegistry, useValue: registry },
        Reflector,

        // --- Materialization (ADR-0003) -------------------------------------
        { provide: PrismaService, useFactory: () => new PrismaService(env.DATABASE_URL) },
        {
          provide: EncFileWriter,
          useFactory: async (): Promise<EncFileWriter> => {
            const writer = new EncFileWriter(env.ENC_OUTPUT_DIR);
            await writer.ensureLayout();
            return writer;
          },
        },
        MaterializationService,
        {
          provide: MaterializerService,
          inject: [PrismaService, EncFileWriter],
          useFactory: (prisma: PrismaService, writer: EncFileWriter): MaterializerService =>
            new MaterializerService(
              prisma,
              writer,
              env.ENC_MAX_JOB_ATTEMPTS,
              env.ENC_DEFAULT_ENVIRONMENT,
            ),
        },
        {
          // Starts the drain and reconcile loops on module init, and writes
          // default.yaml before puppetserver can ask for an unknown node.
          provide: ReconcilerService,
          inject: [PrismaService, MaterializerService, EncFileWriter],
          useFactory: (
            prisma: PrismaService,
            materializer: MaterializerService,
            writer: EncFileWriter,
          ): ReconcilerService =>
            new ReconcilerService(
              prisma,
              materializer,
              writer,
              env.ENC_MATERIALIZER_INTERVAL_MS,
              env.ENC_RECONCILE_INTERVAL_MS,
            ),
        },
        // Global, so a new controller is protected by default and forgetting
        // the decorator fails closed (ADR-0006).
        { provide: APP_GUARD, useClass: AuthGuard },
        // A PuppetDB outage becomes an explicit 503 state, never an empty
        // table (ADR-0004 §6).
        { provide: APP_FILTER, useClass: PuppetDbExceptionFilter },
      ],
      exports: [
        CapabilityRegistry,
        PUPPETDB_CLIENT,
        ENC_FILE_WRITER,
        PrismaService,
        MaterializerService,
        MaterializationService,
      ],
    };
  }
}

function puppetDbProvider(env: Env): Provider {
  return {
    provide: PUPPETDB_CLIENT,
    useFactory: (): PuppetDbClient =>
      // Certificates load lazily on first use. A missing or expired
      // certificate degrades the inventory screens; it must not stop the
      // process, because classification does not depend on PuppetDB at all.
      new PuppetDbClient({
        baseUrl: env.PUPPETDB_URL,
        certPath: env.PUPPETDB_CERT_PATH,
        keyPath: env.PUPPETDB_KEY_PATH,
        caPath: env.PUPPETDB_CA_PATH,
        timeoutMs: env.PUPPETDB_TIMEOUT_MS,
      }),
  };
}

/**
 * The contracts token resolves to the SAME instance as the concrete class.
 * Two EncFileWriter instances would mean two owners of the ENC directory,
 * which ADR-0003 explicitly forbids — only one component may write it.
 */
function encWriterProvider(): Provider {
  return {
    provide: ENC_FILE_WRITER,
    inject: [EncFileWriter],
    useFactory: (writer: EncFileWriter): EncFileWriter => writer,
  };
}
