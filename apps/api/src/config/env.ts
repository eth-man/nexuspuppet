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

  /**
   * Consecutive failed passwords before a local account is locked (ADR-0006).
   *
   * Complements LoginRateLimiter rather than duplicating it: that one is
   * in-memory, per-replica and per-minute, so it blunts a burst but never
   * accumulates. This is persistent and per-account, so a slow attack spread
   * across replicas and hours still trips it.
   *
   * 0 disables lockout, for a deployment that would rather accept guessing than
   * ever risk a real user being locked out.
   */
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(0).max(100).default(5),
  /**
   * How long a locked account refuses passwords.
   *
   * Time-boxed deliberately. A permanent lock turns a guessable email address
   * into a denial of service against a named person, recoverable only by an
   * administrator — and if that person IS the administrator, by nobody.
   */
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
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
    .default('os,networking,processors,memory,virtual,is_virtual,fqdn,domain,kernel,role')
    .transform((raw) =>
      raw
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    ),
  /**
   * 0 disables the projector for this process — useful for a replica that only
   * serves HTTP, or a deployment where PuppetDB is not yet wired up.
   * NodeProjectionService already treats a non-positive interval as disabled;
   * rejecting 0 here made that path unreachable.
   */
  PUPPETDB_PROJECTION_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),

  // ADR-0003
  ENC_OUTPUT_DIR: z.string().min(1),
  ENC_DEFAULT_ENVIRONMENT: z.string().default('production'),
  ENC_MATERIALIZER_INTERVAL_MS: durationMs(2_000),
  ENC_RECONCILE_INTERVAL_MS: durationMs(900_000),
  ENC_MAX_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),

  /**
   * Materializer pacing.
   *
   * A single rule change can enqueue work for every node in the estate. Left
   * unpaced that is thousands of fsyncs in one burst, on a disk shared with
   * Postgres. These bound how much happens at once and how long the advisory
   * lock — and its transaction — is held.
   */
  ENC_MATERIALIZER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  /** Nodes rewritten per chunk of a full reconcile, which is otherwise one job of unbounded size. */
  ENC_MATERIALIZER_RECONCILE_CHUNK: z.coerce.number().int().min(1).max(2000).default(100),
  ENC_MATERIALIZER_BATCH_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(100),
  ENC_MATERIALIZER_MAX_DRAIN_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validate `process.env`. Aggregates every problem into one message — an
 * operator fixing a misconfigured deployment should see all of it at once, not
 * discover the next missing variable on each restart.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // A .env file routinely carries `SOME_VAR=` for values the operator has not
  // filled in yet. Zod sees an empty string as present-but-invalid, so an
  // unfilled optional would block boot and a blank line would defeat a
  // default. Treat empty as absent — which is what an operator means by it.
  const present: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') present[key] = value;
  }

  const result = envSchema.safeParse(present);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}
