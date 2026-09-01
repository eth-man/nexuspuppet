import { z } from 'zod';

/**
 * Configuration for audit export.
 *
 * Read from the environment and validated at BOOT, not at first delivery. A
 * deployment that thinks it is forwarding audit records to a SIEM and is not is
 * a compliance failure that only becomes visible during an investigation —
 * which is the worst possible moment to discover a typo in a URL.
 */

const auditExportSchema = z.object({
  /**
   * Where records go. HTTPS is required.
   *
   * Audit records carry actor identities, IP addresses and the before/after of
   * every change. Sending that over plain HTTP would leak the estate's entire
   * change history to anything on the path, so `http://` is refused outright
   * rather than warned about. A collector on localhost is the one exception,
   * because that is a sidecar pattern rather than a network hop.
   */
  url: z
    .string()
    .refine(
      (raw) => {
        // Parsed defensively rather than after a separate .url() check: Zod
        // runs refinements even when an earlier check has already failed, so a
        // malformed value would reach this and throw a bare "Invalid URL"
        // instead of the message below.
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          return false;
        }
        if (parsed.protocol === 'https:') return true;
        return (
          parsed.protocol === 'http:' &&
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
        );
      },
      {
        message:
          'AUDIT_EXPORT_URL must be a valid https:// URL — audit records carry actor ' +
          'identities and the before/after of every change. Plain http:// is permitted ' +
          'only for a collector on localhost.',
      },
    ),

  /** Sent as `Authorization: Bearer`. Never logged. */
  token: z.string().min(1).optional(),

  /**
   * CA for a collector using an internal certificate authority.
   *
   * A path, never inline PEM: certificate material in an environment variable
   * ends up in process listings, container inspect output and crash dumps.
   */
  caPath: z.string().min(1).optional(),

  /**
   * Bounded, because the worker holds no database transaction but does hold the
   * delivery lease. A collector that accepts a connection and never answers
   * would otherwise stall forwarding indefinitely.
   */
  timeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  /**
   * Entity types to forward. Empty means everything.
   *
   * Forwarding policy belongs here rather than in core: which records are worth
   * sending is a deployment's decision, and core has no opinion about it.
   */
  entityTypes: z.array(z.string().min(1)).default([]),
});

export type AuditExportConfig = z.infer<typeof auditExportSchema>;

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Build the config, or return null when audit export is not configured.
 *
 * Null rather than a throw: an estate may install this layer for LDAP and want
 * nothing to do with audit export. Absence is a valid configuration; a URL that
 * is present but wrong is not, and that throws.
 */
export function auditExportConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuditExportConfig | null {
  const url = env['AUDIT_EXPORT_URL'];
  if (url === undefined || url.trim() === '') return null;

  const parsed = auditExportSchema.safeParse({
    url: url.trim(),
    token: env['AUDIT_EXPORT_TOKEN'],
    caPath: env['AUDIT_EXPORT_CA_PATH'],
    timeoutMs: env['AUDIT_EXPORT_TIMEOUT_MS'],
    entityTypes: list(env['AUDIT_EXPORT_ENTITY_TYPES']),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid audit export configuration: ${detail}`);
  }

  return parsed.data;
}
