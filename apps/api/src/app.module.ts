import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  AUDIT_SINK,
  AUTHORIZATION_POLICY,
  AUTH_PROVIDER,
  ENC_FILE_WRITER,
  LICENSE_SERVICE,
  PUPPETDB_CLIENT,
  USER_DIRECTORY,
  type CapabilityToken,
} from '@nexuspuppet/contracts';
import { CapabilityRegistry } from './enterprise/capability.registry';
import { EnterpriseLoader } from './enterprise/enterprise.loader';
import { HealthController } from './health/health.controller';
import { NodesController } from './inventory/nodes.controller';
import { ReportsController } from './reports/reports.controller';
import {
  MaterializationController,
  NodeGroupsController,
} from './classification/node-groups.controller';
import { ClassificationService } from './classification/classification.service';
import { PuppetDbClient } from './puppetdb/puppetdb.client';
import { NodeProjectionService } from './puppetdb/node-projection.service';
import { EncFileWriter } from './materialization/enc-file-writer';
import { MaterializerService } from './materialization/materializer.service';
import { MaterializationService } from './materialization/materialization.service';
import { ReconcilerService } from './materialization/reconciler.service';
import { PrismaService } from './prisma/prisma.service';
import { PuppetDbExceptionFilter } from './common/puppetdb-exception.filter';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { AccountController, UsersController } from './auth/users.controller';
import { UsersService } from './auth/users.service';
import { LocalAuthProvider, LocalUserDirectory } from './auth/local-auth.provider';
import { RbacPolicy } from './auth/rbac.policy';
import { TokenService } from './auth/token.service';
import {
  BootstrapService,
  CoreLicenseService,
  LoginRateLimiter,
  PrismaAuditSink,
} from './auth/core-capabilities';
import { loadEnv, type Env } from './config/env';
import type { IAuthProvider, IPuppetDbClient } from '@nexuspuppet/contracts';

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

    // EVERY capability token gets a core default (ADR-0002). A token without
    // one would mean the product is incomplete without the enterprise layer.
    const coreDefaults = new Map<CapabilityToken, Provider>([
      [PUPPETDB_CLIENT, puppetDbProvider(env)],
      [ENC_FILE_WRITER, encWriterProvider()],
      [AUTH_PROVIDER, { provide: AUTH_PROVIDER, useClass: LocalAuthProvider }],
      [AUTHORIZATION_POLICY, { provide: AUTHORIZATION_POLICY, useClass: RbacPolicy }],
      [USER_DIRECTORY, { provide: USER_DIRECTORY, useClass: LocalUserDirectory }],
      [AUDIT_SINK, { provide: AUDIT_SINK, useClass: PrismaAuditSink }],
      [LICENSE_SERVICE, { provide: LICENSE_SERVICE, useClass: CoreLicenseService }],
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
      controllers: [
        HealthController,
        AuthController,
        NodesController,
        ReportsController,
        NodeGroupsController,
        MaterializationController,
        UsersController,
        AccountController,
      ],
      providers: [
        ...providers,
        { provide: CapabilityRegistry, useValue: registry },
        Reflector,

        // --- Auth (ADR-0006) ------------------------------------------------
        LocalAuthProvider,
        LocalUserDirectory,
        UsersService,
        RbacPolicy,
        PrismaAuditSink,
        CoreLicenseService,
        // Explicit factory: the constructor's defaulted numeric parameters
        // would otherwise be treated by Nest as injectable dependencies.
        { provide: LoginRateLimiter, useFactory: (): LoginRateLimiter => new LoginRateLimiter() },
        {
          provide: TokenService,
          inject: [PrismaService, AUTH_PROVIDER],
          useFactory: (prisma: PrismaService, provider: IAuthProvider): TokenService =>
            new TokenService(prisma, provider, {
              secret: env.JWT_SECRET,
              accessTtl: env.ACCESS_TOKEN_TTL,
              refreshTtl: env.REFRESH_TOKEN_TTL,
              issuer: 'nexuspuppet',
              audience: 'nexuspuppet-api',
            }),
        },
        {
          provide: BootstrapService,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): BootstrapService =>
            new BootstrapService(prisma, env.BOOTSTRAP_ADMIN_EMAIL, env.BOOTSTRAP_ADMIN_PASSWORD),
        },

        // --- PuppetDB projection (ADR-0004) ---------------------------------
        // Populates the ManagedNode cache that rule evaluation reads, so
        // classification never needs a live PuppetDB query.
        {
          provide: NodeProjectionService,
          inject: [PrismaService, PUPPETDB_CLIENT, MaterializationService],
          useFactory: (
            prisma: PrismaService,
            puppetdb: IPuppetDbClient,
            materialization: MaterializationService,
          ): NodeProjectionService =>
            new NodeProjectionService(
              prisma,
              puppetdb,
              materialization,
              env.PUPPETDB_PROJECTED_FACTS,
              env.PUPPETDB_PROJECTION_INTERVAL_MS,
            ),
        },

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
        ClassificationService,
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
        TokenService,
        BootstrapService,
        NodeProjectionService,
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
