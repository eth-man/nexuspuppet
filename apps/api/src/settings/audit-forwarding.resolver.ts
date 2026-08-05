import { Injectable, Logger } from '@nestjs/common';
import {
  auditForwardingSelectionSchema,
  syslogSettingsSchema,
  webhookSettingsSchema,
  type AuditForwardingSelection,
  type AuditForwardingState,
  type AuditTransportKind,
  type IAuditForwardingSettings,
} from '@nexuspuppet/contracts';
import { SettingsStore, type SettingKind } from './settings.store';

const SETTING_KIND: Record<AuditTransportKind, SettingKind> = {
  syslog: 'audit.syslog',
  webhook: 'audit.webhook',
};

/**
 * What `AUDIT_FORWARDING_SETTINGS` binds to: stored state, nothing else.
 *
 * A separate class from AuditForwardingService, and the separation is
 * load-bearing rather than tidy. The service injects AUDIT_TRANSPORT (for the
 * Test button and the env baseline); the enterprise transport injects
 * AUDIT_FORWARDING_SETTINGS. Binding the token to the service closed that
 * loop — a circular dependency the injector deadlocks on, silently, and only
 * in enterprise deployments, because core's noop transport injects nothing.
 * Found on staging's first boot with the real transport; this resolver
 * depends on the store alone, so the transport's dependency chain terminates.
 */
@Injectable()
export class AuditForwardingResolver implements IAuditForwardingSettings {
  private readonly logger = new Logger(AuditForwardingResolver.name);

  constructor(private readonly store: SettingsStore) {}

  /**
   * What the registered transport should do right now. Server-side only: the
   * returned config INCLUDES secrets — the transport authenticates with them.
   */
  async resolveActive(): Promise<AuditForwardingState> {
    const selection = await this.storedSelection();
    if (selection === null) return { state: 'unset' };
    if (selection === 'none') return { state: 'off' };

    const stored = await this.store.resolve<Record<string, unknown>>(
      SETTING_KIND[selection],
      () => null,
    );

    if (selection === 'syslog') {
      const parsed = syslogSettingsSchema.safeParse(stored.config);
      if (parsed.success) return { state: 'syslog', config: parsed.data };
    } else {
      const parsed = webhookSettingsSchema.safeParse(stored.config);
      if (parsed.success) return { state: 'webhook', config: parsed.data };
    }

    // A selection pointing at a missing or unusable configuration forwards
    // nowhere. Loud, because records queue while this is true.
    this.logger.warn(
      `Audit forwarding is set to "${selection}" but no usable ${selection} configuration ` +
        'is stored. Forwarding is off until one is saved.',
    );
    return { state: 'off' };
  }

  /** The stored transport choice, or null when nothing usable is stored. */
  async storedSelection(): Promise<AuditForwardingSelection['active'] | null> {
    const resolved = await this.store.resolve<AuditForwardingSelection>(
      'audit.forwarding',
      () => null,
    );
    if (resolved.source !== 'database' || resolved.config === null) return null;

    const parsed = auditForwardingSelectionSchema.safeParse(resolved.config);
    if (!parsed.success) {
      this.logger.warn(
        'The stored audit.forwarding selection does not match its schema and was ignored.',
      );
      return null;
    }
    return parsed.data.active;
  }
}
