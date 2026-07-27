import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Validate before Nest starts, so a misconfigured deployment produces one
  // clear message rather than a stack trace from inside the framework.
  const env = loadEnv();

  const app = await NestFactory.create(await AppModule.bootstrap(), {
    logger:
      env.LOG_LEVEL === 'debug'
        ? ['debug', 'log', 'warn', 'error']
        : env.LOG_LEVEL === 'info'
          ? ['log', 'warn', 'error']
          : [env.LOG_LEVEL],
  });

  // No global ValidationPipe: input is validated per-route by ZodValidationPipe
  // against the schemas in @nexuspuppet/contracts, so the API accepts exactly
  // what the shared types promise. Nest's ValidationPipe would require
  // class-validator and a second, drifting definition of every request shape.

  // The web tier is the only intended browser-facing origin; it proxies
  // server-side, so no permissive CORS is required here.
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, '0.0.0.0');
  logger.log(`NexusPuppet API listening on :${env.API_PORT}`);
}

bootstrap().catch((error: unknown) => {
  // Anything thrown here — invalid env, a broken enterprise layer — must stop
  // the process. Starting in a degraded state would be worse than not starting.
  console.error('[bootstrap] Fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
