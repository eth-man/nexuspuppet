import { connect } from 'node:tls';

/**
 * What certificate is the listener ACTUALLY serving?
 *
 * A fast pre-check, not the decision (ADR-0017). It answers "did the proxy load
 * the file", which catches a reload that reported success and did nothing — in
 * about a second, rather than costing the operator the whole confirmation
 * window with the console dark. What the change is COMMITTED on is a client
 * reaching /confirm, because only a real browser can speak to whether it trusts
 * the chain.
 *
 * `rejectUnauthorized: false` deliberately. This is an identity check, not a
 * trust check: the certificate is usually issued by a private CA this process
 * has no reason to carry, and the question being asked is "is this the file I
 * just installed", answered by comparing fingerprints. Verifying the chain here
 * would fail on perfectly good deployments and prove nothing extra — the
 * client's own verification is the part that matters, and it happens elsewhere.
 */
export function tlsProbe(
  host: string,
  port: number,
  servername: string,
  timeoutMs = 5000,
): () => Promise<string> {
  return () =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(
        { host, port, servername, rejectUnauthorized: false, timeout: timeoutMs },
        () => {
          const certificate = socket.getPeerCertificate();
          socket.end();

          if (certificate === null || Object.keys(certificate).length === 0) {
            reject(new Error('The proxy completed a handshake but presented no certificate.'));
            return;
          }
          resolve(certificate.fingerprint256);
        },
      );

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`The proxy did not answer on ${host}:${port} within ${timeoutMs}ms.`));
      });

      socket.on('error', (error) =>
        reject(new Error(`Could not reach the proxy on ${host}:${port}: ${error.message}`)),
      );
    });
}
