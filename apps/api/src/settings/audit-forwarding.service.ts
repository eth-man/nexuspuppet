import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_SINK,
  AUDIT_TRANSPORT,
  auditForwardingSelectionSchema,
  syslogSettingsSchema,
  webhookSettingsSchema,
  type AuditForwardingSelection,
  type AuditForwardingState,
  type AuditForwardingView,
  type AuditTransportKind,
  type IAuditForwardingSettings,
  type IAuditSink,
  type IAuditTransport,
  type ProviderVerification,
  type SettingsView,
  type SyslogSettings,
  type WebhookSettings,
} from '@nexuspuppet/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { AUDIT_SECRET_FIELDS, auditEnvBaseline } from './provider-baseline';
import { SettingsStore, type SettingKind } from './settings.store';

const SETTING_KIND: Record<AuditTransportKind, SettingKind> = {
  syslog: 'audit.syslog',
  webhook: 'audit.webhook',
};

type ActiveChoice = AuditForwardingSelection['active'];

/**
 * Audit forwarding configuration (ADR-0016 §5).
 *
 * Two rules this service exists to hold:
 *
 * 1. **One transport active at a time.** The choice is a single stored value
 *    under `audit.forwarding`, not a pair of flags that could disagree —
 *    switching is one write, and there is no state where both deliver.
 * 2. **Saving is not switching.** Saving a configuration never changes which
 *    transport delivers; activation is its own explicit, audited act. An
 *    operator preparing a syslog config must not silently stop the webhook.
 */
@Injectable()
export class AuditForwardingService implements IAuditForwardingSettings {
  private readonly logger = new Logger(AuditForwardingService.name);

  constructor(
    private readonly store: SettingsStore,
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    @Inject(AUDIT_TRANSPORT) private readonly transport: IAuditTransport,
    /** Whether a real forwarding transport is registered, i.e. edits can act. */
    private readonly transportRegistered: () => boolean,
  ) {}

  async describe(): Promise<AuditForwardingView> {
    const [syslog, webhook, selection] = await Promise.all([
      this.describeKind<SyslogSettings>('syslog'),
      this.describeKind<WebhookSettings>('webhook'),
      this.storedSelection(),
    ]);

    return { syslog, webhook, active: selection ?? this.envActive() };
  }

