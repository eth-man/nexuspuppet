import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { NotificationEmailSettings, NotificationPayload } from '@nexuspuppet/contracts';
import type { DeliveryOutcome } from './notification-webhook.transport';

/**
 * Sends an operational condition as plain-text mail (ADR-0021 §4).
 *
 * DELIBERATELY BASIC: plain text, standard relay auth, no templating engine,
 * no HTML. Email is a large surface and this is the small useful part of it —
 * every addition here is one we own during somebody else's mail outage.
 *
 * `nodemailer` has zero dependencies and needs no build toolchain, which is
 * the same constraint that put scrypt in ADR-0006: an on-prem operator may
 * have no compiler.
 *
 * WHAT "DELIVERED" MEANS HERE, stated because it is not what it sounds like.
 * A relay accepting a message is not the message arriving. It can be queued,
 * greylisted, or bounced minutes later to an address nobody reads, and none of
 * that reaches this process. So success means THE RELAY ACCEPTED IT, and the
 * console says exactly that.
 *
 * This is the same honesty ADR-0016 applies to syslog over UDP, which the
 * product labels "unconfirmable delivery" wherever it appears. Tracking
 * bounces would mean owning an inbox and parsing DSNs — a mail subsystem, for
 * a channel whose whole justification was that estates already have a relay.
 */
export class NotificationEmailTransport {
  private readonly logger = new Logger(NotificationEmailTransport.name);

  async deliver(
    settings: NotificationEmailSettings,
    payload: NotificationPayload,
  ): Promise<DeliveryOutcome> {
    try {
      const transport = createTransport({
        host: settings.host,
        port: settings.port,
        // `secure` is implicit TLS from the first byte (465). STARTTLS on 587
        // is `secure: false` plus `requireTLS`, which is a different thing
        // wearing a confusingly similar name.
        secure: settings.encryption === 'tls',
        ...(settings.encryption === 'starttls' ? { requireTLS: true } : {}),
        /*
         * `none` MUST MEAN NONE.
         *
         * Without ignoreTLS, nodemailer upgrades opportunistically whenever the
         * relay advertises STARTTLS — so an operator who deliberately chose no
         * encryption still got a TLS handshake, and a plaintext internal relay
         * with a self-signed certificate failed with `self-signed certificate`.
         * A setting that does not do what it says sends people hunting for a
         * fault in their relay.
         *
         * Reported from a real deployment against a port-25 relay.
         */
        ...(settings.encryption === 'none' ? { ignoreTLS: true } : {}),
        ...(settings.username === undefined
          ? {}
          : { auth: { user: settings.username, pass: settings.password ?? '' } }),
        connectionTimeout: settings.timeoutMs,
        greetingTimeout: settings.timeoutMs,
        socketTimeout: settings.timeoutMs,
        // A relay with a self-signed certificate is common on-prem, and
        // refusing it outright would push operators to `encryption: none`,
        // which is worse. Opting out is explicit and per-deployment.
        ...(settings.rejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
      });

      await transport.sendMail({
        from: settings.from,
        to: settings.to,
        subject: subjectFor(payload),
        text: bodyFor(payload),
      });

      transport.close();
      return { ok: true, error: null };
    } catch (error: unknown) {
      /*
       * The password must not reach a log line or the operator's screen.
       * nodemailer's error messages carry the host and the SMTP response, not
       * the credentials, so taking `message` alone is safe — and taking the
       * whole error object would not be.
       */
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Notification mail failed: ${message}`);
      return { ok: false, error: message };
    }
  }
}

/**
 * `[NexusPuppet] OPENED: PuppetDB is not answering`
 *
 * The transition leads, because somebody scanning a mailbox at 3am is sorting
 * "what broke" from "what recovered" before reading anything else.
 */
function subjectFor(payload: NotificationPayload): string {
  const verb = payload.transition === 'opened' ? 'OPENED' : 'RESOLVED';
  return `[NexusPuppet] ${verb}: ${payload.summary}`;
}

/**
 * Plain text, and no more of it than is useful.
 *
 * Carries conditions only — no person, no action, nothing from AuditLog
 * (ADR-0021 binding constraint 1).
 */
function bodyFor(payload: NotificationPayload): string {
  return [
    payload.summary,
    '',
    `Condition: ${payload.key}`,
    `Severity:  ${payload.severity}`,
    `State:     ${payload.transition}`,
    `At:        ${payload.at}`,
    '',
    'Sent by NexusPuppet because this deployment detected an operational',
    'condition. It describes the deployment, not any person or change.',
  ].join('\n');
}
