import { hostname as osHostname } from 'node:os';
import { resetPasswordSchema } from '@nexuspuppet/contracts';
import type { IAuditSink } from '@nexuspuppet/contracts';
import type { Prisma } from '../generated/prisma/client';
import { auditExportConfigFromEnv, type AuditExportConfig } from '../audit-forwarding/config';
import { ForwardingAuditSink } from '../audit-forwarding/forwarding-audit-sink';
import { SettingsAuditTransport } from '../audit-forwarding/settings-transport';
import { AuditDeliveryOutbox } from '../auth/audit-delivery.outbox';
import { PrismaAuditSink } from '../auth/core-capabilities';
import { normalizeEmail } from '../auth/local-auth.provider';
import { envSchema } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditForwardingResolver } from '../settings/audit-forwarding.resolver';
import { SettingsStore } from '../settings/settings.store';

/**
 * Operator recovery for a lost local password: `deploy.sh --reset-admin`.
 *
 * WHY THIS EXISTS. An operator lost the only administrator's password. Nothing
 * supported could get them back in: BOOTSTRAP_ADMIN_* only seeds an EMPTY users
 * table, and scripts/dev/rotate-admin-password.mjs needs the current password.
 * The workaround was a hand-written hash and two UPDATE statements in psql —
 * correct, but fiddly, and it left no audit row for a credential change on the
 * most privileged account in the product.
 *
 * WHO MAY RUN IT. Whoever can run `docker compose` against this deployment.
 * That person can already read .env (JWT_SECRET, POSTGRES_PASSWORD) and is
 * root-equivalent over the console; this adds no capability they lack, it only
 * makes the one they have safe and audited.
 *
 * WHAT IT DOES, in ONE transaction (ADR-0005): set the password, clear the
 * lockout counters, reactivate the account, revoke every refresh token, and
 * write the `user.password.reset` audit row through the same sink chain the API
 * uses — so a configured SIEM receives it as well.
 *
 * WHAT IT DOES NOT DO: boot Nest. No HTTP server, timers, materializer,
 * projection or replication listener — the API may be down or crash-looping
 * while this runs, and a second copy of any of those would be a problem of its
 * own. Every object below is constructed directly; none of them starts work.
 */

export const EXIT = {
  ok: 0,
  failed: 1,
  notFound: 2,
  notLocal: 3,
  invalidPassword: 4,
} as const;

/** The slice of a transaction client the reset touches. */
type ResetTx = Pick<Prisma.TransactionClient, 'user' | 'refreshToken' | 'auditLog'>;

export interface ResetDb {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

export interface ResetDeps {
  db: ResetDb;
  audit: IAuditSink;
  hash: (plaintext: string) => Promise<string>;
  /** Recorded as the audit actor. Never a user's address: no user did this. */
  actor: string;
  now?: () => Date;
}

export type ResetOutcome =
  | {
      kind: 'reset';
      email: string;
      role: string;
      unlocked: boolean;
      reactivated: boolean;
      sessionsEnded: number;
    }
  | { kind: 'not-found'; email: string }
  | { kind: 'not-local'; email: string; authSource: string }
  | { kind: 'invalid-password'; message: string };

/**
 * The same rule the console's reset applies (resetPasswordSchema), never a
 * private copy of it — a CLI that accepted a shorter password would be the
 * weakest door into the most privileged account.
 */
export function checkPassword(password: string): string | null {
  const parsed = resetPasswordSchema.safeParse({ newPassword: password });
  if (parsed.success) return null;

  const issue = parsed.error.issues[0];
  if (issue?.code === 'too_small') {
    return `The password must be at least ${String(issue.minimum)} characters.`;
  }
  if (issue?.code === 'too_big') {
    return `The password must be at most ${String(issue.maximum)} characters.`;
  }
  return 'The password does not meet the password policy.';
}

export async function resetLocalPassword(
  deps: ResetDeps,
  input: { email: string; password: string },
): Promise<ResetOutcome> {
  const problem = checkPassword(input.password);
  if (problem !== null) return { kind: 'invalid-password', message: problem };

  // The same normalisation login applies, so the account found here is the
  // account that will be signed in to.
  const email = normalizeEmail(input.email);

  // Hashed BEFORE the transaction: scrypt is ~100ms by design, and holding a
  // pooled connection open for it buys nothing.
  const passwordHash = await deps.hash(input.password);
  const now = (deps.now ?? (() => new Date()))();

  return deps.db.$transaction(async (client): Promise<ResetOutcome> => {
    const tx: ResetTx = client;

    const user = await tx.user.findUnique({ where: { email } });
    if (user === null) return { kind: 'not-found', email };

    // Same refusal, and the same words, as UsersService.resetPassword. Since
    // ADR-0015 a login dispatches on authSource, so a hash written here would
    // never authenticate anybody — it would only leave a credential on disk for
    // an identity the directory owns.
    if (user.authSource !== 'local') {
      return { kind: 'not-local', email: user.email, authSource: user.authSource };
    }

    const unlocked = user.lockedUntil !== null && user.lockedUntil > now;
    const reactivated = !user.isActive;

    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null, isActive: true },
    });

