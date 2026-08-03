import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptExisting } from '../src/adopt';
import { CERT_FILE, KEY_FILE, LIVE_LINK } from '../src/install';
import { assertWritable, readEnv } from '../src/config';
import { makePair } from './fixtures';

jest.setTimeout(120_000);

const NOW = new Date('2026-08-02T12:00:00.000Z');

describe('adoptExisting', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexuspuppet-adopt-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves an existing hand-mounted certificate through the live link', async () => {
    // The upgrade path. Without this, the shipped Caddyfile points at
    // live/console.pem, that path does not exist, and the console goes down at
    // the moment of the upgrade — the exact failure this component exists to
    // prevent, introduced by its own arrival.
    const pair = makePair();
    await writeFile(join(root, CERT_FILE), pair.certPem);
    await writeFile(join(root, KEY_FILE), pair.keyPem);

    expect(await adoptExisting(root, NOW)).toBe('adopted');

    const target = await readlink(join(root, LIVE_LINK));
    expect(await readFile(join(root, target, CERT_FILE), 'utf8')).toBe(pair.certPem);
    expect(await readFile(join(root, target, KEY_FILE), 'utf8')).toBe(pair.keyPem);
  });

  it('leaves the originals in place, so the previous release still works', async () => {
    // Rolling back to a release whose Caddyfile reads these directly must not
    // find them gone.
    const pair = makePair();
    await writeFile(join(root, CERT_FILE), pair.certPem);
    await writeFile(join(root, KEY_FILE), pair.keyPem);

    await adoptExisting(root, NOW);

    expect(await readFile(join(root, CERT_FILE), 'utf8')).toBe(pair.certPem);
    expect(await readFile(join(root, KEY_FILE), 'utf8')).toBe(pair.keyPem);
  });

  it('does nothing when the helper already owns the directory', async () => {
    const pair = makePair();
    await writeFile(join(root, CERT_FILE), pair.certPem);
    await writeFile(join(root, KEY_FILE), pair.keyPem);
    await adoptExisting(root, NOW);
    const first = await readlink(join(root, LIVE_LINK));

    expect(await adoptExisting(root, new Date(NOW.getTime() + 60_000))).toBe('not-needed');
    expect(await readlink(join(root, LIVE_LINK))).toBe(first);
  });

  it('does not replace a dangling live link', async () => {
    // A broken pointer means a previous install went somewhere. Overwriting it
    // hides the breakage instead of leaving it visible to whoever fixes it.
    const pair = makePair();
    await writeFile(join(root, CERT_FILE), pair.certPem);
    await writeFile(join(root, KEY_FILE), pair.keyPem);
    await symlink('sets/gone', join(root, LIVE_LINK));

    expect(await adoptExisting(root, NOW)).toBe('not-needed');
    expect(await readlink(join(root, LIVE_LINK))).toBe('sets/gone');
  });

  it('does nothing on an empty directory', async () => {
    expect(await adoptExisting(root, NOW)).toBe('not-needed');
    await expect(lstat(join(root, LIVE_LINK))).rejects.toThrow();
  });

  it('does nothing when only half the pair is present', async () => {
    // A certificate with no key is not something to start serving.
    await writeFile(join(root, CERT_FILE), makePair().certPem);

    expect(await adoptExisting(root, NOW)).toBe('not-needed');
  });
});

describe('readEnv', () => {
  const base = { CERT_HELPER_SECRET: 'x'.repeat(48), CONSOLE_HOSTNAME: 'console.example.test' };

  it('refuses to start without a shared secret', () => {
    // A helper that cannot verify a grant can only accept everything or reject
    // everything. Failing at boot names the cause; failing later does not.
    expect(() => readEnv({ ...base, CERT_HELPER_SECRET: undefined })).toThrow(/CERT_HELPER_SECRET/);
    expect(() => readEnv({ ...base, CERT_HELPER_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('refuses to start without the console hostname', () => {
    // The probe opens a TLS connection to the proxy; without the expected name
    // that handshake reaches the wrong virtual host.
    expect(() => readEnv({ ...base, CONSOLE_HOSTNAME: undefined })).toThrow(/CONSOLE_HOSTNAME/);
  });

  it('defaults the confirmation window to 120 seconds', () => {
    expect(readEnv(base).windowSeconds).toBe(120);
  });

  it('takes the window from TLS_CONFIRM_TIMEOUT_SEC', () => {
    expect(readEnv({ ...base, TLS_CONFIRM_TIMEOUT_SEC: '300' }).windowSeconds).toBe(300);
  });

  it.each([['0'], ['-5'], ['abc'], ['1.5']])('refuses a nonsense window %p', (value) => {
    // Zero would roll back before the browser could possibly answer.
    expect(() => readEnv({ ...base, TLS_CONFIRM_TIMEOUT_SEC: value })).toThrow(
      /positive whole number/,
    );
  });
});

describe('assertWritable', () => {
  it('passes when the directory can be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexuspuppet-writable-'));
    await expect(assertWritable(root, { mkdir, rm }, 100)).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it('names the chown command when it cannot', async () => {
    // The failure an operator would otherwise meet halfway through installing a
    // certificate, as a bare EACCES from mkdir.
    const failing = {
      mkdir: async () => {
        throw new Error("EACCES: permission denied, mkdir '/etc/nexuspuppet/tls/.writable-probe'");
      },
      rm: async () => undefined,
    };

    await expect(assertWritable('/etc/nexuspuppet/tls', failing, 100)).rejects.toThrow(
      /chown -R 100:101 \/etc\/nexuspuppet\/tls/,
    );
  });
});
