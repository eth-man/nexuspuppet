import { createServer, type Server } from 'node:http';
import type { AuditRecord, IAuditDeliveryOutbox, IAuditSink } from '@nexuspuppet/contracts';
import { auditExportConfigFromEnv } from '../src/audit/config';
import { ForwardingAuditSink } from '../src/audit/forwarding-audit-sink';
import { WebhookAuditTransport } from '../src/audit/webhook-transport';

/**
 * Audit export: configuration, the composing sink, and the transport.
 *
 * The property the whole feature rests on: **the local audit trail is written
 * first and unconditionally, and forwarding is an addition to it rather than a
 * replacement.** An estate must not lose its record of last resort by gaining a
 * SIEM, and it must not be told a record was delivered when it was not.
 */

const entry = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  actorUserId: '00000000-0000-0000-0000-0000000000aa',
  actorEmail: 'ops@example.com',
  action: 'nodegroup.create',
  entityType: 'NodeGroup',
  entityId: '11111111-1111-1111-1111-111111111111',
  before: null,
  after: { name: 'web-tier' },
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
  ...over,
});

describe('auditExportConfigFromEnv', () => {
  it('returns null when export is not configured', () => {
    // An estate may install this layer for LDAP alone. Absence is valid.
    expect(auditExportConfigFromEnv({})).toBeNull();
    expect(auditExportConfigFromEnv({ AUDIT_EXPORT_URL: '   ' })).toBeNull();
  });

  it('accepts an https collector', () => {
    const config = auditExportConfigFromEnv({ AUDIT_EXPORT_URL: 'https://siem.example.com/hec' });
    expect(config?.url).toBe('https://siem.example.com/hec');
    expect(config?.timeoutMs).toBe(15_000);
    expect(config?.entityTypes).toEqual([]);
  });

  /**
   * Audit records carry actor identities, IP addresses and the before/after of
   * every change. Shipping that in clear would leak the estate's entire change
   * history to anything on the path.
   */
  it('refuses a plaintext collector on the network', () => {
    expect(() =>
      auditExportConfigFromEnv({ AUDIT_EXPORT_URL: 'http://siem.example.com/hec' }),
    ).toThrow(/must be a valid https/i);
  });

  /** A sidecar on loopback is a different risk, and a common deployment. */
  it('permits plaintext to a collector on localhost', () => {
    expect(
      auditExportConfigFromEnv({ AUDIT_EXPORT_URL: 'http://localhost:8088/services/collector' }),
    ).not.toBeNull();
    expect(
      auditExportConfigFromEnv({ AUDIT_EXPORT_URL: 'http://127.0.0.1:8088/x' }),
    ).not.toBeNull();
  });

  it('rejects a malformed URL rather than starting without export', () => {
    expect(() => auditExportConfigFromEnv({ AUDIT_EXPORT_URL: 'not-a-url' })).toThrow(
      /Invalid audit export configuration/,
    );
  });

  it('parses the optional settings', () => {
    const config = auditExportConfigFromEnv({
      AUDIT_EXPORT_URL: 'https://siem.example.com/hec',
      AUDIT_EXPORT_TOKEN: 'secret-token',
      AUDIT_EXPORT_TIMEOUT_MS: '5000',
      AUDIT_EXPORT_ENTITY_TYPES: 'NodeGroup, User ,,',
    });
    expect(config?.token).toBe('secret-token');
    expect(config?.timeoutMs).toBe(5_000);
    expect(config?.entityTypes).toEqual(['NodeGroup', 'User']);
  });

  it('bounds the timeout, so a hung collector cannot stall delivery forever', () => {
    expect(() =>
      auditExportConfigFromEnv({
        AUDIT_EXPORT_URL: 'https://siem.example.com/hec',
        AUDIT_EXPORT_TIMEOUT_MS: '999999',
      }),
    ).toThrow(/Invalid audit export configuration/);
  });
});

