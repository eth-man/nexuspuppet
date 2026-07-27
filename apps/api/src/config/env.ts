import { z } from 'zod';

/**
 * Environment validation. Fails fast and loudly at boot rather than producing a
 * confusing runtime error hours later.
 *
 * Note what has NO default: JWT_SECRET, DATABASE_URL, and the PuppetDB
 * certificate paths. A development fallback for a secret is exactly the kind of
 * thing that reaches production (ADR-0006).
 */

const durationMs = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ADR-0005
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ADR-0006 — no default, deliberately.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters. Generate: openssl rand -base64 48'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),

  // ADR-0004 — paths to mounted files, never inline PEM content.
  PUPPETDB_URL: z.string().url(),
  PUPPETDB_CERT_PATH: z.string().min(1),
  PUPPETDB_KEY_PATH: z.string().min(1),
  PUPPETDB_CA_PATH: z.string().min(1),
  PUPPETDB_TIMEOUT_MS: durationMs(10_000),
  /** Allow-list of facts projected into ManagedNode for rule evaluation. */
  PUPPETDB_PROJECTED_FACTS: z
    .string()
    .default('os,networking,processors,memory,virtual,is_virtual,fqdn,domain,kernel')
    .transform((raw) =>
      raw
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    ),
  PUPPETDB_PROJECTION_INTERVAL_MS: durationMs(300_000),

  // ADR-0003
  ENC_OUTPUT_DIR: z.string().min(1),
  ENC_DEFAULT_ENVIRONMENT: z.string().default('production'),
  ENC_MATERIALIZER_INTERVAL_MS: durationMs(2_000),
  ENC_RECONCILE_INTERVAL_MS: durationMs(900_000),
  ENC_MAX_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validate `process.env`. Aggregates every problem into one message — an
 * operator fixing a misconfigured deployment should see all of it at once, not
 * discover the next missing variable on each restart.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}
