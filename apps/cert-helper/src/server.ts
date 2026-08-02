import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProxyPorts } from './install';
import { SpentGrants, verifyGrant } from '@nexuspuppet/tls-grant';
import { confirmPending, expireIfDue, readPending, stageBundle } from './pending';

/**
 * Body cap.
 *
 * A certificate chain and a key are a few kilobytes. This endpoint is reachable
 * from a browser, so it needs a bound that is not "whatever the client sends" —
 * and one small enough that a hostile upload cannot be interesting.
 */
const MAX_BODY_BYTES = 256 * 1024;

export interface HelperConfig {
  root: string;
  secret: string;
  windowSeconds: number;
  ports: ProxyPorts;
}

/**
 * The helper's HTTP surface. Two verbs, and no way to read anything.
 *
 * There is deliberately no endpoint that returns key material, a certificate, or
 * a file path. Compromising this process yields the ability to REPLACE the
 * console's certificate, not to steal the one it holds (ADR-0017).
 */
export function createHelperServer(config: HelperConfig): Server {
  const spent = new SpentGrants();

  return createServer((req, res) => {
    void handle(req, res, config, spent).catch((error: unknown) => {
      // Never leak an internal message to a browser-reachable endpoint; the
      // detail goes to the log, where an operator with host access can read it.
      console.error('[cert-helper] unhandled error', error);
      send(res, 500, { status: 'error', message: 'The certificate helper failed unexpectedly.' });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: HelperConfig,
  spent: SpentGrants,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://helper.invalid');

  if (req.method === 'POST' && url.pathname === '/console-tls/confirm') {
    // NOT swept first. confirmPending distinguishes "your window closed and it
    // was rolled back" from "nothing was pending", and the caller needs the
    // former — sweeping here would collapse it into the latter and the console
    // would report success for an install that was undone.
    return confirm(req, res, config);
  }

  // Every other request sweeps. A helper whose timer was starved must not
  // commit an install by omission.
  await expireIfDue(config.root, config.ports);

  if (req.method === 'POST' && url.pathname === '/console-tls/install') {
    return install(req, res, config, spent);
  }
  if (req.method === 'GET' && url.pathname === '/console-tls/status') {
    const pending = await readPending(config.root);
    return send(res, 200, {
      status: 'ok',
      pending:
        pending === null ? null : { expiresAt: pending.expiresAt, identity: pending.identity },
    });
  }

  send(res, 404, { status: 'error', message: 'No such endpoint.' });
}

async function install(
  req: IncomingMessage,
  res: ServerResponse,
  config: HelperConfig,
  spent: SpentGrants,
): Promise<void> {
  const body = await readJson(req);
  if (body === TOO_LARGE) {
    send(res, 413, {
      status: 'error',
      message:
        `That upload is larger than the ${MAX_BODY_BYTES / 1024}KB limit. A certificate ` +
        'chain and key are a few kilobytes; check the files are the ones you meant.',
    });
    req.destroy();
    return;
  }
  if (body === null) return send(res, 400, { status: 'error', message: 'Expected a JSON body.' });

  const { grant, certificate, privateKey } = body as Record<string, unknown>;
  if (
    typeof grant !== 'string' ||
    typeof certificate !== 'string' ||
    typeof privateKey !== 'string'
  ) {
    return send(res, 400, {
      status: 'error',
      message: 'Expected grant, certificate and privateKey as strings.',
    });
  }

  const verdict = verifyGrant(config.secret, grant, config.ports.now(), spent);
  if (!verdict.valid) {
    // One status and one message for every rejection. Distinguishing "expired"
    // from "bad signature" here tells an attacker which half to work on.
    return send(res, 403, { status: 'error', message: 'That authorisation is not valid.' });
  }

  const outcome = await stageBundle(
    config.root,
    certificate,
    privateKey,
    config.ports,
    config.windowSeconds,
  );

  switch (outcome.status) {
    case 'pending':
      // 202: serving, NOT committed. The browser must now come back over the
      // new certificate before expiresAt or this is undone.
      return send(res, 202, {
        status: 'pending',
        confirmationToken: outcome.token,
        expiresAt: outcome.expiresAt,
        identity: outcome.identity,
      });
    case 'rejected':
      return send(res, 422, { status: 'rejected', rejection: outcome.rejection });
    case 'rolled-back':
      return send(res, 409, { status: 'rolled-back', reason: outcome.reason });
    case 'rollback-failed':
      // 500 because the deployment is now in a state nobody asked for and the
      // console may be unreachable. This is the response that has to be loud.
      return send(res, 500, {
        status: 'rollback-failed',
        reason: outcome.reason,
        detail: outcome.detail,
      });
  }
}

async function confirm(
  req: IncomingMessage,
  res: ServerResponse,
  config: HelperConfig,
): Promise<void> {
  const body = await readJson(req);
  const token =
    body === TOO_LARGE
      ? undefined
      : (body as Record<string, unknown> | null)?.['confirmationToken'];
  if (typeof token !== 'string') {
    return send(res, 400, { status: 'error', message: 'Expected confirmationToken.' });
  }

  /*
   * Reaching this line is the evidence.
   *
   * The request arrived over a TLS connection the client negotiated against the
   * NEW certificate — the reload recycles the listener, so it cannot be riding a
   * pooled connection that still holds the old one. No check inside the
   * deployment can establish that the operator's browser trusts the chain; this
   * one does, because the operator's browser is what made the request.
   */
  const outcome = await confirmPending(config.root, token, config.ports);

  switch (outcome.status) {
    case 'confirmed':
      return send(res, 200, { status: 'confirmed', identity: outcome.identity });
    case 'nothing-pending':
      return send(res, 200, { status: 'nothing-pending' });
    case 'token-mismatch':
      return send(res, 403, { status: 'error', message: 'That confirmation token is not valid.' });
    case 'expired':
      return send(res, 410, { status: 'expired', rollback: outcome.rollback });
  }
}

const TOO_LARGE = Symbol('too-large');

function readJson(req: IncomingMessage): Promise<unknown | typeof TOO_LARGE | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, but do NOT destroy the socket yet: the response has
        // to reach the client, and a destroyed connection reads as a network
        // fault rather than a refusal it can act on.
        if (!over) {
          over = true;
          resolve(TOO_LARGE);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Nothing here is cacheable, and a confirmation served from a cache would
    // be a confirmation nobody made.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
