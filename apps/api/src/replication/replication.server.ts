import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket, TlsOptions } from 'node:tls';
import { Logger } from '@nestjs/common';
import type { EncReplicationService } from './enc-replication.service';

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

export function createReplicationServer(
  options: ReplicationServerOptions,
  service: EncReplicationService,
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
    void handle(request, response, service, allowed, logger).catch((error: unknown) => {
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

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD');
    send(response, 405, 'Read-only (ADR-0004, ADR-0019).\n');
    return;
  }

  const path = (request.url ?? '').split('?')[0];
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