    // TokenService.revokeAllForUser's semantics — revoked, not deleted, so
    // reuse detection still recognises them — but on THIS transaction, so the
    // password and the sessions it ends cannot commit apart.
    const revoked = await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });

    await deps.audit.record(
      {
        actorUserId: null,
        actorEmail: deps.actor,
        action: 'user.password.reset',
        entityType: 'User',
        entityId: user.id,
        before: null,
        after: { email: user.email, via: 'cli', unlocked, reactivated },
        ipAddress: null,
        userAgent: null,
      },
      client,
    );

    return {
      kind: 'reset',
      email: user.email,
      role: user.role,
      unlocked,
      reactivated,
      sessionsEnded: revoked.count,
    };
  });
}

/** How each outcome is reported. The password and its hash appear in none. */
export function reportOutcome(outcome: ResetOutcome): {
  code: number;
  stdout: string[];
  stderr: string[];
} {
  switch (outcome.kind) {
    case 'reset': {
      const stdout = [
        `Password reset for ${outcome.email}. Sessions ended; account unlocked and active.`,
        // Accurate rather than reassuring: access tokens are verified from their
        // claims alone (TokenService.verifyAccessToken), so revoking the refresh
        // tokens stops renewal but not a token already in a browser.
        'An access token issued before now stays valid until it expires (ACCESS_TOKEN_TTL, 60m by default).',
        'Recorded in the audit log as user.password.reset.',
      ];
      if (outcome.role !== 'ADMIN') {
        stdout.push(`Note: ${outcome.email} has the ${outcome.role} role, not ADMIN.`);
      }
      return { code: EXIT.ok, stdout, stderr: [] };
    }
    case 'not-found':
      return {
        code: EXIT.notFound,
        stdout: [],
        stderr: [`No account with that email (${outcome.email}). Nothing was changed.`],
      };
    case 'not-local':
      return {
        code: EXIT.notLocal,
        stdout: [],
        stderr: [
          `${outcome.email} is authenticated by "${outcome.authSource}", not by a local password. ` +
            'Reset it in that directory instead.',
        ],
      };
    case 'invalid-password':
      return { code: EXIT.invalidPassword, stdout: [], stderr: [outcome.message] };
  }
}

/**
 * The first line of stdin, without its line ending.
 *
 * Stdin and nothing else: argv and the environment are readable by other
 * processes (/proc/<pid>/cmdline, /proc/<pid>/environ) and argv lands in shell
 * history. Bounded, because nothing legitimate is longer than the policy's
 * maximum and an unbounded read is a way to exhaust memory.
 */
