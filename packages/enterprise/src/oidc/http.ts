import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { OidcHttp } from './discovery';
import type { TokenExchange } from './oidc-auth.provider';
import type { OidcConfig } from './config';

/**
 * The network edge of the OIDC provider, isolated so everything above it is
 * testable without a server.
 *
 * node:http(s) rather than a client library, matching the rest of this
 * codebase: the requests are two GETs and a POST, and a dependency here would
 * sit in the path that decides who is an administrator.
 */

const MAX_BODY_BYTES = 512 * 1024;

function send(
  url: string,
  options: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = transport(target, { method: options.method, headers: options.headers, timeout: timeoutMs }, (res) => {
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        // Bounded: an identity provider is trusted to be honest, not to be
        // healthy, and an unbounded read is a memory risk from a broken one.
        bytes += Buffer.byteLength(chunk);
        if (bytes <= MAX_BODY_BYTES) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });

    req.on('timeout', () => {
      // `timeout` does not abort by itself; without this the promise never
      // settles and a login hangs until the browser gives up.
      req.destroy(new Error(`OIDC request to ${target.origin} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);

    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export class NodeOidcHttp implements OidcHttp {
  async getJson(url: string, timeoutMs: number): Promise<unknown> {
    const { status, body } = await send(url, { method: 'GET', headers: { accept: 'application/json' } }, timeoutMs);
    if (status !== 200) throw new Error(`OIDC request to ${url} answered ${status}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`OIDC response from ${url} was not JSON`);
    }
  }

  async postForm(
    url: string,
    form: URLSearchParams,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<unknown> {
    const body = form.toString();
    const { status, body: text } = await send(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(body)),
          accept: 'application/json',
        },
        body,
      },
      timeoutMs,
    );

    if (status !== 200) {
      // The response body is NOT included. A token endpoint error can echo
      // request parameters, and those contain the authorization code and may
      // contain the client secret.
      throw new Error(`OIDC token endpoint answered ${status}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('OIDC token response was not JSON');
    }
  }
}

/** Redeems an authorization code, with PKCE and optional client authentication. */
export class HttpTokenExchange implements TokenExchange {
  constructor(
    private readonly config: OidcConfig,
    private readonly http: OidcHttp = new NodeOidcHttp(),
  ) {}

  async redeem(params: { tokenEndpoint: string; code: string; verifier: string }): Promise<{
    id_token?: string;
    access_token?: string;
  }> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: params.verifier,
    });

    const headers: Record<string, string> = {};
    if (this.config.clientSecret !== undefined) {
      // client_secret_basic, not a form field. It is the more widely supported
      // of the two and keeps the secret out of any body a proxy might log.
      const basic = Buffer.from(
        `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
      ).toString('base64');
      headers['authorization'] = `Basic ${basic}`;
    }

    const raw = await this.http.postForm(params.tokenEndpoint, form, headers, this.config.timeoutMs);
    return (raw ?? {}) as { id_token?: string; access_token?: string };
  }
}
