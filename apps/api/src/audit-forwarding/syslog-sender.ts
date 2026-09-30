import { createSocket } from 'node:dgram';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import type { AuditDeliveryEntry, SyslogSettings } from '@nexuspuppet/contracts';

/**
 * Delivers audit records to a syslog collector (RFC 5424, ADR-0016 §5).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — same contract as the webhook: no
 * retries, no backoff, no queue. Those belong to core's delivery worker. This
 * sends one batch and either returns or throws, and THROWING IS THE CONTRACT:
 * the worker treats a return as proof of delivery and clears the queue.
 *
 * What "proof" means varies by transport, and honestly so:
 *
 *   TCP/TLS  the batch was written, the connection was closed cleanly, and
 *            the peer acknowledged the close. Not "indexed", but as much as
 *            syslog offers without RELP.
 *   UDP      the kernel accepted the datagrams. Nothing more — which is why
 *            the product calls UDP "unconfirmable delivery" everywhere it is
 *            offered, and why choosing it is loud and deliberate.
 *
 * A connection per batch, not a pool. Audit volumes are one batch every
 * fifteen seconds at most; a held-open socket to a collector that
 * load-balances or restarts is a source of first-write failures, and the
 * reconnect logic to paper over that is complexity the volumes do not earn.
 */
export class SyslogSender {
  constructor(
    private readonly config: SyslogSettings,
    /** Injectable for tests; defaults to this host's name. */
    private readonly localHostname: string = hostname(),
  ) {}

  async send(entries: readonly AuditDeliveryEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const messages = entries.map((entry) => this.format(entry));

    if (this.config.protocol === 'udp') {
      await this.sendUdp(messages);
      return;
    }
    await this.sendStream(messages.map(frameOctetCounted).join(''));
  }

  /**
   * Reachability probe for the Test button: connect (and complete the TLS
   * handshake, where applicable), send ONE test record, close. The collector
   * receives a single, clearly-marked event — which is the point: "Test
   * succeeded" should be verifiable at the collector end too.
   */
  async probe(): Promise<{ label: string; value: string }[]> {
    const test = this.format({
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
    });

    if (this.config.protocol === 'udp') {
      await this.sendUdp([test]);
      return [
        { label: 'sent', value: `1 datagram to ${this.config.host}:${this.config.port}` },
        { label: 'caveat', value: 'UDP is unconfirmable — receipt cannot be verified from here' },
      ];
    }

    await this.sendStream(frameOctetCounted(test));
    return [
      {
        label: 'connected',
        value: `${this.config.protocol === 'tls' ? 'TLS' : 'TCP'} to ${this.config.host}:${this.config.port}`,
      },
      { label: 'sent', value: '1 test record, connection closed cleanly' },
    ];
  }

  /**
   * RFC 5424: `<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG`.
   *
   * The record itself travels as JSON in MSG — collectors index JSON natively,
   * and flattening the before/after into structured-data elements would
   * mangle the one part an investigator actually reads.
   */
  format(entry: AuditDeliveryEntry): string {
    // Severity 5 (notice): normal but significant. These are records of
    // deliberate administrative action, not debug chatter and not errors.
    const pri = this.config.facility * 8 + 5;
    const header = [
      `<${pri}>1`,
      entry.createdAt,
      safeToken(this.localHostname),
      safeToken(this.config.appName),
      String(process.pid),
      safeToken(entry.action).slice(0, 32),
      '-',
    ].join(' ');

    return `${header} ${JSON.stringify(entry)}`;
  }

  private sendStream(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket: Socket =
        this.config.protocol === 'tls'
          ? tlsConnect({
              host: this.config.host,
              port: this.config.port,
              rejectUnauthorized: this.config.tlsRejectUnauthorized,
              ...(this.config.caCert === undefined ? {} : { ca: this.config.caCert }),
              ...(this.config.clientCert === undefined ? {} : { cert: this.config.clientCert }),
              ...(this.config.clientKey === undefined ? {} : { key: this.config.clientKey }),
            })
          : netConnect({ host: this.config.host, port: this.config.port });

      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      /*
       * The per-batch budget (ADR-0016 §5, resolved question 5). This is an
       * IDLE timeout, so it covers every stalled phase — a connect that hangs,
       * TCP backpressure from a collector that accepts but does not drain, and
       * a peer that never acknowledges the close. On expiry the batch fails
       * back to the outbox's retry schedule; the worker is never stalled.
       */
      socket.setTimeout(this.config.timeoutMs, () => {
        fail(
          new Error(
            `syslog collector ${this.config.host}:${this.config.port} stalled for ` +
              `${this.config.timeoutMs}ms — batch returned to the queue`,
          ),
        );
      });

      socket.on('error', (error) => fail(new Error(`syslog delivery failed: ${error.message}`)));

      socket.on('close', (hadError) => {
        if (settled) return;
        settled = true;
        if (hadError) reject(new Error('syslog connection closed with an error'));
        else resolve();
      });

      // For TLS, wait for the handshake; writing earlier would buffer into an
      // unauthenticated connection.
      const ready = this.config.protocol === 'tls' ? 'secureConnect' : 'connect';
      socket.on(ready, () => {
        socket.end(payload);
      });
    });
  }

  private async sendUdp(messages: readonly string[]): Promise<void> {
    const socket = createSocket('udp4');
    try {
      for (const message of messages) {
        await new Promise<void>((resolve, reject) => {
          socket.send(message, this.config.port, this.config.host, (error) => {
            if (error) reject(new Error(`syslog datagram failed: ${error.message}`));
            else resolve();
          });
        });
      }
    } finally {
      socket.close();
    }
  }
}

/**
 * RFC 6587 octet-counting: `LEN SP MSG`. The framing every serious collector
 * supports, and the only one that survives a message containing a newline.
 */
export function frameOctetCounted(message: string): string {
  return `${Buffer.byteLength(message, 'utf8')} ${message}`;
}

/**
 * RFC 5424 header fields are space-delimited PRINTUSASCII. A hostname or
 * action containing a space would shift every field after it; anything
 * outside the safe range is replaced rather than trusted.
 */
function safeToken(value: string): string {
  const cleaned = value.replace(/[^\x21-\x7e]/g, '_');
  return cleaned.length === 0 ? '-' : cleaned;
}
