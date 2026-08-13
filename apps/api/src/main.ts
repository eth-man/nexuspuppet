import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { BootstrapService } from './auth/core-capabilities';
import { runWithRequestId } from './common/request-context';
import { LogLevelService } from './system/log-level.service';
import { levelsFor } from './system/pure/log-levels';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Validate before Nest starts, so a misconfigured deployment produces one
  // clear message rather than a stack trace from inside the framework.
  const env = loadEnv();

  /*
   * A logger INSTANCE we keep hold of, rather than a level array.
   *
   * Nest accepts `logger: LogLevel[]`, but that array is consumed at creation
   * and cannot be changed afterwards — which is why LOG_LEVEL used to need a
   * restart. Holding a ConsoleLogger lets `setLogLevels()` retarget the running
   * logger, and that is the whole mechanism behind changing it live.
   *
   * The mapping comes from `levelsFor`, shared with the service, so the level
   * applied at boot and the level applied later can never diverge.
   */
  const appLogger = new ConsoleLogger();
  appLogger.setLogLevels(levelsFor(env.LOG_LEVEL));

  const app = await NestFactory.create<NestExpressApplication>(await AppModule.bootstrap(), {
    logger: appLogger,
  });

  // Hands the service the only thing it needs from the app: a way to apply a
  // level. It never sees the app itself, so it stays unit-testable.
  app.get(LogLevelService).bind((level) => {
    appLogger.setLogLevels(levelsFor(level));
  });

  // No global ValidationPipe: input is validated per-route by ZodValidationPipe
  // against the schemas in @nexuspuppet/contracts, so the API accepts exactly
  // what the shared types promise. Nest's ValidationPipe would require
  // class-validator and a second, drifting definition of every request shape.

  /*
   * One id per request, in scope for everything it calls (#229).
   *
   * FIRST, before any other middleware, because anything that writes an audit
   * row before this runs would be uncorrelated — and a row missing from a
   * correlation query is invisible in exactly the way the feature exists to
   * prevent.
   *
   * Echoed as a response header so an operator reporting "it failed at 14:32"
   * can hand over an id instead of a timestamp, and the whole operation comes
   * back in one lookup.
   */
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    runWithRequestId((requestId) => {
      res.setHeader('x-request-id', requestId);
      next();
    });
  });

  // The web tier is the only intended browser-facing origin; it proxies
  // server-side, so no permissive CORS is required here.
  app.enableShutdownHooks();

  // A fresh install has no users, and every route requires authentication —
  // so without this there is no way in. Runs only when the table is empty.
  await app.get(BootstrapService).seedAdminIfEmpty();

  // request.ip and `secure` must reflect the real client behind a reverse
  // proxy, or rate limiting keys on the proxy and cookies never get Secure.
  app.set('trust proxy', 1);

  await app.listen(env.API_PORT, '0.0.0.0');
  logger.log(`NexusPuppet API listening on :${env.API_PORT}`);

  if (env.ENC_REPLICATION_ENABLED) {
    /*
     * A SECOND listener, with its own TLS and its own authentication (ADR-0019).
     * Started after the API so a failure here cannot stop the console from
     * coming up — a deployment that cannot replicate is degraded; one that
     * cannot be administered is down.
     *
     * The allowlist is checked here rather than left to the request path
     * because an empty list means the endpoint can serve nobody, and opening a
     * port that will refuse every caller is worse than not opening it: it looks
     * configured.
     */
    if (env.ENC_REPLICATION_ALLOWED_CERTNAMES.length === 0) {
      logger.error(
        'ENC_REPLICATION_ENABLED is true but ENC_REPLICATION_ALLOWED_CERTNAMES is empty. ' +
          'No certname could fetch the tree, so the listener has not been opened. ' +
          'Set it to your puppetserver certname(s).',
      );
    } else {
      const { createReplicationServer } = await import('./replication/replication.server');
      const { EncReplicationService } = await import('./replication/enc-replication.service');
      const { CompileReceiptsService } = await import('./replication/compile-receipts.service');

      try {
        const server = createReplicationServer(
          {
            port: env.ENC_REPLICATION_PORT,
            bind: env.ENC_REPLICATION_BIND,
            certPath: env.ENC_REPLICATION_CERT_PATH,
            keyPath: env.ENC_REPLICATION_KEY_PATH,
            caPath: env.ENC_REPLICATION_CA_PATH,
            allowedCertnames: env.ENC_REPLICATION_ALLOWED_CERTNAMES,
          },
          app.get(EncReplicationService),
          app.get(CompileReceiptsService),
        );

        server.listen(env.ENC_REPLICATION_PORT, env.ENC_REPLICATION_BIND, () => {
          logger.log(
            `ENC replication listening on ${env.ENC_REPLICATION_BIND}:${String(env.ENC_REPLICATION_PORT)} ` +
              `for ${String(env.ENC_REPLICATION_ALLOWED_CERTNAMES.length)} allowed certname(s)`,
          );
        });

        app.enableShutdownHooks();
        process.on('beforeExit', () => server.close());
      } catch (error: unknown) {
        // Almost always an unreadable certificate or key. Named explicitly,
        // because the alternative is a silent absence of replication that
        // nobody notices until classification has been stale for a week.
        logger.error(
          `ENC replication could not start: ${error instanceof Error ? error.message : String(error)}. ` +
            'The console is unaffected; the Puppet server will keep serving its last synced tree.',
        );
      }
    }
  }
}

bootstrap().catch((error: unknown) => {
  // Anything thrown here — invalid env, a broken enterprise layer — must stop
  // the process. Starting in a degraded state would be worse than not starting.
  console.error('[bootstrap] Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
