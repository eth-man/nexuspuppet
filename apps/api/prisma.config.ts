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
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
