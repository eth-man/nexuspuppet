import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createReplicationServer } from './replication.server';
import { EncReplicationService } from './enc-replication.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Exercises the real listener over a real TLS handshake against a real CA.
 *
 * The allowlist and the client-certificate requirement are the only things
 * standing between this endpoint and the whole estate's classification, and
 * neither can be verified by unit-testing a handler function: what matters is
 * what the TLS layer does before the handler is reached at all.
 */

const ALLOWED = 'puppet.corp.local';
const OTHER = 'web01.corp.local';

let dir: string;
let server: Server;
let port: number;
let upsert: jest.Mock;

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'pipe' });
}

/** A throwaway CA, a server cert, and one client cert per certname. */
function pki(root: string, certnames: readonly string[]): void {
  openssl(['genrsa', '-out', join(root, 'ca.key'), '2048']);
  openssl([
    'req', '-x509', '-new', '-key', join(root, 'ca.key'), '-days', '1',
    '-subj', '/CN=Test CA', '-out', join(root, 'ca.pem'),
  ]);

  for (const name of ['server', ...certnames]) {
    const cn = name === 'server' ? 'nexuspuppet.internal' : name;
    openssl(['genrsa', '-out', join(root, `${name}.key`), '2048']);
    openssl([
      'req', '-new', '-key', join(root, `${name}.key`),
      '-subj', `/CN=${cn}`, '-out', join(root, `${name}.csr`),
    ]);
    openssl([
      'x509', '-req', '-in', join(root, `${name}.csr`),
      '-CA', join(root, 'ca.pem'), '-CAkey', join(root, 'ca.key'), '-CAcreateserial',
      '-days', '1', '-out', join(root, `${name}.pem`),
    ]);
  }
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function fetchTree(
  clientName: string | null,
  extraHeaders: Record<string, string> = {},
  method = 'GET',
  path = '/enc-tree.tar',
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        ca: [readFileSync(join(dir, 'ca.pem'))],
        // The server cert is CN=nexuspuppet.internal; we connect by IP.
        servername: 'nexuspuppet.internal',
        headers: extraHeaders,
        ...(clientName === null
          ? {}
          : {
              cert: readFileSync(join(dir, `${clientName}.pem`)),
              key: readFileSync(join(dir, `${clientName}.key`)),
            }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'repl-'));
  pki(dir, [ALLOWED, OTHER]);

  const enc = join(dir, 'enc');
  mkdirSync(join(enc, 'nodes'), { recursive: true });
  writeFileSync(join(enc, 'default.yaml'), 'classes: {}\n');
  writeFileSync(join(enc, 'nodes/a.corp.local.yaml'), 'classes:\n  base: {}\n');

  upsert = jest.fn().mockResolvedValue(undefined);
  const prisma = { encReplicationPeer: { upsert } } as unknown as PrismaService;

  server = createReplicationServer(
    {
      port: 0,
      bind: '127.0.0.1',
      certPath: join(dir, 'server.pem'),
      keyPath: join(dir, 'server.key'),
      caPath: join(dir, 'ca.pem'),
      allowedCertnames: [ALLOWED],
    },
    new EncReplicationService(prisma, enc),
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

describe('the ENC replication endpoint', () => {
  it('serves the tree to an allowlisted certname', async () => {
    const res = await fetchTree(ALLOWED);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-tar');
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.body.length).toBeGreaterThan(0);
  });

  /*
   * The estate-wide CA signs every agent, so a valid certificate proves
   * membership of the estate and nothing more. Without the allowlist any node
   * could read how the whole estate is classified.
   */
  it('refuses a valid certificate that is not allowlisted', async () => {
    const res = await fetchTree(OTHER);

    expect(res.status).toBe(403);
    expect(res.body.toString()).toContain('not permitted');
  });

  it('refuses a client offering no certificate, at the TLS layer', async () => {
    await expect(fetchTree(null)).rejects.toThrow();
  });

  it('answers 304 when the peer already has the current tree', async () => {
    const first = await fetchTree(ALLOWED);
    const etag = String(first.headers['etag']);
    const second = await fetchTree(ALLOWED, { 'if-none-match': etag });

    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
  });

  it('records both a transfer and an unchanged poll', async () => {
    upsert.mockClear();
    const first = await fetchTree(ALLOWED);
    await fetchTree(ALLOWED, { 'if-none-match': String(first.headers['etag']) });

    const statuses = upsert.mock.calls.map((call: unknown[]) =>
      (call[0] as { update: { lastStatus: number } }).update.lastStatus,
    );
    expect(statuses).toContain(200);
    expect(statuses).toContain(304);
    expect((upsert.mock.calls[0]?.[0] as { where: unknown }).where).toEqual({ certname: ALLOWED });
  });

  it('is read-only', async () => {
    const res = await fetchTree(ALLOWED, {}, 'POST');

    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });

  it('does not serve the tree from another path', async () => {
    const res = await fetchTree(ALLOWED, {}, 'GET', '/../enc-tree.tar');

    expect(res.status).toBe(404);
  });

  it('sets no-store, so nothing between caches the estate classification', async () => {
    const res = await fetchTree(ALLOWED);

    expect(res.headers['cache-control']).toBe('no-store');
  });
});