describe('ForwardingAuditSink', () => {
  class FakeCore implements IAuditSink {
    calls: Array<{ entry: AuditRecord; hadTx: boolean }> = [];
    async record(e: AuditRecord, tx?: object): Promise<string> {
      this.calls.push({ entry: e, hadTx: tx !== undefined });
      return `audit-${this.calls.length}`;
    }
  }

  class FakeOutbox implements IAuditDeliveryOutbox {
    queued: Array<{ id: string; hadTx: boolean }> = [];
    async enqueue(tx: object, auditLogId: string): Promise<void> {
      this.queued.push({ id: auditLogId, hadTx: tx !== undefined });
    }
  }

  const config = (entityTypes: string[] = []) => ({
    url: 'https://siem.example.com/hec',
    timeoutMs: 15_000,
    entityTypes,
  });

  const tx = { transaction: true };

  it('writes the local record first, then queues it', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();
    const sink = new ForwardingAuditSink(core, outbox, config());

    const id = await sink.record(entry(), tx);

    expect(core.calls).toHaveLength(1);
    expect(outbox.queued).toEqual([{ id: 'audit-1', hadTx: true }]);
    // The id comes from the delegate: the wrapper must not invent one, or the
    // delivery job would reference a record that does not exist.
    expect(id).toBe('audit-1');
  });

  /**
   * The gate that keeps "forwarding off" from quietly filling the audit table:
   * pending delivery jobs are exempt from age-based retention (ADR-0016 §6),
   * so enqueueing while nothing can drain would grow the table without bound.
   */
  it('records locally but queues NOTHING while forwarding cannot send', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();
    const sink = new ForwardingAuditSink(core, outbox, null, () => false);

    const id = await sink.record(entry(), tx);

    expect(id).toBe('audit-1');
    expect(core.calls).toHaveLength(1);
    expect(outbox.queued).toEqual([]);
  });

  it('starts queueing the moment forwarding becomes active, no restart', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();
    let active = false;
    const sink = new ForwardingAuditSink(core, outbox, null, () => active);

    await sink.record(entry(), tx);
    active = true;
    await sink.record(entry(), tx);

    expect(outbox.queued).toEqual([{ id: 'audit-2', hadTx: true }]);
  });

  /**
   * The transaction has to reach BOTH, or the guarantee is half-kept: a record
   * that commits with a delivery obligation that does not, or the reverse.
   */
  it('passes the transaction through to both', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();

    await new ForwardingAuditSink(core, outbox, config()).record(entry(), tx);

    expect(core.calls[0]?.hadTx).toBe(true);
    expect(outbox.queued[0]?.hadTx).toBe(true);
  });

  /**
   * The property that matters most. Forwarding is an addition to the local
   * trail, never a substitute — an estate must not lose its record of last
   * resort because a filter excluded an entity type.
   */
  it('still writes locally for a record it will not forward', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();
    const sink = new ForwardingAuditSink(core, outbox, config(['User']));

    await sink.record(entry({ entityType: 'NodeGroup' }), tx);

    expect(core.calls).toHaveLength(1);
    expect(outbox.queued).toHaveLength(0);
  });

  it('forwards a record whose entity type is selected', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();
    const sink = new ForwardingAuditSink(core, outbox, config(['User', 'NodeGroup']));

    await sink.record(entry({ entityType: 'User' }), tx);

    expect(outbox.queued).toHaveLength(1);
  });

  /** An operator who configures no filter gets everything, not nothing. */
  it('forwards everything when no filter is configured', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();
    const sink = new ForwardingAuditSink(core, outbox, config([]));

    await sink.record(entry({ entityType: 'Anything' }), tx);

    expect(outbox.queued).toHaveLength(1);
  });

  /**
   * Without a transaction there is no atomicity between the record and its
   * delivery obligation. Storing locally and declining to forward is the safe
   * half; failing the audit write to protect a forwarding preference would be
   * exactly the wrong trade.
   */
  it('records but does not queue when there is no transaction', async () => {
    const core = new FakeCore();
    const outbox = new FakeOutbox();

    const id = await new ForwardingAuditSink(core, outbox, config()).record(entry());

    expect(core.calls).toHaveLength(1);
    expect(outbox.queued).toHaveLength(0);
    expect(id).toBe('audit-1');
  });
});

