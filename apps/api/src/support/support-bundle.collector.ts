import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLogFileName } from '../logging/pure/log-record';
import type { PrismaService } from '../prisma/prisma.service';
import { selectWindow, type HostLog } from './pure/log-window';
import type { ConditionRow } from './pure/bundle';
import { AUDIT_ROW_CAP } from './pure/bundle';

/**
 * The I/O half of the support bundle (ADR-0028): reading files and rows.
 *
 * EVERY QUERY NAMES ITS COLUMNS. `findMany()` without a `select` would pick up
 * whatever a future migration adds to a table — the next sensitive column
 * would be exported the day it is created. Selecting explicitly makes a new
 * column invisible here until somebody decides it belongs.
 *
 * Nothing here redacts or decides; `pure/bundle.ts` does both.
 */

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export async function collectLogs(
  directory: string,
  from: string,
  to: string,
): Promise<{ hosts: HostLog[]; readError: string | null }> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    return { hosts: [], readError: describe(error) };
  }

  const byHost = new Map<string, Array<{ name: string; generation: number }>>();
  for (const name of names) {
    const parsed = parseLogFileName(name);
    if (parsed === null) continue;
    const list = byHost.get(parsed.host) ?? [];
    list.push({ name, generation: parsed.generation });
    byHost.set(parsed.host, list);
  }

  const hosts: HostLog[] = [];
  for (const host of [...byHost.keys()].sort()) {
    // Oldest first: the highest generation number is the oldest file.
    const files = (byHost.get(host) ?? []).sort((a, b) => b.generation - a.generation);
    const log: HostLog = {
      host,
      lines: [],
      files: [],
      earliestOnDisk: null,
      latestOnDisk: null,
      unparseable: 0,
    };

    for (const file of files) {
      const path = join(directory, file.name);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue; // rotated or pruned between readdir and stat
      }
      log.files.push({ name: file.name, bytes: info.size });

      const modified = info.mtime.toISOString();
      if (modified < from) {
        // Every line in it predates the window, so it cannot contribute one —
        // but it does prove history reaches back that far, which is what the
        // coverage check needs. Not read: old rotations are most of the bytes.
        if (log.earliestOnDisk === null || modified < log.earliestOnDisk) {
          log.earliestOnDisk = modified;
        }
        continue;
      }

      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      const selected = selectWindow(content, from, to);
      log.lines.push(...selected.lines);
      log.unparseable += selected.unparseable;
      if (
        selected.earliestOnDisk !== null &&
        (log.earliestOnDisk === null || selected.earliestOnDisk < log.earliestOnDisk)
      ) {
        log.earliestOnDisk = selected.earliestOnDisk;
      }
      if (
        selected.latestOnDisk !== null &&
        (log.latestOnDisk === null || selected.latestOnDisk > log.latestOnDisk)
      ) {
        log.latestOnDisk = selected.latestOnDisk;
      }
    }

    hosts.push(log);
  }

  return { hosts, readError: null };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** AppSetting keys whose VALUES are operational state rather than configuration. */
const OPERATIONAL_SETTINGS = [
  'log.level',
  'audit.delivery.lastOutcome',
  'audit.retention.undeliveredDrops',
  'notifications.announcedUndeliveredDrops',
] as const;

/**
 * Which secret fields each stored configuration kind can hold.
 *
 * Static, because the alternative — reading the names out of the sealed
 * column — means decrypting it, and this feature never decrypts anything.
 * Whether a sealed blob exists at all is read from the row.
 */
const SECRET_FIELDS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  'auth.ldap': ['bindPassword'],
  'auth.oidc': ['clientSecret'],
  'audit.syslog': ['clientKey'],
  'audit.webhook': ['token'],
  'audit.forwarding': [],
  'notifications.webhook': ['token'],
  'notifications.email': ['password'],
};

export async function collectConditions(prisma: PrismaService): Promise<ConditionRow[]> {
  const rows = await prisma.notificationCondition.findMany({
    select: {
      key: true,
      kind: true,
      severity: true,
      summary: true,
      consecutiveFailures: true,
      openedAt: true,
      resolvedAt: true,
      lastEvaluatedAt: true,
    },
    orderBy: [{ openedAt: 'desc' }, { key: 'asc' }],
  });
  return rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    severity: row.severity,
    summary: row.summary,
    consecutiveFailures: row.consecutiveFailures,
    openedAt: row.openedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    lastEvaluatedAt: row.lastEvaluatedAt.toISOString(),
  }));
}