  async save(
    kind: AuditTransportKind,
    config: SyslogSettings | WebhookSettings,
    request: AuthenticatedRequest,
  ): Promise<AuditForwardingView> {
    const actor = request.principal;
    const settingKind = SETTING_KIND[kind];
    const before = await this.describeKind(kind);

    await this.store.save(
      settingKind,
      config as unknown as Record<string, unknown>,
      AUDIT_SECRET_FIELDS[kind],
      actor?.email ?? 'unknown',
    );

    const after = await this.describeKind(kind);

    // Audited with the REDACTED views on both sides, like every settings
    // write: the trail records that the collector changed, never a token.
    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: `settings.audit.${kind}.update`,
      entityType: 'ProviderSetting',
      entityId: settingKind,
      before: before.config,
      after: after.config,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });

    return this.describe();
  }

  async clear(kind: AuditTransportKind, request: AuthenticatedRequest): Promise<void> {
    const selection = await this.storedSelection();
    if (selection === kind) {
      // Clearing the active transport's configuration would leave delivery
      // pointed at nothing — forwarding off with nobody having switched it off.
      throw new ConflictException({
        error: 'TRANSPORT_ACTIVE',
        message:
          `"${kind}" is the active transport. Switch forwarding to the other transport ` +
          'or to "none" before discarding its configuration.',
      });
    }

    const actor = request.principal;
    const before = await this.describeKind(kind);

    await this.store.clear(SETTING_KIND[kind]);

    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: `settings.audit.${kind}.clear`,
      entityType: 'ProviderSetting',
      entityId: SETTING_KIND[kind],
      before: before.config,
      after: null,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });
  }

  async setActive(active: ActiveChoice, request: AuthenticatedRequest): Promise<AuditForwardingView> {
    const actor = request.principal;

    if (active !== 'none') {
      const stored = await this.store.resolve(SETTING_KIND[active], () => null);
      if (stored.config === null) {
        throw new ConflictException({
          error: 'TRANSPORT_NOT_CONFIGURED',
          message: `Save a ${active} configuration before making it the active transport.`,
        });
      }
    }

    const before = (await this.storedSelection()) ?? this.envActive();

    await this.store.save('audit.forwarding', { active }, [], actor?.email ?? 'unknown');

    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: 'settings.audit.forwarding.update',
      entityType: 'ProviderSetting',
      entityId: 'audit.forwarding',
      before: { active: before },
      after: { active },
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });

    return this.describe();
  }

  /**
   * Test a candidate configuration. Deliberately NOT audited, for the same
   * reason LDAP tests are not: it changes nothing, and the save that follows
   * is the event worth recording.
   */
  async verify(
    kind: AuditTransportKind,
    candidate: SyslogSettings | WebhookSettings,
  ): Promise<ProviderVerification> {
    if (this.transport.verifyConfiguration === undefined) {
      return {
        ok: false,
        message: `The "${this.transport.name}" audit transport in this build cannot test a configuration.`,
      };
    }

    // A candidate arriving without its secret is tested with the STORED one —
    // otherwise "Test" fails for an operator who only changed the host, and
    // they learn nothing about the change they actually made.
    const withStoredSecrets = await this.fillSecrets(kind, candidate);

    try {
      return await this.transport.verifyConfiguration(kind, withStoredSecrets);
    } catch (error) {
      // A transport that throws is a bug in the transport, not an answer.
      this.logger.error(`Audit transport verification threw: ${describeError(error)}`);
      return { ok: false, message: 'The collector could not be reached. See the server log.' };
    }
  }

  /**
   * What the registered transport should do right now (IAuditForwardingSettings).
   *
   * Server-side only: the returned config INCLUDES secrets.
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

  private async describeKind<T>(kind: AuditTransportKind): Promise<SettingsView<T>> {
    const resolved = await this.store.describe<T>(
      SETTING_KIND[kind],
      () => auditEnvBaseline(this.transport, kind) as T | null,
    );

    return {
      source: resolved.source,
      config: resolved.config,
      disabled: resolved.disabled,
      secretsHeld: resolved.secretsHeld,
      updatedAt: resolved.updatedAt?.toISOString() ?? null,
      updatedByEmail: resolved.updatedByEmail,
      liveReload: this.transportRegistered(),
    };
  }

  /** The stored transport choice, or null when nothing usable is stored. */
  private async storedSelection(): Promise<ActiveChoice | null> {
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

  /**
   * What the environment made active, for the view when nothing is stored.
   *
   * Falls back to the transport's name when an older enterprise build cannot
   * report its configuration — a deployment that is visibly forwarding must
   * not render as "none".
   */
  private envActive(): ActiveChoice {
    if (!this.transport.configured) return 'none';

    let reported: { kind: AuditTransportKind; config: unknown } | null = null;
    try {
      reported = this.transport.currentConfiguration?.() ?? null;
    } catch {
      // The baseline helper already warned; the name fallback below still applies.
    }
    if (reported !== null) return reported.kind;

    const name = this.transport.name;
    return name === 'syslog' || name === 'webhook' ? name : 'none';
  }

  private async fillSecrets<T extends SyslogSettings | WebhookSettings>(
    kind: AuditTransportKind,
    candidate: T,
  ): Promise<T> {
    const asRecord = candidate as unknown as Record<string, unknown>;
    const missing = AUDIT_SECRET_FIELDS[kind].filter((field) => asRecord[field] === undefined);
    if (missing.length === 0) return candidate;

    const stored = await this.store.resolve<Record<string, unknown>>(
      SETTING_KIND[kind],
      () => null,
    );
    if (stored.config === null) return candidate;

    const filled: Record<string, unknown> = { ...asRecord };
    for (const field of missing) {
      const value = stored.config[field];
      if (value !== undefined) filled[field] = value;
    }
    return filled as unknown as T;
  }
}

function headerOf(request: AuthenticatedRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value.slice(0, 500) : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
