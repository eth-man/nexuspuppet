import { readFile } from 'node:fs/promises';
import { request } from 'node:http';

/**
 * Make Caddy re-read its certificate files.
 *
 * `Cache-Control: must-revalidate` IS THE FEATURE. Caddy skips a reload when the
 * submitted config is byte-identical to the running one — and it is identical
 * here, because nothing about the config changed, only the files behind it. A
 * skipped reload leaves the OLD certificate loaded, the confirmation poll then
 * succeeds against that old certificate, and the install is committed without
 * ever having been applied.
 *
 * That is a silent, total defeat of the commit-confirm loop caused by one
 * missing header. It is asserted in a test for exactly that reason.
 *
 * The reload is also what recycles the listener, so the operator's browser
 * makes a fresh handshake rather than continuing on a pooled connection that
 * still holds the previous certificate. Measured against Caddy 2 and recorded in
 * ADR-0017; a proxy that reloads WITHOUT dropping connections would break the
 * loop silently, so this adapter is where that assumption lives.
 */
export function caddyReload(adminOrigin: string, caddyfilePath: string): () => Promise<void> {
  return async () => {
    const config = await readFile(caddyfilePath, 'utf8');
    const url = new URL('/load', adminOrigin);

    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'text/caddyfile',
            // Do not remove. See above.
            'Cache-Control': 'must-revalidate',
            'Content-Length': Buffer.byteLength(config),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve();
            // Caddy's admin API explains a rejected config in the body, and
            // that explanation is the only useful thing an operator will get.
            reject(
              new Error(
                `The proxy refused to reload (HTTP ${status}): ` +
                  `${Buffer.concat(chunks).toString('utf8').trim() || '(no detail)'}`,
              ),
            );
          });
        },
      );

      req.on('error', (error) =>
        reject(new Error(`The proxy admin API is unreachable at ${adminOrigin}: ${error.message}`)),
      );
      req.end(config);
    });
  };
}