export async function collectProviders(prisma: PrismaService): Promise<unknown> {
  const [rows, sealed] = await Promise.all([
    prisma.providerSetting.findMany({
      // NOT `secrets`. Not selected, not decrypted, not counted by length.
      select: { kind: true, config: true, enabled: true, updatedAt: true },
      orderBy: { kind: 'asc' },
    }),
    prisma.providerSetting.findMany({
      where: { secrets: { not: null } },
      select: { kind: true },
    }),
  ]);
  const sealedKinds = new Set(sealed.map((row) => row.kind));

  return {
    note:
      'Stored configurations only. A kind absent here is configured from the environment ' +
      '(see config/environment.json) or not at all. Secret values are never read; ' +
      '`secretsSealed` says whether an encrypted secret blob is stored for the kind, and ' +
      '`secretFields` lists the field names that blob can hold.',
    stored: rows.map((row) => ({
      kind: row.kind,
      source: 'database',
      enabled: row.enabled,
      updatedAt: row.updatedAt.toISOString(),
      config: row.config,
      secretsSealed: sealedKinds.has(row.kind),
      secretFields: SECRET_FIELDS_BY_KIND[row.kind] ?? ['(unknown kind: withheld)'],
    })),
  };
}

export interface DatabaseFacts {
  files: Record<string, unknown>;
  materializationFailed: number;
  materializationPending: number;
  auditDeliveryQueued: number;
  newestProjectionAt: string | null;
}

