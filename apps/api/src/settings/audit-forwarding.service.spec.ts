import { ConflictException, Logger } from '@nestjs/common';
import {
  syslogSettingsSchema,
  webhookSettingsSchema,
  type AuditRecord,
  type IAuditSink,
  type IAuditTransport,
  type SyslogSettings,
  type WebhookSettings,
} from '@nexuspuppet/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditForwardingResolver } from './audit-forwarding.resolver';
import { AuditForwardingService } from './audit-forwarding.service';
import { SettingsStore } from './settings.store';

/**
 * The REAL SettingsStore over an in-memory Prisma stand-in, not a fake store:
 * the precedence rules and the secret round-trip are exactly what this suite
 * exists to pin down, and a fake store would be testing the fake.
 */
interface Row {
  kind: string;
  config: object;
  secrets: Uint8Array | null;
  enabled: boolean;
  updatedAt: Date;
  updatedByEmail: string | null;
}

class FakePrisma {
  readonly rows = new Map<string, Row>();

  readonly providerSetting = {
    findUnique: async ({ where }: { where: { kind: string } }): Promise<Row | null> =>
      this.rows.get(where.kind) ?? null,

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { kind: string };
      create: { kind: string; config: object; secrets: Buffer | null; updatedByEmail: string };
      update: { config: object; secrets: Buffer | null; updatedByEmail: string };
    }): Promise<Row> => {
      const existing = this.rows.get(where.kind);
      const row: Row =
        existing === undefined
          ? {
              kind: create.kind,
              config: create.config,
              secrets: create.secrets,
              enabled: true,
              updatedAt: new Date('2026-08-05T00:00:00Z'),
              updatedByEmail: create.updatedByEmail,
            }
          : {
              ...existing,
              config: update.config,
              secrets: update.secrets,
              updatedAt: new Date('2026-08-05T00:00:01Z'),
              updatedByEmail: update.updatedByEmail,
            };
      this.rows.set(where.kind, row);
      return row;
    },

    update: async ({
      where,
      data,
    }: {
      where: { kind: string };
      data: Partial<Row>;
    }): Promise<Row> => {
      const existing = this.rows.get(where.kind);
      if (existing === undefined) throw new Error(`No row for ${where.kind}`);
      const row = { ...existing, ...data };
      this.rows.set(where.kind, row);
      return row;
    },

    deleteMany: async ({ where }: { where: { kind: string } }): Promise<{ count: number }> => ({
      count: this.rows.delete(where.kind) ? 1 : 0,
    }),
  };
}

class RecordingSink implements IAuditSink {
  readonly entries: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<string> {
    this.entries.push(entry);
    return `audit-${this.entries.length}`;
  }
}

const KEY = Buffer.alloc(32, 7).toString('base64');

const NOOP_TRANSPORT: IAuditTransport = {
  name: 'none',
  configured: false,
  deliver: async () => {
    throw new Error('never');
  },
};

const SYSLOG: SyslogSettings = syslogSettingsSchema.parse({
  host: 'siem.example.test',
  port: 6514,
  protocol: 'tls',
  clientKey: 'PEM-CLIENT-KEY',
});

const WEBHOOK: WebhookSettings = webhookSettingsSchema.parse({
  url: 'https://collector.example.test/ingest',
  token: 'collector-token',
});

const REQUEST = {
  principal: { userId: 'u-1', email: 'op@example.test' },
  ip: '10.0.0.9',
  headers: { 'user-agent': 'jest' },
} as unknown as AuthenticatedRequest;

function build(options?: {
  transport?: IAuditTransport;
  registered?: boolean;
  forcedSource?: 'db' | 'env';
  /** Reuse another build's rows — "same database, different boot flags". */
  prisma?: FakePrisma;
}): {
  service: AuditForwardingService;
  resolver: AuditForwardingResolver;
  sink: RecordingSink;
  prisma: FakePrisma;
} {
  const prisma = options?.prisma ?? new FakePrisma();
  const store = new SettingsStore(
    prisma as unknown as PrismaService,
    KEY,
    options?.forcedSource ?? 'db',
  );
  const sink = new RecordingSink();
  const resolver = new AuditForwardingResolver(store);
  const service = new AuditForwardingService(
    store,
    resolver,
    sink,
    options?.transport ?? NOOP_TRANSPORT,
    () => options?.registered ?? false,
  );
  return { service, resolver, sink, prisma };
}

