import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PuppetDbClient } from './puppetdb.client';

/**
 * What an operator is told when the certificates cannot be read.
 *
 * This is the failure a first deployment actually hits: the container runs as a
 * non-root uid, so the natural `install -o root -g root` leaves a key that
 * exists, is named correctly, has mode 0600 — and is unreadable. From the
 * console it appears only as "PuppetDB unreachable", which sends people to
 * inspect firewalls and certificates rather than ownership.
 *
 * These assert the MESSAGE, not just that it throws, because the message is the
 * entire feature.
 */

const isRoot = process.getuid?.() === 0;

describe('PuppetDbClient certificate diagnostics', () => {
  let dir: string;

  const client = (over: Partial<Record<'cert' | 'key' | 'ca', string>> = {}) =>
    new PuppetDbClient({
      baseUrl: 'https://puppetdb.invalid:8081',
      certPath: over.cert ?? join(dir, 'client.pem'),
      keyPath: over.key ?? join(dir, 'client.key'),
      caPath: over.ca ?? join(dir, 'ca.pem'),
      timeoutMs: 1000,
    });

  /**
   * The message as an operator actually receives it.
   *
   * health() reports rather than throws, and its `error` string is what the
   * system-status card renders — so this asserts the exact text that reaches a
   * human, not an internal exception they never see.
   */
  const provoke = async (c: PuppetDbClient): Promise<string> => {
    const health = await c.health();
    expect(health.reachable).toBe(false);
    if (health.error === undefined) throw new Error('expected an error string in health()');
    return health.error;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexuspuppet-certs-'));
    for (const name of ['client.pem', 'client.key', 'ca.pem']) {
      writeFileSync(join(dir, name), '-----BEGIN CERTIFICATE-----\n', { mode: 0o600 });
    }
  });

  afterEach(() => {
    // Restore modes first: a 0000 file inside the tree would defeat the cleanup.
    for (const name of ['client.pem', 'client.key', 'ca.pem']) {
      try {
        chmodSync(join(dir, name), 0o600);
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the missing file, and says which of the three it is', async () => {
    const message = await provoke(client({ key: join(dir, 'absent.key') }));

    expect(message).toContain('client key');
    expect(message).toContain('absent.key');
    expect(message).toContain('not found');
  });

  it('blames the KEY when the key is missing, not the certificate', async () => {
    // The regression this guards: all three were read under one Promise.all and
    // the message hardcoded certPath, so an unreadable key sent operators to
    // look at client.pem — a file that was perfectly fine.
    const message = await provoke(client({ key: join(dir, 'absent.key') }));

    expect(message).not.toContain('client.pem');
  });

  (isRoot ? it.skip : it)(
    'distinguishes "unreadable" from "missing", and points at ownership',
    async () => {
      chmodSync(join(dir, 'client.key'), 0o000);

      const message = await provoke(client());

      expect(message).toContain('exists but is not readable');
      expect(message).toContain('client.key');
      expect(message).toMatch(/uid \d+/);
      expect(message).toContain('DEPLOYMENT.md');
      // The trap worth naming: the container gid maps to an unrelated host
      // group, which differs between distributions.
      expect(message).toContain('gid');
    },
  );

  it('still says classification is unaffected — the ENC does not need PuppetDB', async () => {
    const message = await provoke(client({ ca: join(dir, 'absent.pem') }));

    expect(message).toContain('classification is unaffected');
  });

  it('caches the failure rather than re-reading the filesystem per request', async () => {
    const c = client({ cert: join(dir, 'absent.pem') });

    const first = await provoke(c);
    const second = await provoke(c);

    expect(second).toBe(first);
  });
});
