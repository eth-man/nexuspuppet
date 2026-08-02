import { X509Certificate } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CERT_FILE, KEY_FILE, LIVE_LINK, type ProxyPorts, installBundle } from '../src/install';
import { makePair } from './fixtures';

jest.setTimeout(120_000); // openssl genpkey, several pairs

const inside = (issuedAt: Date) => new Date(issuedAt.getTime() + 60_000);

function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

/**
 * A proxy that serves whatever the live symlink pointed at when it last
 * reloaded — which is what a real one does, and the reason a probe is worth
 * running at all.
 */
function workingProxy(root: string, now: Date) {
  let servedAt: string | null = null;
  const ports: ProxyPorts = {
    reload: async () => {
      const target = await readlink(join(root, LIVE_LINK));
      servedAt = await readFile(join(root, target, CERT_FILE), 'utf8');
    },
    servedFingerprint: async () => {
      if (servedAt === null) throw new Error('nothing loaded');
      return fingerprint(servedAt);
    },
    now: () => now,
  };
  return ports;
}

describe('installBundle', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexuspuppet-install-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs, and points live at the new material', async () => {
    const pair = makePair();
    const ports = workingProxy(root, inside(pair.issuedAt));

    const outcome = await installBundle(root, pair.certPem, pair.keyPem, ports);

    expect(outcome.status).toBe('installed');
    const target = await readlink(join(root, LIVE_LINK));
    expect(await readFile(join(root, target, CERT_FILE), 'utf8')).toBe(pair.certPem);
    expect(await readFile(join(root, target, KEY_FILE), 'utf8')).toBe(pair.keyPem);
  });

  it('writes the key unreadable to anyone but its owner', async () => {
    const pair = makePair();

    await installBundle(root, pair.certPem, pair.keyPem, workingProxy(root, inside(pair.issuedAt)));

    const target = await readlink(join(root, LIVE_LINK));
    const mode = (await stat(join(root, target, KEY_FILE))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('swaps through a symlink, so certificate and key move as one', async () => {
    // Two renames are two moments; a crash between them leaves a mismatched
    // pair, which is precisely the state that makes the console unreachable.
    const pair = makePair();

    await installBundle(root, pair.certPem, pair.keyPem, workingProxy(root, inside(pair.issuedAt)));

    expect((await lstat(join(root, LIVE_LINK))).isSymbolicLink()).toBe(true);
  });

  it('leaves the previous certificate serving when the swap itself fails', async () => {
    /*
     * Pins the MECHANISM, not just the result.
     *
     * An earlier version of this suite passed against an implementation that
     * replaced `rm(live); symlink(live)` for the staging-and-rename — which
     * still produces a symlink, and still passes a test that only asks whether
     * one exists, while leaving a window where `live` does not exist at all.
     *
     * Blocking the staging path makes the two behave differently: the real
     * implementation fails before touching `live`, the unlink-first one
     * succeeds by destroying it first. Proving true atomicity needs a crash at
     * the right instant; this proves the ordering that makes atomicity
     * possible.
     */
    const first = makePair({ subject: '/CN=first.example.test' });
    const second = makePair({ subject: '/CN=second.example.test' });
    const now = inside(first.issuedAt);
    const ports = workingProxy(root, now);
    await installBundle(root, first.certPem, first.keyPem, ports);

    // rm() refuses a directory without `recursive`, so the staging step throws.
    await mkdir(join(root, `.${LIVE_LINK}.staging`), { recursive: true });

    const outcome = await installBundle(root, second.certPem, second.keyPem, ports);

    expect(outcome.status).toBe('rolled-back');
    const target = await readlink(join(root, LIVE_LINK));
    expect(await readFile(join(root, target, CERT_FILE), 'utf8')).toBe(first.certPem);
  });

  it('refuses a bad bundle without touching the live link', async () => {
    const a = makePair({ subject: '/CN=a.example.test' });
    const b = makePair({ subject: '/CN=b.example.test' });
    const ports = workingProxy(root, inside(a.issuedAt));
    await installBundle(root, a.certPem, a.keyPem, ports);
    const before = await readlink(join(root, LIVE_LINK));

    const outcome = await installBundle(root, a.certPem, b.keyPem, ports);

    expect(outcome).toMatchObject({ status: 'rejected', rejection: { reason: 'mismatch' } });
    expect(await readlink(join(root, LIVE_LINK))).toBe(before);
  });

  describe('when the new certificate does not take', () => {
    it('rolls back when the proxy serves something else', async () => {
      // The case a write-and-hope install cannot detect: the reload reports
      // success and the listener is still on the old material.
      const first = makePair({ subject: '/CN=first.example.test' });
      const second = makePair({ subject: '/CN=second.example.test' });
      const now = inside(first.issuedAt);

      const ports = workingProxy(root, now);
      await installBundle(root, first.certPem, first.keyPem, ports);

      const stuck: ProxyPorts = {
        ...ports,
        reload: async () => {}, // pretends to reload, changes nothing
        servedFingerprint: async () => fingerprint(first.certPem),
        now: () => now,
      };

      const outcome = await installBundle(root, second.certPem, second.keyPem, stuck);

      expect(outcome.status).toBe('rolled-back');
      const target = await readlink(join(root, LIVE_LINK));
      expect(await readFile(join(root, target, CERT_FILE), 'utf8')).toBe(first.certPem);
    });

    it('rolls back when the reload itself fails', async () => {
      const first = makePair({ subject: '/CN=first.example.test' });
      const second = makePair({ subject: '/CN=second.example.test' });
      const now = inside(first.issuedAt);
      const ports = workingProxy(root, now);
      await installBundle(root, first.certPem, first.keyPem, ports);

      let calls = 0;
      const failing: ProxyPorts = {
        ...ports,
        reload: async () => {
          calls += 1;
          if (calls === 1) throw new Error('caddy refused the config');
          await ports.reload();
        },
        now: () => now,
      };

      const outcome = await installBundle(root, second.certPem, second.keyPem, failing);

      expect(outcome).toMatchObject({ status: 'rolled-back' });
      const target = await readlink(join(root, LIVE_LINK));
      expect(await readFile(join(root, target, CERT_FILE), 'utf8')).toBe(first.certPem);
    });

    it('reports rollback-failed when the restore does not serve either', async () => {
      // The one outcome whose answer is "go to the host", so it must be
      // distinguishable from an ordinary rollback rather than folded into it.
      const first = makePair({ subject: '/CN=first.example.test' });
      const second = makePair({ subject: '/CN=second.example.test' });
      const now = inside(first.issuedAt);
      const ports = workingProxy(root, now);
      await installBundle(root, first.certPem, first.keyPem, ports);

      const broken: ProxyPorts = {
        ...ports,
        reload: async () => {},
        servedFingerprint: async () => fingerprint(makePair({ subject: '/CN=other' }).certPem),
        now: () => now,
      };

      const outcome = await installBundle(root, second.certPem, second.keyPem, broken);

      expect(outcome.status).toBe('rollback-failed');
      if (outcome.status !== 'rollback-failed') return;
      expect(outcome.detail).toMatch(/host/i);
    });

    it('says there is nothing to restore on a first install', async () => {
      const pair = makePair();
      const now = inside(pair.issuedAt);
      const failing: ProxyPorts = {
        reload: async () => {
          throw new Error('caddy is not running');
        },
        servedFingerprint: async () => 'unused',
        now: () => now,
      };

      const outcome = await installBundle(root, pair.certPem, pair.keyPem, failing);

      expect(outcome.status).toBe('rollback-failed');
      if (outcome.status !== 'rollback-failed') return;
      expect(outcome.detail).toMatch(/nothing to restore/i);
    });
  });

  it('keeps a few old sets and prunes the rest', async () => {
    // Kept so a human can recover by hand. One spare is not enough: the case
    // that needs recovery is two bad installs in a row.
    const pairs = Array.from({ length: 7 }, (_, i) =>
      makePair({ subject: `/CN=n${i}.example.test` }),
    );
    const now = inside(pairs[0]!.issuedAt);

    for (const pair of pairs) {
      const ports = workingProxy(root, now);
      await installBundle(root, pair.certPem, pair.keyPem, ports);
    }

    const sets = await readdir(join(root, 'sets'));
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(sets.length).toBeLessThan(pairs.length);

    // Whatever was pruned, the live one survived.
    const target = await readlink(join(root, LIVE_LINK));
    await expect(readFile(join(root, target, CERT_FILE), 'utf8')).resolves.toBe(
      pairs[pairs.length - 1]!.certPem,
    );
  });
});

describe('the probe is compared against the file on disk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexuspuppet-ondisk-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses when the installed file stops matching what the listener serves', async () => {
    /*
     * The requirement: compare the peer certificate to the fingerprint of the
     * .crt ON DISK, not to the copy parsed at upload time.
     *
     * Those agree right up until something changes the file, and an
     * implementation that compares its own memory to itself passes every other
     * test in this suite while checking nothing. Here the proxy loads the
     * certificate and the file is then replaced underneath it, so the listener
     * and the disk genuinely disagree — which is the only condition that tells
     * the two implementations apart.
     */
    const baseline = makePair({ subject: '/CN=baseline.example.test' });
    const wanted = makePair({ subject: '/CN=wanted.example.test' });
    const intruder = makePair({ subject: '/CN=intruder.example.test' });
    const now = inside(baseline.issuedAt);

    const ports = workingProxy(root, now);
    await installBundle(root, baseline.certPem, baseline.keyPem, ports);

    let served: string | null = null;
    const tampering: ProxyPorts = {
      now: () => now,
      reload: async () => {
        const target = await readlink(join(root, LIVE_LINK));
        // Loaded by the proxy...
        served = await readFile(join(root, target, CERT_FILE), 'utf8');
        // ...and then the file underneath it changes.
        await writeFile(join(root, target, CERT_FILE), intruder.certPem);
      },
      servedFingerprint: async () => {
        if (served === null) throw new Error('nothing loaded');
        return fingerprint(served);
      },
    };

    const outcome = await installBundle(root, wanted.certPem, wanted.keyPem, tampering);

    expect(outcome.status).toBe('rolled-back');
    if (outcome.status !== 'rolled-back') return;
    expect(outcome.reason).toMatch(/installed on disk/i);
    expect(
      await readFile(join(root, await readlink(join(root, LIVE_LINK))), 'utf8').catch(() => ''),
    ).toBeDefined();
  });
});
