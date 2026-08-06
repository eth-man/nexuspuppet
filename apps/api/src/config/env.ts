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

  /**
   * Encrypts settings an operator stores through the console (ADR-0016 §3).
   *
   * OPTIONAL, and absent is a complete configuration: a deployment that
   * configures everything through the environment stores no secrets and needs
   * no key. Set it, and stored secrets become possible.
   *
   * NOT `JWT_SECRET`, deliberately. One key, one purpose — rotating a signing
   * secret must not decide whether every stored credential stays readable, and
   * a key compromised in one role must not surrender the other.
   *
   * Validated here only for presence and shape; `parseKey` does the decoding,
   * because a 32-character string and a key that decodes to 32 BYTES are
   * different things and only the second one is correct.
   */
  CONFIG_ENCRYPTION_KEY: z.string().min(1).optional(),

  /**
   * Ignore stored settings and read everything from this environment.
   *
   * The escape hatch from ADR-0016 §2. Without it, a configuration saved
   * through the console that does not work leaves an operator unable to
   * authenticate AND unable to override it, because the database wins. It
   * requires host access, which whoever is running this has by definition.
   */
  SETTINGS_SOURCE: z.enum(['db', 'env']).default('db'),

  ACCESS_TOKEN_TTL: z.string().default('60m'),
  /**
   * How long a refused login takes, whatever refused it (ADR-0015).
   *
   * Configured rather than probed: measuring the slowest provider at boot makes
   * startup depend on a directory that may be slow or not yet running. A local
   * refusal costs one scrypt; a directory refusal costs a network round trip,
   * and without a shared floor the difference tells an attacker which accounts
   * exist and where they live.
   */
  AUTH_LOGIN_FLOOR_MS: z.coerce.number().int().min(0).default(1500),
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

  // ADR-0016 §6 — the audit table is bounded in every edition.
  /**
   * How long audit records are kept. Age bounds the creep; the row ceiling
   * below bounds the burst. Records with a pending delivery job are exempt
   * from age-based sweeping, however old — an outage must not become silent
   * data loss.
   */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /**
   * Hard ceiling on audit rows. UNSET BY DEFAULT, deliberately: the ceiling
   * is the one bound permitted to delete undelivered records, and there is no
   * estate-scale measurement to size a default against — a default that trips
   * on a normal Tuesday is worse than no ceiling (ADR-0016, resolved
   * question 2). The floor exists because a tiny ceiling is a foot-gun that
   * would empty the table.
   */
  AUDIT_RETENTION_MAX_ROWS: z.coerce.number().int().min(1_000).optional(),
  /** How often the sweeper looks for work. 0 disables it in this process. */
  AUDIT_RETENTION_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  /** Rows deleted per batch. Small batches keep vacuum happy. */
  AUDIT_RETENTION_BATCH_SIZE: z.coerce.number().int().min(10).max(10_000).default(500),
  /**
   * Batches per pass. A pass that hits this stops rather than catching up in
   * one go — one enormous delete produces exactly the bloat and I/O spike
   * retention exists to avoid.
   */
  AUDIT_RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(10),

  // ADR-0004 — paths to mounted files, never inline PEM content.
  PUPPETDB_URL: z.string().url(),
  PUPPETDB_CERT_PATH: z.string().min(1),
  PUPPETDB_KEY_PATH: z.string().min(1),
  PUPPETDB_CA_PATH: z.string().min(1),
  PUPPETDB_TIMEOUT_MS: durationMs(10_000),
  /**
   * Allow-list of facts projected into ManagedNode for rule evaluation.
   *
   * Every name here must be a fact MODERN FACTER ACTUALLY EMITS. A name no node
   * reports is not inert: a rule written against it can never match, and nothing
   * reports an error — the group simply classifies nothing, forever.
   *
   * `fqdn`, `domain` and `role` were in this default until they were checked
   * against real estates. Facter 4 dropped the legacy flat facts, so an OpenVox
   * or Puppet 8 agent reports 31 top-level facts where puppet-agent 7.20 reports
   * 113: `fqdn` and `domain` now exist ONLY under `networking`, and `role` was
   * never a Facter fact on either. Nothing is lost by removing them —
   * `networking.fqdn` and `networking.domain` resolve on both estates, because
   * `networking` is projected.
   *
   * Before adding a name, confirm a real node reports it. `npm run test:puppetdb`
   * names projected facts the sampled node lacks, and the projector logs any
   * that no node reports at all.
   */
  PUPPETDB_PROJECTED_FACTS: z
    .string()
    .default(
      // Keep in step with .env.example, which explains the choices. A
      // deployment that never copies that file still gets this.
      'role,profile,tier,datacenter,location,application,tenant,cluster,trusted,clientcert,fips_enabled,os,kernel,kernelrelease,timezone,system_uptime,networking,processors,memory,virtual,is_virtual,dmi,disks',
    )
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

  /**
   * How often to ask PuppetDB which nodes' FACTS changed.
   *
   * A fact change alters group membership with no classification edit to
   * trigger it, so without this a node stays misclassified until the next full
   * sweep. The poll is cheap — usually zero rows, and facts are fetched only
   * for what comes back — which is what makes running it frequently reasonable.
   *
   * OUTBOUND ONLY. Nothing is exposed for puppetserver to call, so a slow or
   * absent NexusPuppet cannot affect an agent run (ADR-0003). That is why this
   * is a poll and not a webhook.
   *
   * 0 disables it; the full sweep alone then behaves exactly as before.
   */
  PUPPETDB_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  /**
   * How far back each poll looks beyond the newest fact timestamp it has seen.
   *
   * facts_timestamp comes from the agent, so clocks differ and several nodes
   * share a boundary second; a strict comparison against the exact high-water
   * mark drops whatever sat on it. Re-reading a few unchanged nodes costs one
   * content hash each and writes nothing.
   */
  PUPPETDB_POLL_OVERLAP_MS: z.coerce.number().int().min(0).max(3_600_000).default(120_000),

  // ADR-0003
  ENC_OUTPUT_DIR: z.string().min(1),

  /*
   * ENC tree replication (ADR-0019).
   *
   * Off by default. A deployment whose puppetserver shares the host reads the
   * tree from a mount and needs none of this; switching it on should be a
   * decision, not something that happens because a default said so.
   */
  ENC_REPLICATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ENC_REPLICATION_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  /**
   * Binds every interface by default, unlike the API.
   *
   * That is the point of it: the puller is on another host. It is safe to
   * expose because it terminates mTLS itself and admits only allowlisted
   * certnames — the same reasoning docker-compose.yml gives for the proxy.
   */
  ENC_REPLICATION_BIND: z.string().min(1).default('0.0.0.0'),
  /**
   * Certnames permitted to replicate, comma separated.
   *
   * NO DEFAULT, and an empty list serves nobody. The estate-wide Puppet CA
   * signs every agent, so a valid certificate proves only that the caller is
   * part of the estate; this list is what stops any node reading the whole
   * estate's classification. A permissive default here would be a
   * confused-deputy hole switched on by an operator who never saw it.
   */
  ENC_REPLICATION_ALLOWED_CERTNAMES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  /**
   * The certificate this endpoint is SERVED with, and the CA that client
   * certificates are verified against.
   *
   * Defaults to the PuppetDB client material, which is not a shortcut: that
   * certificate is issued by the Puppet CA and carries both serverAuth and
   * clientAuth, and the CA file is the same Puppet CA the pullers are signed
   * by. Reusing it is what makes ADR-0019 §5's "no new secret is created,
   * distributed, rotated or leaked" literally true.
   */
  ENC_REPLICATION_CERT_PATH: z.string().min(1).default('/etc/nexuspuppet/certs/client.pem'),
  ENC_REPLICATION_KEY_PATH: z.string().min(1).default('/etc/nexuspuppet/certs/client.key'),
  ENC_REPLICATION_CA_PATH: z.string().min(1).default('/etc/nexuspuppet/certs/ca.pem'),

  /**
   * The PUBLIC certificate the console is served with (ADR-0013), for reporting
   * its expiry in Settings.
   *
   * Optional, and unset is the normal state: most deployments terminate TLS at
   * their own proxy and this reports "not configured" rather than an error.
   *
   * Mount the single .pem file, never the directory containing the key. The API
   * has no reason to be able to read a private key and should not be given the
   * opportunity.
   */
  CONSOLE_TLS_CERT_PATH: z.string().optional(),
  /** The name operators reach the console by, to check the certificate covers it. */
  CONSOLE_HOSTNAME: z.string().optional(),
  /**
   * Shared with the cert-helper service, which verifies installation grants
   * signed with it (ADR-0017).
   *
   * Optional: a deployment that terminates TLS elsewhere runs no helper and
   * needs no key. Absent means the console cannot offer certificate
   * installation, which is reported rather than assumed.
   *
   * This authorises an upload. It is NOT key material and never touches one —
   * the certificate and its private key go from the browser to the helper
   * without passing through this process.
   */
  CERT_HELPER_SECRET: z.string().min(32).optional(),
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
