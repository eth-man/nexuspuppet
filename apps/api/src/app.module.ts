import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  AUDIT_SINK,
  AUDIT_DELIVERY_OUTBOX,
  AUDIT_TRANSPORT,
  CORE_AUDIT_SINK,
  AUTHORIZATION_POLICY,
  AUTH_PROVIDER,
  AUTH_PROVIDERS,
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
import { PosixEncStorage } from './materialization/posix-enc-storage';
import { MaterializerService } from './materialization/materializer.service';
import { MaterializationService } from './materialization/materialization.service';
import { ReconcilerService } from './materialization/reconciler.service';
import { PrismaService } from './prisma/prisma.service';
import { AuditDeliveryOutbox } from './auth/audit-delivery.outbox';
import { ClassificationPlanner } from './classification/plan/classification-planner.service';
import { ConflictReportService } from './classification/conflict-report.service';
import { SystemController } from './system/system.controller';
import { SystemStatusService } from './system/system-status.service';
import { ConsoleTlsService } from './system/console-tls.service';
import {
  AuditDeliveryWorker,
  DEFAULT_AUDIT_PACING,
  NoopAuditTransport,
} from './auth/audit-delivery.worker';
import { PuppetDbExceptionFilter } from './common/puppetdb-exception.filter';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { AccountController, UsersController } from './auth/users.controller';
import { UsersService } from './auth/users.service';
import { AuthProviderResolver } from './auth/auth-provider.resolver';
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
import type { IEncFileWriter } from '@nexuspuppet/contracts';
import type {
  IAuditSink,
  IAuditTransport,
  IAuthProvider,
  IPuppetDbClient,
} from '@nexuspuppet/contracts';

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
      [ENC_FILE_WRITER, encWriterProvider(env)],
      // useExisting, not useClass: LocalAuthProvider is built by a factory
      // below so it can receive the lockout policy from config. useClass would
      // have Nest construct a SECOND instance through DI metadata, which fails
      // because the policy is a plain object rather than an injectable — and
      // would silently give the two instances different configuration if it
      // did not.
      // Core's local provider, and it stays core's local provider. The registry
      // refuses an enterprise override of this token (ADR-0015): replacing it
      // removed local authentication outright rather than shadowing it, which
      // locked every local account out the moment a directory was enabled.
      [AUTH_PROVIDER, { provide: AUTH_PROVIDER, useExisting: LocalAuthProvider }],
      [AUTHORIZATION_POLICY, { provide: AUTHORIZATION_POLICY, useClass: RbacPolicy }],
      [USER_DIRECTORY, { provide: USER_DIRECTORY, useClass: LocalUserDirectory }],
      // An ALIAS onto CORE_AUDIT_SINK, not a second construction of it.
      //
      // Core behaviour is unchanged: AUDIT_SINK still resolves to the Postgres
      // sink. What changes is that the core sink now has a stable token of its
      // own, so a replacement registered under AUDIT_SINK can COMPOSE over it —
      // delegate the transactional write, then forward — instead of having to
      // own a write it cannot perform (ADR-0002 keeps Prisma out of the
      // enterprise layer). An estate that gains a SIEM must not lose its local
      // audit trail.
      [AUDIT_SINK, { provide: AUDIT_SINK, useExisting: CORE_AUDIT_SINK }],
      [LICENSE_SERVICE, { provide: LICENSE_SERVICE, useClass: CoreLicenseService }],
      // Core forwards audit records nowhere. That is a complete product, not a
      // gap: the records are in Postgres and queryable. The no-op reports
      // itself unconfigured so the worker leaves the queue alone rather than
      // draining records into nothing.
      [AUDIT_TRANSPORT, { provide: AUDIT_TRANSPORT, useClass: NoopAuditTransport }],
    ]);

    // Registered outside coreDefaults: this is not a capability the enterprise
    // layer may replace, it is a core service the enterprise layer may depend on.
    // Class constructors, not provider descriptors: each is registered as its
    // own provider AND used as the injection token for the list below.
    const enterpriseAuthProviders = (enterprise?.descriptor.authProviders ??
      []) as Type<IAuthProvider>[];

    const coreServices: Provider[] = [
      // Every provider that can answer a login, local first (ADR-0015).
      //
      // The enterprise contributions are ADDITIVE. Core's local provider is
      // always in this list and the registry refuses any attempt to displace
      // it, which is what makes an administrator lockout structurally
      // impossible rather than a documented hazard.
      ...enterpriseAuthProviders,
      {
        provide: AUTH_PROVIDERS,
        inject: [LocalAuthProvider, ...enterpriseAuthProviders],
        useFactory: (...providers: IAuthProvider[]): IAuthProvider[] => providers,
      },
      {
        provide: AuthProviderResolver,
        inject: [AUTH_PROVIDERS, PrismaService],
        useFactory: (providers: IAuthProvider[], prisma: PrismaService): AuthProviderResolver =>
          new AuthProviderResolver(providers, prisma, env.AUTH_LOGIN_FLOOR_MS),
      },
      { provide: CORE_AUDIT_SINK, useClass: PrismaAuditSink },
      AuditDeliveryOutbox,
      // Aliased under a contracts token so a forwarding capability can inject
      // it. The enterprise layer cannot name the class (ADR-0002), and this is
      // the only part of the delivery machinery it needs to reach.
      { provide: AUDIT_DELIVERY_OUTBOX, useExisting: AuditDeliveryOutbox },
      {
        // Explicit factory: the pacing argument is a plain object, which Nest
        // would otherwise try to resolve as an injectable dependency.
        provide: AuditDeliveryWorker,
        inject: [PrismaService, AuditDeliveryOutbox, AUDIT_TRANSPORT],
        useFactory: (
          prisma: PrismaService,
          outbox: AuditDeliveryOutbox,
          transport: IAuditTransport,
        ): AuditDeliveryWorker =>
          new AuditDeliveryWorker(prisma, outbox, transport, DEFAULT_AUDIT_PACING),
      },
    ];

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
        SystemController,
      ],
      providers: [
        ...coreServices,
        ...providers,
        { provide: CapabilityRegistry, useValue: registry },
        Reflector,

        // --- Auth (ADR-0006) ------------------------------------------------
        {
          provide: LocalAuthProvider,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): LocalAuthProvider =>
            new LocalAuthProvider(prisma, {
              maxFailedAttempts: env.LOGIN_MAX_FAILED_ATTEMPTS,
              lockoutMinutes: env.LOGIN_LOCKOUT_MINUTES,
            }),
        },
        UsersService,
        {
          // Explicit factory: pacing is a plain object Nest would try to inject.
          provide: ClassificationPlanner,
          inject: [PrismaService, MaterializerService],
          useFactory: (prisma: PrismaService, materializer: MaterializerService) =>
            new ClassificationPlanner(prisma, materializer),
        },
        {
          provide: ConflictReportService,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): ConflictReportService =>
            new ConflictReportService(prisma),
        },
        {
          // Explicit factory: NodeProjectionService is itself factory-built with
          // plain config values, so Nest cannot construct this by metadata.
          provide: SystemStatusService,
          inject: [PrismaService, AuditDeliveryOutbox, NodeProjectionService, AUDIT_TRANSPORT],
          useFactory: (
            prisma: PrismaService,
            outbox: AuditDeliveryOutbox,
            projection: NodeProjectionService,
            transport: IAuditTransport,
          ): SystemStatusService => new SystemStatusService(prisma, outbox, projection, transport),
        },
        {
          // Config passed in, not read inside the service. A service that reads
          // its own environment is one whose tests can never observe the
          // default — which is how the projected-fact warning came to be
          // silently disabled in every real deployment while passing every test.
          provide: ConsoleTlsService,
          useFactory: (): ConsoleTlsService =>
            new ConsoleTlsService(env.CONSOLE_TLS_CERT_PATH ?? null, env.CONSOLE_HOSTNAME ?? null),
        },
        // RbacPolicy, LocalUserDirectory, PrismaAuditSink and CoreLicenseService
        // are NOT registered here. They reach the container only through their
        // capability tokens above (ADR-0002).
        //
        // Registering a class as well as aliasing it is what makes a seam
        // decorative: the class stays injectable, so a consumer can take it
        // directly and an enterprise override is constructed and never called.
        // With useClass it is worse — Nest builds a SECOND instance, and the two
        // diverge. AUDIT_SINK had exactly that defect: every user-administration
        // and classification event bypassed the token.
        //
        // LocalAuthProvider above is the one exception, and only because
        // useExisting aliases a provider that must already exist.
        // capability-wiring.spec.ts enforces all of this.
        // Explicit factory: the constructor's defaulted numeric parameters
        // would otherwise be treated by Nest as injectable dependencies.
        { provide: LoginRateLimiter, useFactory: (): LoginRateLimiter => new LoginRateLimiter() },
        {
          provide: TokenService,
          inject: [PrismaService, AuthProviderResolver],
          useFactory: (prisma: PrismaService, provider: AuthProviderResolver): TokenService =>
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
              env.PUPPETDB_POLL_INTERVAL_MS,
              env.PUPPETDB_POLL_OVERLAP_MS,
            ),
        },

        // --- Materialization (ADR-0003) -------------------------------------
        { provide: PrismaService, useFactory: () => new PrismaService(env.DATABASE_URL) },
        MaterializationService,
        // A factory, because the unprojected-fact warning needs the SAME
        // projected list the projector uses, from validated config. It used to
        // read process.env directly and switch itself off when the operator
        // relied on the default — which is the default deployment.
        {
          provide: ClassificationService,
          inject: [PrismaService, MaterializationService, AUDIT_SINK],
          useFactory: (
            prisma: PrismaService,
            materialization: MaterializationService,
            audit: IAuditSink,
          ): ClassificationService =>
            new ClassificationService(prisma, materialization, audit, env.PUPPETDB_PROJECTED_FACTS),
        },
        {
          provide: MaterializerService,
          inject: [PrismaService, ENC_FILE_WRITER],
          useFactory: (prisma: PrismaService, writer: IEncFileWriter): MaterializerService =>
            new MaterializerService(
              prisma,
              writer,
              env.ENC_MAX_JOB_ATTEMPTS,
              env.ENC_DEFAULT_ENVIRONMENT,
              {
                batchSize: env.ENC_MATERIALIZER_BATCH_SIZE,
                reconcileChunkSize: env.ENC_MATERIALIZER_RECONCILE_CHUNK,
                batchDelayMs: env.ENC_MATERIALIZER_BATCH_DELAY_MS,
                maxDrainMs: env.ENC_MATERIALIZER_MAX_DRAIN_MS,
                batchTimeoutMs: env.ENC_MATERIALIZER_MAX_DRAIN_MS,
              },
            ),
        },
        {
          // Starts the drain and reconcile loops on module init, and writes
          // default.yaml before puppetserver can ask for an unknown node.
          provide: ReconcilerService,
          inject: [PrismaService, MaterializerService, ENC_FILE_WRITER],
          useFactory: (
            prisma: PrismaService,
            materializer: MaterializerService,
            writer: IEncFileWriter,
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
 * The ONE registration of ENC storage.
 *
 * It used to alias the token onto a separately-registered concrete class while
 * every consumer injected that class — so the token could be overridden and
 * nothing that writes ENC files would notice. The seam existed and did nothing.
 * The token is now the only way to obtain storage, which is what makes an
 * enterprise override (ADR-0002) actually take effect.
 *
 * Still exactly one instance: two owners of the ENC directory would break the
 * content-hash change detection that keeps a no-op from becoming estate-wide
 * file churn (ADR-0003).
 */
function encWriterProvider(env: Env): Provider {
  return {
    provide: ENC_FILE_WRITER,
    useFactory: async (): Promise<IEncFileWriter> => {
      const storage = new PosixEncStorage(env.ENC_OUTPUT_DIR);
      await storage.ensureLayout();
      return storage;
    },
  };
}
