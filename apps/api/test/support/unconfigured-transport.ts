import type { IAuditTransport } from '@nexuspuppet/contracts';

/**
 * A transport with nowhere to send: forwarding switched off.
 *
 * A test double. The running API always binds the settings-driven transport
 * (ADR-0027); this stands in for it in the state where nothing is configured,
 * which is the state the worker and the status surface must handle quietly.
 *
 * `deliver` throws rather than returning quietly. Nothing should call it, and
 * if something does, a loud failure that leaves the record queued is much
 * better than a silent success that deletes it.
 */
export class UnconfiguredAuditTransport implements IAuditTransport {
  readonly name = 'none';
  readonly configured = false;

  async deliver(): Promise<void> {
    throw new Error('No audit transport is configured; the record must stay queued.');
  }
}