describe('WebhookAuditTransport', () => {
  let server: Server;
  let received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }>;
  let respond: { status: number; body: string; delayMs: number };
  let url: string;

  beforeAll(async () => {
    received = [];
    respond = { status: 200, body: 'ok', delayMs: 0 };

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, headers: req.headers });
        const send = () => {
          res.writeHead(respond.status, { 'content-type': 'text/plain' });
          res.end(respond.body);
        };
        if (respond.delayMs > 0) setTimeout(send, respond.delayMs);
        else send();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}/collector`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
    respond = { status: 200, body: 'ok', delayMs: 0 };
  });

  const transport = (over: Record<string, unknown> = {}) =>
    new WebhookAuditTransport({ url, timeoutMs: 2_000, entityTypes: [], ...over } as never);

  const delivery = (id: string) => ({
    auditLogId: id,
    actorUserId: null,
    actorEmail: 'ops@example.com',
    action: 'nodegroup.create',
    entityType: 'NodeGroup',
    entityId: 'g1',
    before: null,
    after: { name: 'web-tier' },
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
    createdAt: '2026-07-29T00:00:00.000Z',
  });

  it('posts a batch as newline-delimited JSON', async () => {
    await transport().deliver([delivery('a'), delivery('b')]);

    expect(received).toHaveLength(1);
    const lines = received[0]!.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).auditLogId).toBe('a');
    expect(received[0]!.headers['content-type']).toBe('application/x-ndjson');
  });

  it('sends the bearer token when one is configured', async () => {
    await transport({ token: 'secret-token' }).deliver([delivery('a')]);

    expect(received[0]!.headers['authorization']).toBe('Bearer secret-token');
  });

  it('sends no authorization header when no token is configured', async () => {
    await transport().deliver([delivery('a')]);

    expect(received[0]!.headers['authorization']).toBeUndefined();
  });

  it('does not call the collector for an empty batch', async () => {
    await transport().deliver([]);

    expect(received).toHaveLength(0);
  });

  /**
   * Throwing IS the contract. The worker treats a return as proof of delivery
   * and removes the records from the queue, so any doubt must surface here.
   */
  it('throws on a server error, so the worker retries', async () => {
    respond = { status: 500, body: 'upstream unavailable', delayMs: 0 };

    await expect(transport().deliver([delivery('a')])).rejects.toThrow(/500/);
  });

  /**
   * Including 4xx. A collector rejecting a payload is a misconfiguration an
   * operator must see, not a reason to discard audit records.
   */
  it('throws on a rejected payload rather than discarding it', async () => {
    respond = { status: 400, body: 'bad request', delayMs: 0 };

    await expect(transport().deliver([delivery('a')])).rejects.toThrow(/400/);
  });

  it('includes the collector complaint, so the failure is diagnosable', async () => {
    respond = { status: 422, body: 'index "audit" does not exist', delayMs: 0 };

    await expect(transport().deliver([delivery('a')])).rejects.toThrow(
      /index "audit" does not exist/,
    );
  });

  /**
   * A collector that accepts a connection and never answers would otherwise
   * hold the delivery lease until it expired.
   */
  it('times out rather than hanging', async () => {
    respond = { status: 200, body: 'ok', delayMs: 3_000 };

    await expect(transport({ timeoutMs: 300 }).deliver([delivery('a')])).rejects.toThrow(
      /timed out/,
    );
  }, 10_000);

  /**
   * A failed delivery must not put actor identities or the before/after of a
   * change into a log file.
   */
  it('keeps the payload out of the error', async () => {
    respond = { status: 500, body: 'nope', delayMs: 0 };

    const error = await transport()
      .deliver([delivery('a')])
      .catch((e: Error) => e);

    expect(String(error)).not.toContain('ops@example.com');
    expect(String(error)).not.toContain('web-tier');
  });
});
