import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createReplicationServer } from './replication.server';
import { CompileReceiptsService } from './compile-receipts.service';
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
let receiptUpsert: jest.Mock;

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'pipe' });
}

/** A throwaway CA, a server cert, and one client cert per certname. */
function pki(root: string, certnames: readonly string[]): void {
  openssl(['genrsa', '-out', join(root, 'ca.key'), '2048']);
  openssl([
    'req',
    '-x509',
    '-new',
    '-key',
    join(root, 'ca.key'),
    '-days',
    '1',
    '-subj',
    '/CN=Test CA',
    '-out',
    join(root, 'ca.pem'),
  ]);

  for (const name of ['server', ...certnames]) {
    const cn = name === 'server' ? 'nexuspuppet.internal' : name;
    openssl(['genrsa', '-out', join(root, `${name}.key`), '2048']);
    openssl([
      'req',
      '-new',
      '-key',
      join(root, `${name}.key`),
      '-subj',
      `/CN=${cn}`,
      '-out',
      join(root, `${name}.csr`),
    ]);
    openssl([
      'x509',
      '-req',
      '-in',
      join(root, `${name}.csr`),
      '-CA',
      join(root, 'ca.pem'),
      '-CAkey',
      join(root, 'ca.key'),
      '-CAcreateserial',
      '-days',
      '1',
      '-out',
      join(root, `${name}.pem`),
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
  body?: string,
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
    req.end(body);
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
  receiptUpsert = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    encReplicationPeer: { upsert },
    managedNode: { findMany: jest.fn().mockResolvedValue([{ certname: 'a.corp.local' }]) },
    compileReceipt: { upsert: receiptUpsert },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  } as unknown as PrismaService;

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
    new CompileReceiptsService(prisma),
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

describe('the compile receipts route (ADR-0022 §4, §10)', () => {
  const post = (client: string | null, body: string) =>
    fetchTree(client, { 'content-type': 'text/plain' }, 'POST', '/enc-receipts', body);

  it('accepts a batch from an allowlisted peer', async () => {
    receiptUpsert.mockClear();
    const res = await post(ALLOWED, 'abc123 a.corp.local\ndef456 b.corp.local\n');

    expect(res.status).toBe(202);
    expect(receiptUpsert).toHaveBeenCalledTimes(2);
  });

  /*
   * The peer identity is the whole authorization. A body naming another
   * certname must not be able to report on its behalf (binding constraint 1).
   */
  it('attributes receipts to the certificate, never the body', async () => {
    receiptUpsert.mockClear();
    await post(ALLOWED, 'abc123 a.corp.local\n');

    const args = receiptUpsert.mock.calls[0]?.[0] as {
      create: { peerCertname: string; certname: string };
    };
    expect(args.create.peerCertname).toBe(ALLOWED);
    expect(args.create.certname).toBe('a.corp.local');
  });

  it('refuses a peer that is not allowlisted', async () => {
    receiptUpsert.mockClear();
    const res = await post(OTHER, 'abc123 a.corp.local\n');

    expect(res.status).toBe(403);
    expect(receiptUpsert).not.toHaveBeenCalled();
  });

  /*
   * THE STATUS CODES ARE A PROTOCOL (§10). The shipped puller discards its file
   * on 404/405/501 and retries forever on anything else, so a POST to the right
   * path must never fall through to the read-only 405 — that would tell a
   * healthy origin's peer to throw its receipts away.
   */
  it('does not answer the receipts path with the read-only 405', async () => {
    const res = await post(ALLOWED, 'abc123 a.corp.local\n');

    expect(res.status).not.toBe(405);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(501);
  });

  it('still refuses POST to any other path', async () => {
    const res = await fetchTree(ALLOWED, {}, 'POST', '/enc-tree.tar', 'x');

    expect(res.status).toBe(405);
  });

  /*
   * Malformed lines are individually dropped. The file is appended to by a
   * shell loop on a machine we do not control; one torn write must not cost
   * every other node in the batch.
   */
  it('drops malformed lines without failing the batch', async () => {
    receiptUpsert.mockClear();
    const res = await post(ALLOWED, 'not-a-receipt\nabc123 a.corp.local\n\ngarbage here too\n');

    expect(res.status).toBe(202);
    expect(receiptUpsert).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty batch without writing anything', async () => {
    receiptUpsert.mockClear();
    const res = await post(ALLOWED, '');

    expect(res.status).toBe(202);
    expect(receiptUpsert).not.toHaveBeenCalled();
  });

  /*
   * Last line wins: the file is append-ordered, so position is compile order.
   * Revisions are content hashes and carry no order of their own.
   */
  it('keeps the last revision when a node appears twice', async () => {
    receiptUpsert.mockClear();
    await post(ALLOWED, 'aaa111 a.corp.local\nbbb222 a.corp.local\n');

    expect(receiptUpsert).toHaveBeenCalledTimes(1);
    const args = receiptUpsert.mock.calls[0]?.[0] as { create: { revision: string } };
    expect(args.create.revision).toBe('bbb222');
  });

  it('records whether the node was known at ingest', async () => {
    receiptUpsert.mockClear();
    await post(ALLOWED, 'abc123 a.corp.local\nabc123 ghost.corp.local\n');

    const flags = receiptUpsert.mock.calls.map(
      (c) => (c[0] as { create: { certname: string; matchedAtIngest: boolean } }).create,
    );
    expect(flags.find((f) => f.certname === 'a.corp.local')?.matchedAtIngest).toBe(true);
    // Unknown to the projection — kept, and marked, because that is the node
    // somebody is most likely to be debugging (§11).
    expect(flags.find((f) => f.certname === 'ghost.corp.local')?.matchedAtIngest).toBe(false);
  });
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

    const statuses = upsert.mock.calls.map(
      (call: unknown[]) => (call[0] as { update: { lastStatus: number } }).update.lastStatus,
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
