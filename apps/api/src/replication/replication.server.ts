import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket, TlsOptions } from 'node:tls';
import { Logger } from '@nestjs/common';
import type { EncReplicationService } from './enc-replication.service';
import type { CompileReceiptsService } from './compile-receipts.service';

/**
 * The ENC tree replication endpoint (ADR-0019).
 *
 * A LISTENER OF ITS OWN, not a route on the main API, for three reasons that
 * are all really the same reason:
 *
 * 1. It authenticates by client certificate against the Puppet CA, and nothing
 *    else on the API does. Mixing that into the session-cookie app would mean
 *    one server with two authentication models and a guard deciding which
 *    applies per route — the kind of arrangement where a route added later
 *    silently gets the wrong one.
 * 2. The main API binds loopback and is fronted by a proxy (DEPLOYMENT.md §7).
 *    Terminating mTLS at that proxy and forwarding the certname in a header
 *    would make the whole authorization a header any process on the host could
 *    assert. Here the certificate chain is verified in this process, by this
 *    code, and the certname is read from the verified peer certificate.
 * 3. It must work on a deployment that does not run the proxy at all.
 *
 * There is exactly one route, it is GET-only, and it serves bytes the
 * materializer already wrote. No classification is computed here (ADR-0019
 * binding constraint 1).
 */

export interface ReplicationServerOptions {
  port: number;
  bind: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  /** Certnames permitted to fetch. Empty means nobody, never everybody. */
  allowedCertnames: readonly string[];
}

const ROUTE = '/enc-tree.tar';
const RECEIPTS_ROUTE = '/enc-receipts';

/**
 * The most body this route will read, in bytes.
 *
 * A generous ceiling for 20,000 lines of roughly 80 bytes, and a hard stop on a
 * peer streaming without end. Exceeding it is not an error the caller is told
 * about — see `handleReceipts`.
 */
const MAX_RECEIPTS_BODY_BYTES = 4 * 1024 * 1024;

export function createReplicationServer(
  options: ReplicationServerOptions,
  service: EncReplicationService,
  receipts: CompileReceiptsService,
  logger = new Logger('EncReplication'),
): Server {
  const tls: TlsOptions = {
    cert: readFileSync(options.certPath),
    key: readFileSync(options.keyPath),
    ca: readFileSync(options.caPath),
    /*
     * requestCert AND rejectUnauthorized. With requestCert alone, a client
     * offering no certificate — or one signed by an unknown CA — still
     * completes the handshake and arrives here as `authorized: false`, and the
     * whole gate then rests on remembering to check that flag. Rejecting in
     * the TLS layer means an unverified peer never reaches this code at all.
     */
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };

  const allowed = new Set(options.allowedCertnames);

  const server = createServer(tls, (request, response) => {
    void handle(request, response, service, receipts, allowed, logger).catch((error: unknown) => {
      logger.error(`Replication request failed: ${describe(error)}`);
      if (!response.headersSent) send(response, 500, 'Internal error.\n');
    });
  });

  server.on('tlsClientError', (error: Error) => {
    // Expected and frequent while an operator is setting this up: a puller
    // with no certificate, the wrong CA, or an expired one. Logged at debug so
    // it is available when diagnosing and does not drown the log otherwise.
    logger.debug(`Rejected a TLS client: ${error.message}`);
  });

  return server;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  service: EncReplicationService,
  receipts: CompileReceiptsService,
  allowed: ReadonlySet<string>,
  logger: Logger,
): Promise<void> {
  const certname = peerCertname(request);

  if (certname === null) {
    // Unreachable while rejectUnauthorized is true; kept because the cost of
    // being wrong about that is serving the estate's classification to anyone.
    send(response, 401, 'A verified client certificate is required.\n');
    return;
  }

  if (!allowed.has(certname)) {
    /*
     * The estate-wide CA signs every agent, so a valid certificate proves
     * membership of the estate and nothing more. The allowlist is what makes
     * this endpoint safe to expose: without it, any node holding an agent
     * certificate could read the whole estate's classification.
     *
     * Logged at warn — a rejection here is either a misconfigured puller or
     * something that should not be asking.
     */
    logger.warn(`Refused ${certname}: not in the replication allowlist.`);
    send(response, 403, 'This certname is not permitted to replicate the ENC tree.\n');
    return;
  }

  const path = (request.url ?? '').split('?')[0];

  /*
   * The one write on this listener (ADR-0022 §4), which amends ADR-0019's
   * read-only claim explicitly rather than widening it quietly.
   *
   * It is reached only by POST to exactly this path. Every other method and
   * path still falls through to the read-only gate below, so the surface added
   * here is one route and one verb — constraint 1 exists to be quoted at
   * whoever proposes the second.
   */
  if (path === RECEIPTS_ROUTE && request.method === 'POST') {
    await handleReceipts(request, response, receipts, certname, logger);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // 405 is load-bearing: the puller reads it as "this origin has no receipts
    // surface" and DISCARDS the batch rather than retrying (ADR-0022 §10). That
    // is correct for an origin that predates receipts, and it is why a POST to
    // the right path must be handled above rather than reaching this.
    response.setHeader('allow', 'GET, HEAD');
    send(response, 405, 'Read-only apart from POST /enc-receipts (ADR-0019, ADR-0022 §4).\n');
    return;
  }

  if (path !== ROUTE) {
    send(response, 404, `Not found. The tree is at ${ROUTE}.\n`);
    return;
  }

  const tree = await service.readTree();
  const inm = request.headers['if-none-match'];

  if (inm !== undefined && matchesEtag(inm, tree.etag)) {
    await service.recordFetch(certname, tree.etag, 304);
    response.statusCode = 304;
    response.setHeader('etag', quote(tree.etag));
    response.end();
    return;
  }

  await service.recordFetch(certname, tree.etag, 200);

  response.statusCode = 200;
  response.setHeader('content-type', 'application/x-tar');
  response.setHeader('etag', quote(tree.etag));
  response.setHeader('content-length', String(tree.archive.length));
  // The tree is authorization-sensitive and changes without notice; a cache in
  // between holding it would defeat both the allowlist and the polling model.
  response.setHeader('cache-control', 'no-store');
  response.end(request.method === 'HEAD' ? undefined : tree.archive);
}

