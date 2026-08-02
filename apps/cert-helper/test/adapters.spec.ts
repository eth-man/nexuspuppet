import { X509Certificate } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as NetServer } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caddyReload } from '../src/adapters/caddy-reload';
import { tlsProbe } from '../src/adapters/tls-probe';
import { makePair } from './fixtures';

jest.setTimeout(120_000);

/** Listen on an ephemeral port and report which one. */
function listen(server: Server | TlsServer | NetServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

describe('caddyReload', () => {
  let server: Server;
  let seen: {
    headers: IncomingHttpHeaders;
    body: string;
    method: string | undefined;
    url: string | undefined;
  };
  let status = 200;
  let responseBody = '';
  let origin: string;
  let dir: string;
  let caddyfile: string;

  beforeEach(async () => {
    status = 200;
    responseBody = '';
    dir = await mkdtemp(join(tmpdir(), 'nexuspuppet-reload-'));
    caddyfile = join(dir, 'Caddyfile');
    await writeFile(caddyfile, 'https://console.example.test {\n\trespond "ok"\n}\n');

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          method: req.method,
          url: req.url,
        };
        res.writeHead(status);
        res.end(responseBody);
      });
    });
    origin = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('sends Cache-Control: must-revalidate', async () => {
    /*
     * THE test in this file.
     *
     * Caddy skips a reload when the submitted config is byte-identical to the
     * running one, and it IS identical here — only the files behind it changed.
     * A skipped reload leaves the old certificate loaded, the confirmation poll
     * succeeds against it, and the install is committed without having been
     * applied. One missing header, and the whole commit-confirm loop is a
     * no-op that reports success.
     */
    await caddyReload(origin, caddyfile)();

    expect(seen.headers['cache-control']).toBe('must-revalidate');
  });

  it('POSTs the Caddyfile to /load as text/caddyfile', async () => {
    await caddyReload(origin, caddyfile)();

    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/load');
    expect(seen.headers['content-type']).toBe('text/caddyfile');
    expect(seen.body).toContain('console.example.test');
  });

  it('fails with the proxy’s own explanation when the config is refused', async () => {
    // Caddy explains a rejected config in the body, and that explanation is the
    // only useful thing the operator will get.
    status = 400;
    responseBody = 'invalid site block at line 3';

    await expect(caddyReload(origin, caddyfile)()).rejects.toThrow(/invalid site block at line 3/);
  });

  it('fails clearly when the admin API is unreachable', async () => {
    server.close();

    await expect(caddyReload(origin, caddyfile)()).rejects.toThrow(/unreachable/i);
  });
});

describe('tlsProbe', () => {
  let server: TlsServer;
  let port: number;
  const pair = makePair({ subject: '/CN=probe.example.test' });

  beforeEach(async () => {
    server = createTlsServer({ cert: pair.certPem, key: pair.keyPem }, (socket) => socket.end());
    port = await listen(server);
  });

  afterEach(() => {
    server.close();
  });

  it('reports the fingerprint of the certificate actually served', async () => {
    const served = await tlsProbe('127.0.0.1', port, 'probe.example.test')();

    expect(served).toBe(new X509Certificate(pair.certPem).fingerprint256);
  });

  it('does not require the certificate to be trusted', async () => {
    // Self-signed, from a CA this process has never heard of — which is the
    // normal case for a console behind a private CA. Chain verification is the
    // client's job; this is an identity check.
    await expect(tlsProbe('127.0.0.1', port, 'probe.example.test')()).resolves.toMatch(
      /^[0-9A-F:]+$/,
    );
  });

  it('fails clearly when nothing is listening', async () => {
    server.close();

    await expect(tlsProbe('127.0.0.1', port, 'probe.example.test', 2000)()).rejects.toThrow(
      /could not reach the proxy/i,
    );
  });

  it('gives up rather than hanging when the port accepts but never handshakes', async () => {
    // A raw TCP listener that accepts and then says nothing. It must not be an
    // HTTP server: that answers the ClientHello with a protocol error, which
    // exercises the error path rather than the timeout path.
    const dead = createTcpServer(() => {});
    const deadPort = await listen(dead);

    await expect(tlsProbe('127.0.0.1', deadPort, 'probe.example.test', 1000)()).rejects.toThrow(
      /within 1000ms/,
    );

    dead.close();
  });
});