describe('AuditForwardingService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('describe', () => {
    it('renders both transports unset and forwarding off on an empty deployment', async () => {
      const { service } = build();

      const view = await service.describe();

      expect(view.active).toBe('none');
      expect(view.syslog).toMatchObject({ source: 'unset', config: null, liveReload: false });
      expect(view.webhook).toMatchObject({ source: 'unset', config: null, liveReload: false });
    });

    it('shows the environment baseline the transport reports, without its secret', async () => {
      const transport: IAuditTransport = {
        name: 'webhook',
        configured: true,
        deliver: async () => undefined,
        currentConfiguration: () => ({ kind: 'webhook' as const, config: WEBHOOK }),
      };
      const { service } = build({ transport, registered: true });

      const view = await service.describe();

      expect(view.active).toBe('webhook');
      expect(view.webhook.source).toBe('environment');
      expect(view.webhook.config).toMatchObject({ url: WEBHOOK.url });
      expect(JSON.stringify(view)).not.toContain(WEBHOOK.token);
    });

    it('falls back to the transport name when an older build cannot report its configuration', async () => {
      const transport: IAuditTransport = {
        name: 'webhook',
        configured: true,
        deliver: async () => undefined,
      };
      const { service } = build({ transport, registered: true });

      expect((await service.describe()).active).toBe('webhook');
    });
  });

  describe('save', () => {
    it('stores a configuration without changing which transport is active', async () => {
      const { service } = build();

      const view = await service.save('syslog', SYSLOG, REQUEST);

      expect(view.active).toBe('none');
      expect(view.syslog.source).toBe('database');
      expect(view.syslog.secretsHeld).toEqual(['clientKey']);
      expect(view.syslog.config).toMatchObject({ host: SYSLOG.host, port: SYSLOG.port });
      expect(JSON.stringify(view)).not.toContain('PEM-CLIENT-KEY');
    });

    it('audits the save with redacted before and after', async () => {
      const { service, sink } = build();

      await service.save('syslog', SYSLOG, REQUEST);

      expect(sink.entries).toHaveLength(1);
      expect(sink.entries[0]).toMatchObject({
        action: 'settings.audit.syslog.update',
        entityId: 'audit.syslog',
        actorEmail: 'op@example.test',
      });
      expect(JSON.stringify(sink.entries)).not.toContain('PEM-CLIENT-KEY');
    });

    it('keeps the stored secret when a save omits it', async () => {
      const { service, resolver } = build();
      await service.save('syslog', SYSLOG, REQUEST);

      const withoutKey = syslogSettingsSchema.parse({
        host: 'siem2.example.test',
        port: 6514,
        protocol: 'tls',
      });
      await service.save('syslog', withoutKey, REQUEST);
      await service.setActive('syslog', REQUEST);

      const state = await resolver.resolveActive();
      expect(state).toMatchObject({
        state: 'syslog',
        config: { host: 'siem2.example.test', clientKey: 'PEM-CLIENT-KEY' },
      });
    });
  });

  describe('setActive', () => {
    it('refuses to activate a transport with nothing stored', async () => {
      const { service, sink } = build();

      await expect(service.setActive('syslog', REQUEST)).rejects.toThrow(ConflictException);
      expect(sink.entries).toHaveLength(0);
    });

    it('switches delivery in one write and audits the change', async () => {
      const { service, sink } = build();
      await service.save('syslog', SYSLOG, REQUEST);
      await service.save('webhook', WEBHOOK, REQUEST);

      let view = await service.setActive('syslog', REQUEST);
      expect(view.active).toBe('syslog');

      view = await service.setActive('webhook', REQUEST);
      expect(view.active).toBe('webhook');

      const switches = sink.entries.filter(
        (entry) => entry.action === 'settings.audit.forwarding.update',
      );
      expect(switches).toHaveLength(2);
      expect(switches[1]).toMatchObject({
        before: { active: 'syslog' },
        after: { active: 'webhook' },
      });
    });

    it('turns forwarding off explicitly, which is not the same as never configured', async () => {
      const { service, resolver } = build();
      await service.save('syslog', SYSLOG, REQUEST);
      await service.setActive('syslog', REQUEST);

      await service.setActive('none', REQUEST);

      expect(await resolver.resolveActive()).toEqual({ state: 'off' });
    });
  });

  describe('clear', () => {
    it('refuses to clear the active transport', async () => {
      const { service } = build();
      await service.save('syslog', SYSLOG, REQUEST);
      await service.setActive('syslog', REQUEST);

      await expect(service.clear('syslog', REQUEST)).rejects.toThrow(ConflictException);
    });

    it('clears an inactive transport and audits it', async () => {
      const { service, sink, prisma } = build();
      await service.save('syslog', SYSLOG, REQUEST);

      await service.clear('syslog', REQUEST);

      expect(prisma.rows.has('audit.syslog')).toBe(false);
      expect(sink.entries.at(-1)).toMatchObject({
        action: 'settings.audit.syslog.clear',
        after: null,
      });
    });
  });

  describe('resolveActive', () => {
    it('reports unset when nothing was ever stored, so the environment governs', async () => {
      const { resolver } = build();

      expect(await resolver.resolveActive()).toEqual({ state: 'unset' });
    });

    it('returns the active configuration WITH its secret for the transport', async () => {
      const { service, resolver } = build();
      await service.save('webhook', WEBHOOK, REQUEST);
      await service.setActive('webhook', REQUEST);

      const state = await resolver.resolveActive();

      expect(state).toMatchObject({
        state: 'webhook',
        config: { url: WEBHOOK.url, token: 'collector-token' },
      });
    });

    it('reports off, loudly, when the selection points at a missing configuration', async () => {
      const { service, resolver, prisma } = build();
      await service.save('syslog', SYSLOG, REQUEST);
      await service.setActive('syslog', REQUEST);
      // Simulate the row vanishing underneath the selection (clear() refuses
      // this path, so it takes direct interference to get here).
      prisma.rows.delete('audit.syslog');

      expect(await resolver.resolveActive()).toEqual({ state: 'off' });
    });

    it('ignores stored rows entirely under SETTINGS_SOURCE=env', async () => {
      const { service, prisma } = build();
      await service.save('syslog', SYSLOG, REQUEST);
      await service.setActive('syslog', REQUEST);

      // Same rows, new process booted with the escape hatch set.
      const forced = build({ forcedSource: 'env', prisma });

      expect(await forced.resolver.resolveActive()).toEqual({ state: 'unset' });
    });
  });

  describe('verify', () => {
    it('reports a transport that cannot test, rather than pretending', async () => {
      const { service } = build();

      const result = await service.verify('syslog', SYSLOG);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('cannot test');
    });

    it('fills the stored secret into a candidate that omits it', async () => {
      const seen: unknown[] = [];
      const transport: IAuditTransport = {
        name: 'syslog',
        configured: true,
        deliver: async () => undefined,
        verifyConfiguration: async (_kind, candidate) => {
          seen.push(candidate);
          return { ok: true, message: 'connected' };
        },
      };
      const { service } = build({ transport, registered: true });
      await service.save('syslog', SYSLOG, REQUEST);

      const candidate = syslogSettingsSchema.parse({
        host: 'siem.example.test',
        port: 6514,
        protocol: 'tls',
      });
      const result = await service.verify('syslog', candidate);

      expect(result.ok).toBe(true);
      expect(seen[0]).toMatchObject({ clientKey: 'PEM-CLIENT-KEY' });
    });

    it('answers a throwing transport with a failed test, not an exception', async () => {
      const transport: IAuditTransport = {
        name: 'syslog',
        configured: true,
        deliver: async () => undefined,
        verifyConfiguration: async () => {
          throw new Error('ECONNREFUSED');
        },
      };
      const { service } = build({ transport, registered: true });

      const result = await service.verify('syslog', SYSLOG);

      expect(result.ok).toBe(false);
      expect(result.message).not.toContain('ECONNREFUSED');
    });
  });
});