/**
 * Accept a batch of compile receipts from one Puppet server (ADR-0022 §4).
 *
 * STATUS CODES ARE A PROTOCOL HERE, NOT A STYLE CHOICE (§10, binding constraint
 * 3). The shipped puller reads:
 *
 *   2xx              consumed — delete the file
 *   404 / 405 / 501  this origin has no receipts surface — discard the file
 *   anything else    retry the identical body, forever
 *
 * So an oversized or partly malformed batch must NOT be refused. A 413 would be
 * correct HTTP and would wedge that peer permanently: same too-large body every
 * sync, receipts never landing, and only a log line on a machine nobody is
 * watching. The batch is truncated to its newest lines instead — the rule the
 * puller itself applies at rotation — and what was dropped is logged.
 *
 * The only failure returned is 500, which IS retryable and should be: a
 * database that is briefly unavailable is exactly the case where the puller
 * should hold the receipts and come back.
 */
async function handleReceipts(
  request: IncomingMessage,
  response: ServerResponse,
  receipts: CompileReceiptsService,
  peer: string,
  logger: Logger,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(request, MAX_RECEIPTS_BODY_BYTES);
  } catch (error) {
    // Over the byte ceiling, or the connection died mid-upload. Retryable: the
    // peer will cap its own file at the next rotation and try again with less.
    logger.warn(`Peer ${JSON.stringify(peer)}: could not read receipt body: ${describe(error)}`);
    send(response, 500, 'Could not read the receipt batch.\n');
    return;
  }

  const result = await receipts.ingest(peer, body);

  logger.log(
    `Peer ${JSON.stringify(peer)}: stored ${String(result.stored)} compile receipt(s)` +
      (result.malformed > 0 ? `, ignored ${String(result.malformed)} malformed` : '') +
      (result.discarded > 0 ? `, discarded ${String(result.discarded)} over the cap` : '') +
      '.',
  );

  // 202, not 200: some of what arrived may have been dropped on purpose, and
  // the peer is being told the batch was taken off its hands — not that every
  // line was stored.
  send(response, 202, `Stored ${String(result.stored)} receipt(s).\n`);
}

/**
 * Read a request body with a hard ceiling.
 *
 * Destroys the connection rather than draining a stream that has already proven
 * too large — the credential here is an estate-wide certificate, so a peer that
 * is misbehaving is not necessarily a peer that is malicious, but it must not
 * be able to hold memory open either way.
 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new Error(`receipt batch exceeded ${String(maxBytes)} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * The certname, taken from the VERIFIED peer certificate.
 *
 * Never from a header, a query parameter or the request body — all of which
 * the client chooses. This is the single fact the whole authorization rests
 * on, so it comes from the TLS layer or it does not come at all.
 */
function peerCertname(request: IncomingMessage): string | null {
  const socket = request.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function') return null;

  const peer = socket.getPeerCertificate();
  if (socket.authorized !== true) return null;

  const cn = peer.subject?.CN;
  return typeof cn === 'string' && cn.length > 0 ? cn : null;
}

/** RFC 7232 If-None-Match: a list, and `*` matches anything present. */
function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .includes(etag);
}

function quote(etag: string): string {
  return `"${etag}"`;
}

function send(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(body);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
