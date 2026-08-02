import { mkdir, rm } from 'node:fs/promises';
import { caddyReload } from './adapters/caddy-reload';
import { tlsProbe } from './adapters/tls-probe';
import { adoptExisting } from './adopt';
import { assertWritable, readEnv } from './config';
import type { ProxyPorts } from './install';
import { expireIfDue, recoverOnStart } from './pending';
import { createHelperServer } from './server';

/** How often the rollback deadline is checked when nothing is arriving. */
const SWEEP_INTERVAL_MS = 5000;

async function main(): Promise<void> {
  const env = readEnv(process.env);

  const ports: ProxyPorts = {
    reload: caddyReload(env.caddyAdminOrigin, env.caddyfilePath),
    servedFingerprint: tlsProbe(env.probeHost, env.probePort, env.probeServername),
    now: () => new Date(),
  };

  // Before anything else touches the directory, so the failure names the fix.
  await assertWritable(env.root, { mkdir, rm }, process.getuid?.() ?? 100);

  const adopted = await adoptExisting(env.root, new Date());
  if (adopted === 'adopted') {
    console.log('[cert-helper] adopted the certificate already installed in', env.root);
  }

  /*
   * BEFORE the listener opens.
   *
   * A pending state surviving a restart means nobody confirmed it before this
   * process went away. Serving a request first would let a client confirm an
   * install whose window expired while the helper was down — the clock nobody
   * was watching is not evidence (ADR-0017).
   */
  const recovered = await recoverOnStart(env.root, ports);
  if (recovered !== null) {
    console.warn(
      '[cert-helper] rolled back an unconfirmed certificate left by a previous run:',
      recovered.status,
    );
  }

  // Belt and braces with the per-request check in the server. A deployment
  // where nobody touches the console must still not keep an unconfirmed
  // certificate past its deadline.
  const sweep = setInterval(() => {
    void expireIfDue(env.root, ports).catch((error: unknown) => {
      console.error('[cert-helper] rollback sweep failed', error);
    });
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const server = createHelperServer({
    root: env.root,
    secret: env.secret,
    windowSeconds: env.windowSeconds,
    ports,
  });

  // Loopback would be wrong: the proxy reaches this over the Compose network.
  // It is not published to the host — see docker-compose.yml.
  server.listen(env.listenPort, '0.0.0.0', () => {
    console.log(
      `[cert-helper] listening on ${env.listenPort}, root ${env.root}, ` +
        `confirmation window ${env.windowSeconds}s`,
    );
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      clearInterval(sweep);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error('[cert-helper] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