export async function collectDatabase(prisma: PrismaService): Promise<DatabaseFacts> {
  const [
    migrations,
    jobCounts,
    jobs,
    materializations,
    conflicted,
    nodes,
    nodeFlags,
    nodeStatuses,
    peers,
    receipts,
    receiptPeers,
    auditQueue,
    auditErrors,
    notificationQueue,
    notificationErrors,
    settings,
    users,
    roles,
  ] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        migration_name: string;
        started_at: Date;
        finished_at: Date | null;
        rolled_back_at: Date | null;
        applied_steps_count: number;
      }>
    >`SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
        FROM _prisma_migrations ORDER BY started_at, migration_name`,
    prisma.encMaterializationJob.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.encMaterializationJob.findMany({
      where: { status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] } },
      select: {
        id: true,
        certname: true,
        kind: true,
        reason: true,
        status: true,
        attempts: true,
        lastError: true,
        nextAttemptAt: true,
        createdAt: true,
        startedAt: true,
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    }),
    prisma.encMaterialization.aggregate({
      _count: { _all: true },
      _min: { writtenAt: true },
      _max: { writtenAt: true, revision: true },
    }),
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM enc_materializations
       WHERE jsonb_typeof(conflicts) = 'array' AND jsonb_array_length(conflicts) > 0`,
    prisma.managedNode.aggregate({
      _count: { _all: true },
      _min: { projectedAt: true, factsTimestamp: true, reportTimestamp: true },
      _max: { projectedAt: true, factsTimestamp: true, reportTimestamp: true },
    }),
    prisma.managedNode.groupBy({
      by: ['deactivated', 'expired'],
      _count: { _all: true },
    }),
    prisma.managedNode.groupBy({ by: ['latestReportStatus'], _count: { _all: true } }),
    prisma.encReplicationPeer.findMany({
      select: {
        certname: true,
        firstSeenAt: true,
        lastFetchAt: true,
        lastEtag: true,
        lastStatus: true,
        lastChangedAt: true,
        fetchCount: true,
      },
      orderBy: { certname: 'asc' },
    }),
    prisma.compileReceipt.groupBy({ by: ['matchedAtIngest'], _count: { _all: true } }),
    prisma.compileReceipt.groupBy({
      by: ['peerCertname'],
      _count: { _all: true },
      _max: { reportedAt: true },
      _min: { reportedAt: true },
    }),
    prisma.auditDeliveryJob.aggregate({
      _count: { _all: true },
      _min: { createdAt: true, nextAttemptAt: true },
      _max: { attempts: true },
    }),
    prisma.auditDeliveryJob.groupBy({
      by: ['lastError'],
      _count: { _all: true },
      _max: { attempts: true },
    }),
    prisma.notificationDeliveryJob.aggregate({
      _count: { _all: true },
      _min: { createdAt: true, nextAttemptAt: true },
      _max: { attempts: true },
    }),
    prisma.notificationDeliveryJob.groupBy({
      // Condition and transition, never the payload.
      by: ['conditionKey', 'transition', 'lastError'],
      _count: { _all: true },
      _max: { attempts: true },
    }),
    prisma.appSetting.findMany({
      select: { key: true, value: true, updatedAt: true },
      orderBy: { key: 'asc' },
    }),
    prisma.user.groupBy({
      by: ['role', 'authSource', 'isActive'],
      _count: { _all: true },
    }),
    prisma.role.findMany({
      select: { name: true, builtIn: true, permissions: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const countOf = (status: string): number =>
    jobCounts.find((row) => row.status === status)?._count._all ?? 0;

  const firstAttempt = await prisma.auditDeliveryJob.count({ where: { attempts: 0 } });

  return {
    materializationFailed: countOf('FAILED'),
    materializationPending: countOf('PENDING'),
    auditDeliveryQueued: auditQueue._count._all,
    newestProjectionAt: nodes._max.projectedAt?.toISOString() ?? null,
    files: {
      'database/migrations.json': migrations.map((row) => ({
        name: row.migration_name,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        rolledBackAt: row.rolled_back_at,
        appliedSteps: row.applied_steps_count,
      })),
      'database/materialization-jobs.json': {
        note:
          'The materializer deletes a job when it claims it, so only outstanding work ' +
          'appears. FAILED jobs are never retried. Rows capped at 500, oldest first per status.',
        countsByStatus: Object.fromEntries(
          jobCounts.map((row) => [row.status, row._count._all] as const),
        ),
        outstanding: jobs,
      },
      'database/materializations.json': {
        nodesMaterialized: materializations._count._all,
        oldestWrittenAt: materializations._min.writtenAt,
        newestWrittenAt: materializations._max.writtenAt,
        highestRevision: materializations._max.revision,
        withConflicts: conflicted[0]?.n ?? 0,
      },
      'database/managed-nodes.json': {
        note: 'The local cache of PuppetDB (ADR-0005). projectedAt is when it was last refreshed.',
        count: nodes._count._all,
        projectedAt: { oldest: nodes._min.projectedAt, newest: nodes._max.projectedAt },
        factsTimestamp: { oldest: nodes._min.factsTimestamp, newest: nodes._max.factsTimestamp },
        reportTimestamp: {
          oldest: nodes._min.reportTimestamp,
          newest: nodes._max.reportTimestamp,
        },
        byFlags: nodeFlags.map((row) => ({
          deactivated: row.deactivated,
          expired: row.expired,
          count: row._count._all,
        })),
        byLatestReportStatus: nodeStatuses.map((row) => ({
          status: row.latestReportStatus,
          count: row._count._all,
        })),
      },
      'database/replication-peers.json': peers,
      'database/compile-receipts.json': {
        byMatchedAtIngest: receipts.map((row) => ({
          matchedAtIngest: row.matchedAtIngest,
          count: row._count._all,
        })),
        byPeer: receiptPeers.map((row) => ({
          peerCertname: row.peerCertname,
          count: row._count._all,
          oldestReportedAt: row._min.reportedAt,
          newestReportedAt: row._max.reportedAt,
        })),
      },
      'database/audit-delivery.json': {
        note: 'The audit forwarding outbox. Each row is a record not yet accepted by the collector.',
        queued: auditQueue._count._all,
        neverAttempted: firstAttempt,
        retrying: auditQueue._count._all - firstAttempt,
        oldestQueuedAt: auditQueue._min.createdAt,
        nextAttemptAt: auditQueue._min.nextAttemptAt,
        maxAttempts: auditQueue._max.attempts,
        errors: auditErrors
          .map((row) => ({
            lastError: row.lastError,
            count: row._count._all,
            maxAttempts: row._max.attempts,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20),
      },
      'database/notification-delivery.json': {
        queued: notificationQueue._count._all,
        oldestQueuedAt: notificationQueue._min.createdAt,
        nextAttemptAt: notificationQueue._min.nextAttemptAt,
        maxAttempts: notificationQueue._max.attempts,
        byCondition: notificationErrors
          .map((row) => ({
            conditionKey: row.conditionKey,
            transition: row.transition,
            lastError: row.lastError,
            count: row._count._all,
            maxAttempts: row._max.attempts,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 50),
      },
      'database/app-settings.json': settings.map((row) =>
        (OPERATIONAL_SETTINGS as readonly string[]).includes(row.key)
          ? { key: row.key, updatedAt: row.updatedAt, value: row.value }
          : { key: row.key, updatedAt: row.updatedAt, value: '[not an operational key: withheld]' },
      ),
      'database/users-and-roles.json': {
        note: 'Counts only. No user is identified.',
        users: users.map((row) => ({
          role: row.role,
          authSource: row.authSource,
          active: row.isActive,
          count: row._count._all,
        })),
        roles,
      },
    },
  };
}

/**
 * Audit rows in the window, newest `AUDIT_ROW_CAP` kept.
 *
 * WHAT HAPPENED, NEVER WHO OR WITH WHAT. No actor id or email, no client
 * address or user agent, no before/after payload — a payload can hold a
 * classification parameter value, and those are where credentials live. Not
 * `entityLabel` either: it is derived from payloads and is a person's email for
 * a user change and a free-text name for a saved query. A User entity's id is
 * a user id, so it is withheld as well.
 */
export async function collectAudit(
  prisma: PrismaService,
  from: Date,
): Promise<{ rows: unknown[]; truncated: number }> {
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where: { createdAt: { gte: from } } }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: from } },
      select: {
        createdAt: true,
        action: true,
        entityType: true,
        entityId: true,
        requestId: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_ROW_CAP,
    }),
  ]);

  return {
    truncated: Math.max(0, total - rows.length),
    rows: rows.reverse().map((row) => ({
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityType === 'User' ? null : row.entityId,
      requestId: row.requestId,
    })),
  };
}

// ---------------------------------------------------------------------------
// Personal data and full configuration — ONLY when the operator ticked for it
// (ADR-0028 §6). Still column-by-column: the opt-in widens the allow-list, it
// does not replace it. Nothing here selects a password hash, a token hash, or
// the sealed secrets column, and nothing here can be asked to.
// ---------------------------------------------------------------------------

/** Audit rows in the window WITH who, from where, and the before/after payloads. */
export async function collectAuditWithPersonalData(
  prisma: PrismaService,
  from: Date,
): Promise<{ rows: unknown[]; truncated: number }> {
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where: { createdAt: { gte: from } } }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: from } },
      select: {
        id: true,
        createdAt: true,
        actorUserId: true,
        actorEmail: true,
        action: true,
        entityType: true,
        entityId: true,
        entityLabel: true,
        requestId: true,
        ipAddress: true,
        userAgent: true,
        before: true,
        after: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_ROW_CAP,
    }),
  ]);

  return {
    truncated: Math.max(0, total - rows.length),
    rows: rows.reverse().map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}

export async function collectPersonalData(
  prisma: PrismaService,
  now: Date,
): Promise<Record<string, unknown>> {
  const [users, sessions, groups, savedQueries] = await Promise.all([
    prisma.user.findMany({
      // NOT passwordHash. NOT refreshTokens.
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        authSource: true,
        isActive: true,
        lastLoginAt: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { email: 'asc' },
    }),
    // A COUNT per user. Never a token, never a hash, never the session's
    // address or agent — how many live sessions exist is the diagnostic fact.
    prisma.refreshToken.groupBy({
      by: ['userId'],
      where: { revokedAt: null, consumedAt: null, expiresAt: { gt: now } },
      _count: { _all: true },
    }),
    prisma.nodeGroup.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        rank: true,
        strategy: true,
        environment: true,
        isEnabled: true,
        parentId: true,
        createdAt: true,
        updatedAt: true,
        rules: {
          select: { id: true, factPath: true, operator: true, value: true },
          orderBy: { createdAt: 'asc' },
        },
        pins: { select: { certname: true, createdAt: true }, orderBy: { certname: 'asc' } },
        classes: {
          select: { className: true, params: true, updatedAt: true },
          orderBy: { className: 'asc' },
        },
        parameters: {
          select: { key: true, value: true, updatedAt: true },
          orderBy: { key: 'asc' },
        },
      },
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
    }),
    prisma.savedQuery.findMany({
      select: {
        ownerEmail: true,
        name: true,
        kind: true,
        filter: true,
        isShared: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ ownerEmail: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const liveSessions = new Map(sessions.map((row) => [row.userId, row._count._all] as const));

  return {
    'personal/users.json': {
      note:
        'Every account. No password hash, token or session detail is included — ' +
        'activeSessions is a count of unexpired, unrevoked refresh tokens.',
      users: users.map((user) => ({
        ...user,
        lockedOut: user.lockedUntil !== null && user.lockedUntil > now,
        activeSessions: liveSessions.get(user.id) ?? 0,
      })),
    },
    'config/classification.json': {
      note:
        'The classification in full, including parameter values. Parameters can hold ' +
        'secrets; literal values of secret environment variables are still redacted.',
      groups,
    },
    'config/saved-queries.json': savedQueries,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}
