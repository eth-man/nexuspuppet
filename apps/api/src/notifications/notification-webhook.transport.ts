import { Logger } from '@nestjs/common';
import { request } from 'undici';
import type { NotificationPayload, NotificationWebhookSettings } from '@nexuspuppet/contracts';

/**
 * POSTs an operational condition to the operator's endpoint (ADR-0021 §4).
 *
 * SEPARATE FROM THE AUDIT WEBHOOK, and that is the design rather than
 * duplication. The audit transport exists under `audit.export` and carries
 * audit records; this is core and carries conditions. Routing notifications
 * through the enterprise-gated component would either break core or perforate
 * the capability — keeping them apart makes ADR-0021 §1 something the
 * transports enforce rather than something a reviewer has to remember.
 */

export interface DeliveryOutcome {
  ok: boolean;
  /** For the operator. Never contains the token. */
  error: string | null;
}

export class NotificationWebhookTransport {
  private readonly logger = new Logger(NotificationWebhookTransport.name);

  async deliver(
    settings: NotificationWebhookSettings,
    payload: NotificationPayload,
  ): Promise<DeliveryOutcome> {
    try {
      const response = await request(settings.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(settings.token === undefined ? {} : { authorization: `Bearer ${settings.token}` }),
        },
        body: JSON.stringify(payload),
        headersTimeout: settings.timeoutMs,
        bodyTimeout: settings.timeoutMs,
      });

      // Any 2xx is accepted. Collectors answer 200, 201, 202 and 204 with
      // equal enthusiasm, and insisting on one of them would fail against
      // half the endpoints an operator already runs.
      if (response.statusCode >= 200 && response.statusCode < 300) {
        // The body is drained rather than read: undici keeps the connection
        // open until it is consumed, and nothing here needs its contents.
        await response.body.dump();
        return { ok: true, error: null };
      }

      await response.body.dump();
      return { ok: false, error: `The endpoint answered ${String(response.statusCode)}.` };
    } catch (error: unknown) {
      /*
       * Never log or return the token. `describe` takes the message only, and
       * an undici error message carries the URL but not the headers — so the
       * bearer cannot reach a log line, an operator's screen, or a support
       * bundle through this path.
       */
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Notification delivery failed: ${message}`);
      return { ok: false, error: message };
    }
  }
}
