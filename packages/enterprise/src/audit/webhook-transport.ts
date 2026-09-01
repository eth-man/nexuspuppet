import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AuditDeliveryEntry, IAuditTransport } from '@nexuspuppet/contracts';
import type { AuditExportConfig } from './config';

/**
 * Delivers audit records to an HTTP collector — a SIEM's HTTP event collector,
 * a log shipper, or anything that accepts JSON.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * No retries, no backoff, no queue. Those belong to core's delivery worker, and
 * a transport that reimplemented them would be a second retry policy quietly
 * disagreeing with the first. This sends one batch and either returns or
 * throws.
 *
 * THROWING IS THE CONTRACT. The worker treats a return as proof of delivery and
 * removes the records from the queue, so any doubt must surface as an
 * exception. A collector that answers 500 has not accepted anything.
 */
export class WebhookAuditTransport implements IAuditTransport {
  readonly name = 'webhook';
  readonly configured = true;

  private readonly agent: Agent | undefined;
  private readonly target: URL;

  constructor(private readonly config: AuditExportConfig) {
    this.target = new URL(config.url);

    // An internal CA, loaded ONCE at construction. Reading it per request would
    // turn a delivery into a filesystem dependency, and a transient read error
    // into a lost batch.
    this.agent =
      config.caPath === undefined
        ? undefined
        : new Agent({ ca: readFileSync(config.caPath), keepAlive: true });
  }

  async deliver(entries: readonly AuditDeliveryEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Newline-delimited JSON: what Splunk HEC, Loki and most collectors expect
    // for a batch, and what lets a collector process records one at a time
    // rather than buffering the whole body.
    const body = entries.map((e) => JSON.stringify(e)).join('\n');

    const { statusCode, snippet } = await this.post(body);

    // 2xx is acceptance. Everything else is a failure the worker must retry —
    // including 4xx, because a collector rejecting a payload is a
    // misconfiguration an operator has to see rather than a reason to discard
    // audit records.
    if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `audit collector answered ${statusCode ?? 'no status'}` +
          (snippet.length > 0 ? `: ${snippet}` : ''),
      );
    }
  }

  private post(body: string): Promise<{ statusCode: number | undefined; snippet: string }> {
    const isHttps = this.target.protocol === 'https:';
    const send = isHttps ? request : httpRequest;

    const headers: Record<string, string> = {
      'content-type': 'application/x-ndjson',
      'content-length': String(Buffer.byteLength(body)),
      'user-agent': 'nexuspuppet-audit-export',
    };
    // Set here rather than stored on the instance so it is never enumerable on
    // an object that might end up in a log line or a crash dump.
    if (this.config.token !== undefined) {
      headers['authorization'] = `Bearer ${this.config.token}`;
    }

    return new Promise((resolve, reject) => {
      const req = send(
        this.target,
        {
          method: 'POST',
          headers,
          ...(isHttps && this.agent !== undefined ? { agent: this.agent } : {}),
          timeout: this.config.timeoutMs,
        },
        (res) => {
          // The response body is read and bounded rather than ignored: an
          // operator needs the collector's complaint to fix a rejected payload,
          // and an unbounded read is a memory risk from a hostile endpoint.
          let received = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (received.length < 500) received += chunk;
          });
          res.on('end', () =>
            resolve({ statusCode: res.statusCode, snippet: received.slice(0, 300).trim() }),
          );
        },
      );

      req.on('timeout', () => {
        // `timeout` does not abort the request by itself; without this the
        // promise never settles and the delivery lease expires instead.
        req.destroy(new Error(`timed out after ${this.config.timeoutMs}ms`));
      });
      // The payload is NOT included in the error. It contains actor identities
      // and the before/after of every change, and a failed delivery must not
      // put that in a log file.
      req.on('error', (error) => reject(error));

      req.end(body);
    });
  }
}
