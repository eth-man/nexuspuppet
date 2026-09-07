import { createServer, type AddressInfo, type Server } from 'node:net';
import { Logger } from '@nestjs/common';
import type {
  AuditDeliveryEntry,
  AuditForwardingState,
  IAuditForwardingSettings,
} from '@nexuspuppet/contracts';
import { syslogSettingsSchema } from '@nexuspuppet/contracts';
import type { AuditExportConfig } from '../src/audit/config';
import { SettingsAuditTransport } from '../src/audit/settings-transport';

const ENTRY: AuditDeliveryEntry = {
  auditLogId: 'log-1',
  actorUserId: null,
  actorEmail: 'op@example.test',
  action: 'test.action',
  entityType: 'Test',
  entityId: null,
  before: null,
  after: null,
  ipAddress: null,
  userAgent: null,
  createdAt: '2026-08-05T10:00:00.000Z',
};

const ENV_WEBHOOK: AuditExportConfig = {
  url: 'https://collector.example.test/ingest',
  timeoutMs: 15_000,
  entityTypes: [],
};

function settingsAnswering(state: AuditForwardingState): IAuditForwardingSettings & {
  calls: number;
} {
  const holder = {
    calls: 0,
    async resolveActive(): Promise<AuditForwardingState> {
      holder.calls += 1;
      return state;
    },
  };
  return holder;
}

describe('SettingsAuditTransport', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('configured, the worker-facing view', () => {
    it('is false with nothing stored and no environment baseline', () => {
      const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), null);

      expect(transport.configured).toBe(false);
      expect(transport.name).toBe('none');
    });

    it('falls back to the environment webhook when nothing is stored', async () => {
      const transport = new SettingsAuditTransport(
        settingsAnswering({ state: 'unset' }),
        ENV_WEBHOOK,
      );

      // The baseline answers immediately — a deployment that forwarded via
      // AUDIT_EXPORT_URL yesterday must not report unconfigured at boot today.
      expect(transport.configured).toBe(true);
      expect(transport.name).toBe('webhook');
    });

    it('honours a stored OFF over an environment baseline once the cache warms', async () => {
      const settings = settingsAnswering({ state: 'off' });
      const transport = new SettingsAuditTransport(settings, ENV_WEBHOOK, 0);

      // `void` because the READ is the point: the getter kicks off the lazy
    // refresh as a side effect, and the value it returns now is the stale one.
    void transport.configured;
      await new Promise((resolve) => setImmediate(resolve));

      expect(transport.configured).toBe(false);
    });

    it('reflects a stored syslog configuration once the cache warms', async () => {
      const settings = settingsAnswering({
        state: 'syslog',
        config: syslogSettingsSchema.parse({ host: 'siem.example.test', port: 6514 }),
      });
      const transport = new SettingsAuditTransport(settings, null, 0);

      expect(transport.configured).toBe(false); // cold cache, no baseline
      await new Promise((resolve) => setImmediate(resolve));

      expect(transport.configured).toBe(true);
      expect(transport.name).toBe('syslog');
    });
  });

  describe('deliver', () => {
    let server: Server;
    let port: number;
    let received: Buffer[];

    beforeEach(async () => {
      received = [];
      server = createServer((socket) => {
        socket.on('data', (chunk) => received.push(chunk));
        socket.on('end', () => socket.end());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('resolves fresh state per delivery and sends via the stored syslog collector', async () => {
      const settings = settingsAnswering({
        state: 'syslog',
        config: syslogSettingsSchema.parse({ host: '127.0.0.1', port, protocol: 'tcp' }),
      });
      const transport = new SettingsAuditTransport(settings, ENV_WEBHOOK);

      await transport.deliver([ENTRY]);

      expect(settings.calls).toBeGreaterThanOrEqual(1);
      expect(Buffer.concat(received).toString('utf8')).toContain('test.action');
    });

    it('throws rather than sending when forwarding is switched off', async () => {
      const transport = new SettingsAuditTransport(
        settingsAnswering({ state: 'off' }),
        ENV_WEBHOOK,
      );

      // Throwing is the contract: the worker returns the batch to the queue,
      // which is where records belong while nothing sends.
      await expect(transport.deliver([ENTRY])).rejects.toThrow(/switched off/);
      expect(received).toHaveLength(0);
    });

    it('throws when nothing is stored and no baseline exists', async () => {
      const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), null);

      await expect(transport.deliver([ENTRY])).rejects.toThrow();
    });
  });

  describe('verifyConfiguration', () => {
    it('answers an invalid candidate as a failed test, not an exception', async () => {
      const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), null);

      const result = await transport.verifyConfiguration('syslog', { host: '' });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('not a valid syslog configuration');
    });

    it('reports an unreachable collector as a failed test with the reason', async () => {
      const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), null);

      const result = await transport.verifyConfiguration(
        'syslog',
        syslogSettingsSchema.parse({ host: '127.0.0.1', port: 1, protocol: 'tcp' }),
      );

      // The operator typed the host; the errno is the actionable part. This
      // must never surface as a thrown "see the server log".
      expect(result.ok).toBe(false);
      expect(result.message).toContain('could not be reached');
      expect(result.message).toContain('ECONNREFUSED');
    });

    it('probes a real collector and reports what it established', async () => {
      const server = createServer((socket) => {
        socket.on('data', () => undefined);
        socket.on('end', () => socket.end());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), null);
        const result = await transport.verifyConfiguration(
          'syslog',
          syslogSettingsSchema.parse({ host: '127.0.0.1', port, protocol: 'tcp' }),
        );

        expect(result.ok).toBe(true);
        expect(result.details?.map((d) => d.label)).toContain('connected');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('currentConfiguration, the settings-screen baseline', () => {
    it('reports the environment webhook without its token', () => {
      const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), {
        ...ENV_WEBHOOK,
        token: 'super-secret',
      });

      const reported = transport.currentConfiguration();

      expect(reported).toEqual({
        kind: 'webhook',
        config: { url: ENV_WEBHOOK.url, timeoutMs: ENV_WEBHOOK.timeoutMs },
      });
      expect(JSON.stringify(reported)).not.toContain('super-secret');
    });

    it('reports null when the environment configures nothing', () => {
      const transport = new SettingsAuditTransport(settingsAnswering({ state: 'unset' }), null);

      expect(transport.currentConfiguration()).toBeNull();
    });
  });
});
