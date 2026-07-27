import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * Prisma 7 no longer accepts `url` inside the `datasource` block of
 * schema.prisma. The connection string used by migration and introspection
 * commands lives here; the runtime client receives a driver adapter explicitly
 * (see PrismaService). See ADR-0005.
 *
 * DATABASE_URL has no default. A misconfigured deployment must fail at boot
 * with a clear message rather than quietly connecting somewhere unintended.
 */
/**
 * Optional. Required only by `prisma migrate diff --from-migrations`, which CI
 * uses to prove the committed migrations still match schema.prisma. Prisma
 * creates and drops this database, so it must be separate from the real one.
 *
 * Read via process.env rather than env() because env() throws when unset, and
 * everyday commands must work without a shadow database configured.
 */
const shadowDatabaseUrl = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
    ...(shadowDatabaseUrl === undefined ? {} : { shadowDatabaseUrl }),
  },
});
