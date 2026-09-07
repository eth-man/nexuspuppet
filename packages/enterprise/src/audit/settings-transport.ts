import { Logger } from '@nestjs/common';
import {
  syslogSettingsSchema,
  webhookSettingsSchema,
  type AuditDeliveryEntry,
  type AuditForwardingState,
  type AuditTransportKind,
  type IAuditForwardingSettings,
  type IAuditTransport,
  type ProviderVerification,
  type SyslogSettings,
  type WebhookSettings,
} from '@nexuspuppet/contracts';
import type { AuditExportConfig } from './config';
import { SyslogSender } from './syslog-sender';
import { WebhookAuditTransport } from './webhook-transport';

/**
 * The transport core's delivery worker talks to (ADR-0016 §4, §5).
 *
 * ONE registered transport, TWO senders behind it, and the operator's stored
 * choice deciding which one runs — resolved through the AUDIT_FORWARDING_
 * SETTINGS seam ON EVERY DELIVERY, which is what makes reconfiguration live:
 * saving a collector change in the console affects the very next batch, no
 * restart, and this package still never touches the database (ADR-0002).
 *
 * The environment remains the bootstrap baseline (ADR-0016 §2): when nothing
 * was ever stored, a deployment configured with AUDIT_EXPORT_URL forwards via
 * the webhook exactly as it did before the settings surface existed. A stored
 * state — including the explicit "off" — wins over it.
 *
 * `configured` is a cached view, because the worker reads it synchronously
 * every tick while the truth lives a database read away. The cache refreshes
 * in the background once its TTL lapses; the DELIVERY path never trusts it —
 * deliver() resolves fresh state every time, so staleness can only delay a
 * drain by one tick, never send a batch to yesterday's collector.
 */
export class SettingsAuditTransport implements IAuditTransport {
  private readonly logger = new Logger(SettingsAuditTransport.name);

  private cachedState: AuditForwardingState | null = null;
  private cachedAt = 0;
  private refreshing = false;
  private warnedResolveFailure = false;

  /** Reused across batches so the webhook keeps its keep-alive agent. */
  private webhookSender: { key: string; sender: WebhookAuditTransport } | null = null;

  constructor(
    private readonly settings: IAuditForwardingSettings,
    /** The env-built webhook baseline, or null when the environment sets none. */
    private readonly envFallback: AuditExportConfig | null,
    private readonly cacheTtlMs: number = 5_000,
  ) {}

  get name(): string {
    const effective = this.effective(this.cachedState);
    return effective === null ? 'none' : effective.kind;
  }

  get configured(): boolean {
    this.refreshSoon();
    return this.effective(this.cachedState) !== null;
  }

  async deliver(entries: readonly AuditDeliveryEntry[]): Promise<void> {
    const state = await this.resolve();
    const effective = this.effective(state);

    if (effective === null) {
      // The worker checks `configured` before claiming, so arriving here means
      // forwarding was switched off mid-flight. Throwing returns the batch to
      // the queue, which is exactly where records belong while nothing sends.
      throw new Error('audit forwarding is switched off; the batch stays queued');
    }

    if (effective.kind === 'syslog') {
      await new SyslogSender(effective.syslog).send(entries);
      return;
    }
    await this.webhook(effective.webhook).deliver(entries);
  }

