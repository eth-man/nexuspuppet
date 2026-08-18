import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_SINK, type IAuditSink, type ResourceFilter } from '@nexuspuppet/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';

/**
 * Audit rows for READS that disclose configuration payloads (ADR-0025 §6).
 *
 * A NEW CATEGORY, and the reason it exists: `resources:read` grants effective
 * read of managed file contents and of credentials passed as class parameters
 * — including by oracle, since filtering on a parameter value confirms it
 * without rendering it. A powerful read permission with no trail is a policy
 * with no evidence behind it: "senior operators and auditors only" is
 * unenforceable and unprovable unless somebody can afterwards ask WHO LOOKED
 * AT WHAT, AND WHEN.
 *
 * WHAT IS RECORDED:
 *   - expanding a resource's parameters
 *   - any search that filters on a parameter VALUE
 *
 * WHAT IS NOT:
 *   - ordinary browsing: searching by type and title, and reading the list.
 *     That discloses no values, and recording it would bury the events that
 *     matter under thousands that do not. An audit trail nobody can read is
 *     the same as none.
 *
 * SHAPE. This does not and cannot take ADR-0005 §2's form — there is no domain
 * change and no outbox job, so `before` and `after` are both null and there is
 * no transaction to join. The identifying detail lives in `entityId` and
 * `entityLabel` instead.
 *
 * NO PARAMETER VALUE IS EVER WRITTEN INTO THE ROW. Recording what was read
 * would copy the estate's secrets into the audit log and then forward them to
 * a SIEM — turning the control into a second, wider copy of the thing it
 * exists to protect. The row records the QUESTION, never the answer.
 */

/** `entityLabel` is VarChar(200); truncate visibly rather than let the write fail. */
const MAX_LABEL = 200;

function label(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

@Injectable()
export class ResourceReadAudit {
  constructor(@Inject(AUDIT_SINK) private readonly audit: IAuditSink) {}

  /**
   * Somebody expanded a resource and read its parameters.
   *
   * The certnames are recorded because reading one node's `sshd_config` and
   * reading forty are different events, and a trail that cannot tell them
   * apart answers no useful question during an incident.
   */
  async parametersRead(
    request: AuthenticatedRequest,
    type: string,
    title: string,
    certnames: readonly string[],
  ): Promise<void> {
    await this.record(
      request,
      'resource.parameters.read',
      `${type}[${title}]`,
      label(certnames.join(', ')),
    );
  }

  /**
   * Somebody searched by parameter VALUE — the oracle (§5).
   *
   * The conditions are recorded, including the value tested, and that is
   * deliberate: "they queried `parameters.password = hunter2` eleven times"
   * is precisely the sequence this trail exists to make visible afterwards.
   * The value is the operator's own guess, not something read out of a
   * catalog.
   */
  async parameterQuery(request: AuthenticatedRequest, filter: ResourceFilter): Promise<void> {
    const conditions = (filter.parameters ?? [])
      .map((c) => `${c.path} ${c.operator} ${c.value === undefined ? '' : String(c.value)}`.trim())
      .join('; ');

    await this.record(request, 'resource.parameters.query', filter.type, label(conditions));
  }

  private async record(
    request: AuthenticatedRequest,
    action: string,
    entityId: string,
    entityLabel: string,
  ): Promise<void> {
    const principal = request.principal;

    await this.audit.record({
      actorUserId: principal?.userId ?? null,
      actorEmail: principal?.email ?? null,
      action,
      entityType: 'Resource',
      entityId,
      // Both null: a read changes nothing, so there is no before and no after.
      // This is the carve-out ADR-0005 was amended for.
      before: null,
      after: null,
      ipAddress: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      // Supplied explicitly, because it cannot be derived: `auditLabel` reads
      // the before/after payloads, and both are null here by design.
      entityLabel,
    });
  }
}
