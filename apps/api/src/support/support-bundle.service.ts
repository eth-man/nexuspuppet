import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUDIT_SINK, type IAuditSink } from '@nexuspuppet/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { FileLogSink } from '../logging/file-log-sink';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentService } from '../system/deployment.service';
import { LogLevelService } from '../system/log-level.service';
import { PropagationService } from '../system/propagation.service';
import { SystemStatusService } from '../system/system-status.service';
import { buildBundle, type BuiltBundle, type ConditionRow } from './pure/bundle';
import { environmentReport } from './pure/environment';
import {
  collectAudit,
  collectAuditWithPersonalData,
  collectConditions,
  collectDatabase,
  collectLogs,
  collectPersonalData,
  collectProviders,
  type DatabaseFacts,
} from './support-bundle.collector';

export interface SupportBundleOptions {
  /** Where every replica's log files live (LOG_DIR). */
  logDirectory: string;
  /** This replica's hostname — its container id under Compose. */
  host: string;
  version: string;
  /** The environment to report. process.env in production. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Injected so tests do not depend on the wall clock. */
  now?: () => Date;
}

/**
 * Builds a support bundle (ADR-0028): audit, collect, assemble.
 *
 * DEGRADES, NEVER REFUSES. A bundle is needed most when something is broken,
 * and "the database is down" is one of the things that breaks. Each section is
 * collected on its own; one that fails becomes a file saying why, and the rest
 * of the bundle still arrives. Refusing the whole export because one query
 * failed would withhold the logs that explain the failure.
 */
@Injectable()
export class SupportBundleService {
  private readonly logger = new Logger(SupportBundleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    private readonly status: SystemStatusService,
    private readonly propagation: PropagationService,
    private readonly logLevels: LogLevelService,
    private readonly deployment: DeploymentService,
    private readonly sink: FileLogSink,
    private readonly options: SupportBundleOptions,
  ) {}

  /**
   * @param includePersonalData the operator's explicit, per-download opt-in
   *   (ADR-0028 §6). Widens what is COLLECTED; never switches off a secret rule.
   */
  async build(
    hours: number,
    includePersonalData: boolean,
    request: AuthenticatedRequest,
  ): Promise<BuiltBundle> {
    const now = this.options.now?.() ?? new Date();
    const generatedAt = now.toISOString();
    const from = new Date(now.getTime() - hours * 3_600_000);

    /*
     * Audited FIRST, before anything is read — the same order as the TLS grant.
     * The export is the auditable event, and writing it first means the bundle
     * contains its own export record, which is a cheap end-to-end proof that
     * the audit path works.
     *
     * Through AUDIT_SINK, so it is forwarded like every other record. It says
     * whether personal data went out, so "who exported the user list, and
     * when" has an answer.
     */
    let auditError: string | null = null;
    try {
      await this.audit.record({
        actorUserId: request.principal?.userId ?? null,
        actorEmail: request.principal?.email ?? null,
        action: 'system.support-bundle.export',
        entityType: 'SupportBundle',
        entityId: null,
        entityLabel: includePersonalData ? 'with personal data' : 'without personal data',
        before: null,
        after: { hours, includePersonalData },
        ipAddress: request.ip ?? null,
        userAgent: headerOf(request, 'user-agent'),
      });
    } catch (error) {
      /*
       * Proceed WITHOUT the record, and say so twice: here, and in the bundle.
       *
       * The audit write fails when the database does, and a database outage is
       * precisely when somebody needs this. The caller is authenticated and
       * holds settings:manage — the token check needs no database — so the
       * export is still authorised; what is lost is the trail, and losing it
       * visibly is better than refusing the one tool that diagnoses the outage.
       * Logged with the user id, never an email (CLAUDE.md).
       */
      auditError = describe(error);
      this.logger.warn(
        `Support bundle exported WITHOUT an audit record (${auditError}); ` +
          `user id ${request.principal?.userId ?? 'unknown'}.`,
      );
    }

    const failures: Record<string, string> = {};
    const safely = async <T>(section: string, fallback: T, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        failures[section] = describe(error);
        return fallback;
      }
    };

    const emptyFacts: DatabaseFacts = {
      files: {},
      materializationFailed: 0,
      materializationPending: 0,
      auditDeliveryQueued: 0,
      newestProjectionAt: null,
    };

    const [
      logs,
      systemStatus,
      deployment,
      conditions,
      propagation,
      providers,
      database,
      audit,
      personal,
    ] = await Promise.all([
      collectLogs(this.options.logDirectory, from.toISOString(), generatedAt),
      safely('status/system-status.json', null, () => this.status.status(true)),
      safely('status/deployment.json', null, () => this.deployment.info()),
      safely<ConditionRow[]>('status/conditions.json', [], () => collectConditions(this.prisma)),
      safely('status/propagation.json', null, () => this.propagation.front()),
      safely('config/providers.json', null, () => collectProviders(this.prisma)),
      safely('database', emptyFacts, () => collectDatabase(this.prisma)),
      safely('audit/audit-log.jsonl', { rows: [], truncated: 0 }, () =>
        includePersonalData
          ? collectAuditWithPersonalData(this.prisma, from)
          : collectAudit(this.prisma, from),
      ),
      includePersonalData
        ? safely<Record<string, unknown>>('personal', {}, () =>
            collectPersonalData(this.prisma, now),
          )
        : Promise.resolve<Record<string, unknown>>({}),
    ]);

    const environment = environmentReport(this.options.environment, { includePersonalData });
    const failed = (name: string, value: unknown): unknown =>
      failures[name] === undefined ? value : { error: failures[name] };

    const json: Record<string, unknown> = {
      'status/system-status.json': failed('status/system-status.json', systemStatus),
      'status/deployment.json': failed('status/deployment.json', deployment),
      'status/conditions.json': failed('status/conditions.json', {
        note:
          'Every condition ever evaluated, open and resolved (ADR-0021). An open condition has ' +
          'openedAt set and resolvedAt null.',
        conditions,
      }),
      'status/propagation.json': failed('status/propagation.json', propagation),
      'status/log-level.json': this.logLevels.describe(),
      'config/environment.json': {
        note:
          'An allow-list. Secrets and identities appear only as set/unset; variables nobody ' +
          'classified are listed by name with their values withheld.',
        ...environment.report,
      },
      'config/providers.json': failed('config/providers.json', providers),
      ...database.files,
      ...(failures['database'] === undefined
        ? {}
        : { 'database/error.json': { error: failures['database'] } }),
      ...personal,
      ...(failures['personal'] === undefined
        ? {}
        : { 'personal/error.json': { error: failures['personal'] } }),
      'collection.json': {
        auditRecorded: auditError === null,
        ...(auditError === null ? {} : { auditError }),
        sectionsFailed: failures,
      },
    };

    return buildBundle({
      generatedAt,
      hours,
      includesPersonalData: includePersonalData,
      api: {
        host: this.options.host,
        version: this.options.version,
        nodeVersion: process.version,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
      },
      logs: {
        directory: this.options.logDirectory,
        sink: this.sink.state(),
        readError: logs.readError,
        hosts: logs.hosts,
      },
      signals: {
        conditions,
        materializationFailed: database.materializationFailed,
        materializationPending: database.materializationPending,
        auditDeliveryQueued: database.auditDeliveryQueued,
        newestProjectionAt: database.newestProjectionAt,
      },
      json,
      audit,
      secrets: environment.secrets,
    });
  }
}

function headerOf(request: AuthenticatedRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