  /** The Test button (ADR-0016 §4): try a candidate without saving it. */
  async verifyConfiguration(
    kind: AuditTransportKind,
    candidate: unknown,
  ): Promise<ProviderVerification> {
    if (kind === 'syslog') {
      const parsed = syslogSettingsSchema.safeParse(candidate);
      if (!parsed.success) {
        return {
          ok: false,
          message: 'The candidate configuration is not a valid syslog configuration.',
        };
      }
      // An unreachable collector is an ANSWER to the question being asked,
      // not an exception. Thrown, it reaches the operator as "see the server
      // log" — but the host and port are values they just typed, and the
      // errno is precisely the actionable part.
      try {
        const details = await new SyslogSender(parsed.data).probe();
        return {
          ok: true,
          message:
            parsed.data.protocol === 'udp'
              ? 'A test datagram was sent. UDP cannot confirm the collector received it.'
              : 'Connected to the collector and delivered one test record.',
          details,
        };
      } catch (error) {
        return {
          ok: false,
          message: `The collector could not be reached: ${reason(error)}`,
        };
      }
    }

    const parsed = webhookSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        message: 'The candidate configuration is not a valid webhook configuration.',
      };
    }

    // A real POST with one clearly-marked record, because "the collector
    // answered 2xx to an actual delivery" is the question being asked. An
    // OPTIONS probe can pass against a collector that rejects every payload.
    try {
      await this.webhookFor(parsed.data).deliver([
        {
          auditLogId: 'test',
          actorUserId: null,
          actorEmail: null,
          action: 'nexuspuppet.test',
          entityType: 'Test',
          entityId: null,
          before: null,
          after: null,
          ipAddress: null,
          userAgent: null,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (error) {
      return {
        ok: false,
        message: `The collector did not accept a test record: ${reason(error)}`,
      };
    }
    return {
      ok: true,
      message: 'The collector accepted a test record.',
      details: [{ label: 'sent', value: '1 test record, answered 2xx' }],
    };
  }

  /** The environment baseline for the settings screen (ADR-0016 §2). No secrets. */
  currentConfiguration(): { kind: AuditTransportKind; config: unknown } | null {
    if (this.envFallback === null) return null;
    return {
      kind: 'webhook',
      config: { url: this.envFallback.url, timeoutMs: this.envFallback.timeoutMs },
    };
  }

  /** What the stored state plus the env baseline amount to, or null for "nothing sends". */
  private effective(
    state: AuditForwardingState | null,
  ):
    | { kind: 'syslog'; syslog: SyslogSettings }
    | { kind: 'webhook'; webhook: WebhookSettings | EnvWebhook }
    | null {
    if (state === null || state.state === 'unset') {
      // Nothing stored (or state unknown at boot): the environment governs.
      return this.envFallback === null
        ? null
        : { kind: 'webhook', webhook: { env: true } as EnvWebhook };
    }
    if (state.state === 'off') return null;
    if (state.state === 'syslog') return { kind: 'syslog', syslog: state.config };
    return { kind: 'webhook', webhook: state.config };
  }

  private webhook(config: WebhookSettings | EnvWebhook): WebhookAuditTransport {
    if (isEnvWebhook(config)) {
      if (this.envFallback === null) throw new Error('no environment webhook configuration');
      return this.webhookFor(this.envFallback);
    }
    return this.webhookFor({
      url: config.url,
      timeoutMs: config.timeoutMs,
      entityTypes: [],
      ...(config.token === undefined ? {} : { token: config.token }),
    });
  }

  private webhookFor(config: AuditExportConfig | WebhookSettings): WebhookAuditTransport {
    const full: AuditExportConfig =
      'entityTypes' in config
        ? (config as AuditExportConfig)
        : {
            url: config.url,
            timeoutMs: config.timeoutMs,
            entityTypes: [],
            ...(config.token === undefined ? {} : { token: config.token }),
          };

    // Keyed on what changes behaviour; a matching key reuses the keep-alive agent.
    const key = `${full.url}|${full.token ?? ''}|${full.timeoutMs}|${full.caPath ?? ''}`;
    if (this.webhookSender?.key !== key) {
      this.webhookSender = { key, sender: new WebhookAuditTransport(full) };
    }
    return this.webhookSender.sender;
  }

  private async resolve(): Promise<AuditForwardingState> {
    const state = await this.settings.resolveActive();
    this.cachedState = state;
    this.cachedAt = Date.now();
    this.warnedResolveFailure = false;
    return state;
  }

  private refreshSoon(): void {
    if (this.refreshing || Date.now() - this.cachedAt < this.cacheTtlMs) return;
    this.refreshing = true;
    void this.resolve()
      .catch((error: unknown) => {
        // A failed refresh keeps the previous view — and says so once, because
        // a transport silently frozen on stale state is how "I switched it
        // off" turns into an argument with a dashboard.
        if (!this.warnedResolveFailure) {
          this.warnedResolveFailure = true;
          this.logger.warn(
            `Could not refresh the forwarding state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .finally(() => {
        this.refreshing = false;
      });
  }
}

/** One line an operator can act on — the contract for verification messages. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Marker for "use the environment's webhook config, secrets and all". */
interface EnvWebhook {
  env: true;
}

function isEnvWebhook(value: WebhookSettings | EnvWebhook): value is EnvWebhook {
  return 'env' in value;
}
