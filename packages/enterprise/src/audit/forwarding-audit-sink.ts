import type {
  AuditRecord,
  AuditTransaction,
  IAuditDeliveryOutbox,
  IAuditSink,
} from '@nexuspuppet/contracts';
import type { AuditExportConfig } from './config';

/**
 * An audit sink that keeps the local trail and additionally forwards.
 *
 * COMPOSES, DOES NOT REPLACE. It delegates the Postgres write to core's sink
 * and then queues the record for delivery — both inside the transaction it was
 * given, so a change, its audit row and its delivery obligation commit together
 * or not at all (ADR-0005).
 *
 * Replacing the write was never an option, and the reason is worth stating: the
 * enterprise layer has no database access (ADR-0002), so it could not write the
 * row it was replacing. Even if it could, an estate must not lose its local
 * audit trail on the day it gains a SIEM. The trail is the record of last
 * resort; the SIEM is a copy.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No network calls. Nothing here can be slow, because it runs inside a database
 * transaction — an HTTP call in this method would hold a pooled connection and
 * its locks open for a network round trip, and a rollback would leave a SIEM
 * told about a change that never happened. Delivery is core's worker's job.
 */
export class ForwardingAuditSink implements IAuditSink {
  constructor(
    private readonly core: IAuditSink,
    private readonly outbox: IAuditDeliveryOutbox,
    /** The env forwarding policy, or null when only stored settings configure it. */
    private readonly config: AuditExportConfig | null,
    /**
     * Whether anything can currently send — the transport's cached view.
     *
     * The gate that keeps "forwarding off" from quietly filling the audit
     * table: a pending delivery job is exempt from age-based retention
     * (ADR-0016 §6), so enqueueing while nothing drains would grow the table
     * without bound. Records written while forwarding is off are LOCAL ONLY,
     * permanently — forwarding starts from activation, not from history, and
     * the retention window makes anything else a false promise anyway.
     *
     * Synchronous and cached because this runs inside the change's database
     * transaction, where a settings read per audit write would be a second
     * query held open by every classification change.
     */
    private readonly forwardingActive: () => boolean = () => true,
  ) {}

  async record(entry: AuditRecord, tx?: AuditTransaction): Promise<string> {
    // The local trail first, always, whatever the forwarding policy says.
    const auditLogId = await this.core.record(entry, tx);

    if (!this.forwardingActive()) return auditLogId;
    if (!this.shouldForward(entry)) return auditLogId;

    if (tx === undefined) {
      // No transaction means no atomicity between the record and its delivery
      // obligation. Core always supplies one for changes that matter; anything
      // that does not is not worth risking a half-written guarantee over, so it
      // is stored locally and not forwarded.
      //
      // Deliberately silent rather than throwing: failing an audit write to
      // protect a forwarding preference would be exactly the wrong trade.
      return auditLogId;
    }

    await this.outbox.enqueue(tx, auditLogId);
    return auditLogId;
  }

  /**
   * Forwarding policy, which belongs here rather than in core.
   *
   * Empty means everything — the safe default for a compliance feature, because
   * an operator who configures nothing gets a complete trail rather than a
   * silently filtered one.
   */
  private shouldForward(entry: AuditRecord): boolean {
    if (this.config === null || this.config.entityTypes.length === 0) return true;
    return this.config.entityTypes.includes(entry.entityType);
  }
}