export async function readPassword(
  stream: AsyncIterable<Buffer | string>,
  maxBytes = 8192,
): Promise<string> {
  let buffered = '';
  let bytes = 0;
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += Buffer.byteLength(text);
    buffered += text;
    const newline = buffered.indexOf('\n');
    if (newline !== -1) {
      buffered = buffered.slice(0, newline);
      break;
    }
    if (bytes > maxBytes) break;
  }
  return buffered.replace(/\r$/, '');
}

/**
 * The audit sink chain the API binds to AUDIT_SINK (app.module.ts,
 * auditForwardingProviders): ForwardingAuditSink over PrismaAuditSink, gated by
 * the settings-driven transport. Built by hand rather than through Nest, so
 * nothing else in AppModule is constructed.
 *
 * The one difference is the gate. The API asks the transport's CACHED view on
 * each write; a process that writes once has no cache to warm, so it resolves
 * the stored forwarding state once, up front. If that cannot be resolved — a
 * malformed CONFIG_ENCRYPTION_KEY or AUDIT_EXPORT_*, which also keep the API
 * from booting — the record is queued anyway: one job waiting for a transport
 * is a far smaller cost than a SIEM that never hears about an admin reset.
 */
export async function buildAuditSink(
  prisma: PrismaService,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): Promise<IAuditSink> {
  let auditExport: AuditExportConfig | null = null;
  try {
    auditExport = auditExportConfigFromEnv(env);
  } catch (error) {
    warn(
      `${message(error)} — forwarding filters from the environment are ignored for this record.`,
    );
  }

  let forwarding = true;
  try {
    const settings = cliSettings(env);
    const store = new SettingsStore(
      prisma,
      settings.CONFIG_ENCRYPTION_KEY,
      settings.SETTINGS_SOURCE,
    );
    const transport = new SettingsAuditTransport(new AuditForwardingResolver(store), auditExport);
    forwarding = await transport.isConfigured();
  } catch (error) {
    warn(
      `Could not resolve audit forwarding (${message(error)}); the record will be queued for forwarding.`,
    );
  }

  return new ForwardingAuditSink(
    new PrismaAuditSink(prisma),
    new AuditDeliveryOutbox(prisma),
    auditExport,
    () => forwarding,
  );
}

/**
 * Only the variables this command needs, validated by the API's own schema.
 *
 * NOT loadEnv(). That validates the whole configuration, and an API that is
 * crash-looping on a bad value elsewhere — exactly when somebody may be
 * locked out — must not also block the recovery.
 */
export function cliSettings(env: NodeJS.ProcessEnv): {
  DATABASE_URL: string;
  CONFIG_ENCRYPTION_KEY?: string | undefined;
  SETTINGS_SOURCE: 'db' | 'env';
} {
  // Empty means absent, as loadEnv() treats it.
  const present: Record<string, string> = {};
  for (const key of ['DATABASE_URL', 'CONFIG_ENCRYPTION_KEY', 'SETTINGS_SOURCE']) {
    const value = env[key];
    if (value !== undefined && value !== '') present[key] = value;
  }
  const parsed = envSchema
    .pick({ DATABASE_URL: true, CONFIG_ENCRYPTION_KEY: true, SETTINGS_SOURCE: true })
    .safeParse(present);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/**
 * The audit actor: a marker no account can hold, naming the host it ran on.
 *
 * Inside a container os.hostname() is the container id, which identifies
 * nothing a week later — so deploy.sh passes the host's name in. Restricted to
 * hostname characters because it lands in the audit trail verbatim.
 */
export function actorFor(hostFromEnv: string | undefined): string {
  const candidate = (hostFromEnv ?? '').trim();
  const host = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(candidate) ? candidate : osHostname();
  return `cli:deploy.sh@${host}`;
}

/**
 * An error's message with every secret in `secrets` removed.
 *
 * A Prisma error can quote the arguments of the query that failed, and the
 * update's arguments include the new hash. A message that may reach a terminal,
 * a CI log or a support ticket must not carry either.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
