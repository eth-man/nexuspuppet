import { NextResponse, type NextRequest } from 'next/server';

/**
 * Server-side proxy to the NexusPuppet API.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two constraints meet here and only this shape satisfies both:
 *
 *   1. The browser must never talk to the API directly (C4 L2, ADR-0008). The
 *      API address is internal and is deliberately not exposed to the client —
 *      `API_INTERNAL_URL` has no NEXT_PUBLIC_ prefix.
 *   2. Session cookies are HttpOnly, so client JavaScript cannot read or
 *      forward them. They must be set on the origin the browser is talking to.
 *
 * So the browser calls same-origin `/api/*`, and this handler relays to the API
 * server-side, passing cookies both ways. No CORS, no cross-origin cookies, and
 * the API host stays server-side.
 *
 * COOKIE PATH REWRITING
 * ---------------------
 * The API scopes its refresh cookie to `Path=/auth` so it is not sent on every
 * request. Behind this proxy the browser sees that endpoint at `/api/auth/...`,
 * and a cookie scoped to `/auth` would never be sent — refresh would fail with
 * "no refresh token presented" and every session would die at the access-token
 * expiry. Paths are rewritten to match the proxied prefix.
 *
 * This handler is a fixed relay to one configured host. It never takes a target
 * from the request, so it cannot be turned into an open forwarder.
 */

export const dynamic = 'force-dynamic';

const PROXY_PREFIX = '/api';

/** Hop-by-hop headers must not be forwarded. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'content-length',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function apiBase(): string {
  const base = process.env['API_INTERNAL_URL'];
  if (base === undefined || base === '') {
    throw new Error('API_INTERNAL_URL is not configured for the web tier.');
  }
  return base.replace(/\/$/, '');
}

async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const target = `${apiBase()}${url.pathname.slice(PROXY_PREFIX.length)}${url.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }

  // The API derives `secure` on cookies and the client IP from these.
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : null,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (error) {
    // The API being down is a named state, not a blank screen. The UI renders
    // this rather than an empty table (ADR-0004 §6).
    return NextResponse.json(
      {
        error: 'API_UNREACHABLE',
        message: `The NexusPuppet API is not responding: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
      responseHeaders.set(key, value);
    }
  }

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });

  // getSetCookie() preserves multiple Set-Cookie headers; Headers.get() would
  // fold them into one comma-joined string and lose a cookie.
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', rewriteCookiePath(cookie));
  }

  return response;
}

/**
 * Re-scope a cookie path to sit under the proxy prefix.
 *
 * `Path=/auth` becomes `Path=/api/auth`; `Path=/` stays `/` so the access
 * cookie is still sent on every request.
 */
export function rewriteCookiePath(setCookie: string): string {
  return setCookie.replace(/;\s*Path=([^;]*)/i, (_match, path: string) => {
    const trimmed = path.trim();
    if (trimmed === '/' || trimmed === '') return '; Path=/';
    return `; Path=${PROXY_PREFIX}${trimmed}`;
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
