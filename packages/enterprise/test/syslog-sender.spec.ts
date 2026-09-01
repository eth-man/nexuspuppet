import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import type { AuditDeliveryEntry, SyslogSettings } from '@nexuspuppet/contracts';
import { syslogSettingsSchema } from '@nexuspuppet/contracts';
import { SyslogSender, frameOctetCounted } from '../src/audit/syslog-sender';

const ENTRY: AuditDeliveryEntry = {
  auditLogId: 'log-1',
  actorUserId: 'u-1',
  actorEmail: 'op@example.test',
  action: 'settings.audit.syslog.update',
  entityType: 'ProviderSetting',
  entityId: 'audit.syslog',
  before: null,
  after: { host: 'siem.example.test' },
  ipAddress: '10.0.0.9',
  userAgent: 'jest',
  createdAt: '2026-08-05T10:00:00.000Z',
};

function config(over: Partial<SyslogSettings>): SyslogSettings {
  return syslogSettingsSchema.parse({ host: '127.0.0.1', port: 514, ...over });
}

describe('RFC 5424 formatting', () => {
  const sender = new SyslogSender(config({}), 'console.example.test');

  it('builds the header from the record, not the wall clock', () => {
    const message = sender.format(ENTRY);

    // facility 13 (log audit) * 8 + severity 5 (notice) = 109
    expect(message.startsWith('<109>1 2026-08-05T10:00:00.000Z console.example.test ')).toBe(true);
    expect(message).toContain(' nexuspuppet ');
    expect(message).toContain(' settings.audit.syslog.update ');
  });

  it('carries the record as JSON in MSG', () => {
    const message = sender.format(ENTRY);
    const json = message.slice(message.indexOf('{'));

    expect(JSON.parse(json)).toEqual(ENTRY);
  });

  it('never lets a hostname shift the header fields', () => {
    const hostile = new SyslogSender(config({}), 'two words\x07');

    const message = hostile.format(ENTRY);

    expect(message).toContain(' two_words_ ');
  });

  it('honours the configured facility', () => {
    const local0 = new SyslogSender(config({ facility: 16 }), 'h');

    expect(local0.format(ENTRY).startsWith(`<${16 * 8 + 5}>1`)).toBe(true);
  });
});

describe('octet-counted framing', () => {
  it('prefixes the BYTE length, which differs from the string length', () => {
    expect(frameOctetCounted('abc')).toBe('3 abc');
    // '€' is one character and three bytes; a char-count frame would corrupt
    // the stream at the first non-ASCII actor name.
    expect(frameOctetCounted('€')).toBe('3 €');
  });
});

describe('TCP delivery', () => {
  let server: Server;
  let received: Buffer[];
  let port: number;
  let onSocket: (socket: Socket) => void;

  beforeEach(async () => {
    received = [];
    onSocket = (socket) => {
      socket.on('data', (chunk) => received.push(chunk));
      // Default peer behaviour: acknowledge the client's FIN by closing too.
      socket.on('end', () => socket.end());
    };
    server = createServer((socket) => onSocket(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('delivers a framed batch and resolves on a clean close', async () => {
    const sender = new SyslogSender(config({ port, protocol: 'tcp' }), 'h');

    await sender.send([ENTRY, ENTRY]);

    const wire = Buffer.concat(received).toString('utf8');
    const first = sender.format(ENTRY);
    expect(wire).toBe(frameOctetCounted(first) + frameOctetCounted(first));
  });

  it('fails the batch when the collector stalls, within the configured budget', async () => {
    // Accepts, reads, and never acknowledges the close — the drowning
    // collector from ADR-0016 §5, which must fail the batch rather than stall
    // the worker. `allowHalfOpen` matters: without it Node auto-FINs on the
    // peer's behalf and no server can be made to stall.
    const held: Socket[] = [];
    const stalling = createServer({ allowHalfOpen: true }, (socket) => {
      held.push(socket);
      socket.on('data', () => undefined);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve));
    const stallingPort = (stalling.address() as AddressInfo).port;

    try {
      const sender = new SyslogSender(
        config({ port: stallingPort, protocol: 'tcp', timeoutMs: 300 }),
        'h',
      );

      await expect(sender.send([ENTRY])).rejects.toThrow(/stalled for 300ms/);
    } finally {
      // The stall is the point of this server, and it stalls close() too —
      // half-open sockets must be destroyed or this teardown never returns.
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => stalling.close(resolve));
    }
  });

  it('fails loudly when nothing is listening', async () => {
    const sender = new SyslogSender(config({ port: 1, protocol: 'tcp', timeoutMs: 1_000 }), 'h');

    await expect(sender.send([ENTRY])).rejects.toThrow(/syslog delivery failed/);
  });
});

describe('UDP delivery', () => {
  it('sends one unframed datagram per record', async () => {
    const receiver = createSocket('udp4');
    const datagrams: string[] = [];
    receiver.on('message', (msg) => datagrams.push(msg.toString('utf8')));
    await new Promise<void>((resolve) => receiver.bind(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;

    try {
      const sender = new SyslogSender(config({ port, protocol: 'udp' }), 'h');
      await sender.send([ENTRY]);

      // The kernel accepted it; loopback makes receipt observable here, which
      // production UDP never promises — that asymmetry is the whole
      // "unconfirmable delivery" warning.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(datagrams).toHaveLength(1);
      expect(datagrams[0]!.startsWith('<109>1 ')).toBe(true);
    } finally {
      receiver.close();
    }
  });
});

describe('probe', () => {
  it('reports the connection and the test record for a reachable collector', async () => {
    const server = createServer((socket) => {
      socket.on('data', () => undefined);
      socket.on('end', () => socket.end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const details = await new SyslogSender(config({ port, protocol: 'tcp' }), 'h').probe();

      expect(details.map((d) => d.label)).toEqual(['connected', 'sent']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('names the UDP caveat instead of claiming receipt', async () => {
    const sender = new SyslogSender(config({ port: 65_000, protocol: 'udp' }), 'h');

    const details = await sender.probe();

    expect(details.find((d) => d.label === 'caveat')?.value).toContain('unconfirmable');
  });
});
