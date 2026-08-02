import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CERT_FILE, LIVE_LINK, type ProxyPorts } from '../src/install';
import {
  PENDING_FILE,
  confirmPending,
  expireIfDue,
  readPending,
  recoverOnStart,
  stageBundle,
} from '../src/pending';
import { makePair } from './fixtures';

jest.setTimeout(180_000);

const inside = (issuedAt: Date) => new Date(issuedAt.getTime() + 60_000);
const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;

/** A proxy that serves whatever `live` pointed at when it last reloaded. */
function proxyAt(root: string, clock: { now: Date }): ProxyPorts {
  let servedAt: string | null = null;
  return {
    reload: async () => {
      const target = await readlink(join(root, LIVE_LINK));
      servedAt = await readFile(join(root, target, CERT_FILE), 'utf8');
    },
    servedFingerprint: async () => {
      if (servedAt === null) throw new Error('nothing loaded');
      return fingerprint(servedAt);
    },
    now: () => clock.now,
  };
}

async function liveCert(root: string): Promise<string> {
  const target = await readlink(join(root, LIVE_LINK));
  return readFile(join(root, target, CERT_FILE), 'utf8');
}

/**
 * Commit-confirm (ADR-0017).
 *
 * A staged install is NOT success. It is "serving, and it will be undone unless
 * a client vouches for it" — because the thing that locks an operator out is a
 * certificate their browser will not trust, and no check inside the deployment
 * can see that.
 */
describe('commit-confirm', () => {
  let root: string;
  let clock: { now: Date };

  const first = makePair({ subject: '/CN=first.example.test' });
  const second = makePair({ subject: '/CN=second.example.test' });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexuspuppet-pending-'));
    clock = { now: inside(first.issuedAt) };
    // An established, confirmed baseline to roll back to.
    const ports = proxyAt(root, clock);
    const staged = await stageBundle(root, first.certPem, first.keyPem, ports);
    if (staged.status !== 'pending') throw new Error(`baseline failed: ${staged.status}`);
    await confirmPending(root, staged.token, ports);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stages without committing, and holds a token', async () => {
    const ports = proxyAt(root, clock);

    const staged = await stageBundle(root, second.certPem, second.keyPem, ports);

    expect(staged.status).toBe('pending');
    if (staged.status !== 'pending') return;
    expect(staged.token).toHaveLength(43); // 32 bytes, base64url
    expect(await liveCert(root)).toBe(second.certPem);
    expect(await readPending(root)).not.toBeNull();
  });

  it('never writes the token itself to disk', async () => {
    // Reading the pending file must not yield the ability to confirm someone
    // else's install.
    const ports = proxyAt(root, clock);
    const staged = await stageBundle(root, second.certPem, second.keyPem, ports);
    if (staged.status !== 'pending') return;

    const raw = await readFile(join(root, PENDING_FILE), 'utf8');

    expect(raw).not.toContain(staged.token);
    expect((await stat(join(root, PENDING_FILE))).mode & 0o777).toBe(0o600);
  });

  it('commits when the client presents the token in time', async () => {
    const ports = proxyAt(root, clock);
    const staged = await stageBundle(root, second.certPem, second.keyPem, ports);
    if (staged.status !== 'pending') return;

    const outcome = await confirmPending(root, staged.token, ports);

    expect(outcome.status).toBe('confirmed');
    expect(await liveCert(root)).toBe(second.certPem);
    expect(await readPending(root)).toBeNull();
  });

  it('rolls back when the window closes with nobody confirming', async () => {
    // The case the whole design exists for: the certificate loaded fine inside
    // the deployment and the operator's browser would not accept it, so no
    // confirmation ever arrives.
    const ports = proxyAt(root, clock);
    await stageBundle(root, second.certPem, second.keyPem, ports, 120);

    clock.now = new Date(clock.now.getTime() + 121_000);
    const rolled = await expireIfDue(root, ports);

    expect(rolled).toMatchObject({ status: 'rolled-back' });
    expect(await liveCert(root)).toBe(first.certPem);
    expect(await readPending(root)).toBeNull();
  });

  it('does not roll back while the window is open', async () => {
    const ports = proxyAt(root, clock);
    await stageBundle(root, second.certPem, second.keyPem, ports, 120);

    clock.now = new Date(clock.now.getTime() + 119_000);

    expect(await expireIfDue(root, ports)).toBeNull();
    expect(await liveCert(root)).toBe(second.certPem);
  });

  it('refuses a late confirmation and rolls back anyway', async () => {
    // Holding the right token does not make a late caller on time.
    const ports = proxyAt(root, clock);
    const staged = await stageBundle(root, second.certPem, second.keyPem, ports, 120);
    if (staged.status !== 'pending') return;

    clock.now = new Date(clock.now.getTime() + 121_000);
    const outcome = await confirmPending(root, staged.token, ports);

    expect(outcome.status).toBe('expired');
    expect(await liveCert(root)).toBe(first.certPem);
  });

  it('refuses a wrong token without rolling back', async () => {
    // A bad token is not a reason to undo a good install; the clock still runs.
    const ports = proxyAt(root, clock);
    await stageBundle(root, second.certPem, second.keyPem, ports);

    const outcome = await confirmPending(root, 'not-the-token', ports);

    expect(outcome.status).toBe('token-mismatch');
    expect(await liveCert(root)).toBe(second.certPem);
    expect(await readPending(root)).not.toBeNull();
  });

  it('treats a second confirmation as a no-op', async () => {
    const ports = proxyAt(root, clock);
    const staged = await stageBundle(root, second.certPem, second.keyPem, ports);
    if (staged.status !== 'pending') return;
    await confirmPending(root, staged.token, ports);

    expect(await confirmPending(root, staged.token, ports)).toMatchObject({
      status: 'nothing-pending',
    });
    expect(await liveCert(root)).toBe(second.certPem);
  });

  it('rolls back an install left pending by a crash, whatever the clock says', async () => {
    // The failure the file exists to catch. An in-memory timer dies with the
    // process, and the window is NOT waited out: time spent crashed is not time
    // an operator spent looking at a working console.
    const ports = proxyAt(root, clock);
    await stageBundle(root, second.certPem, second.keyPem, ports, 120);
    expect(await liveCert(root)).toBe(second.certPem);

    // Restart, one second later — well inside the window.
    clock.now = new Date(clock.now.getTime() + 1000);
    const recovered = await recoverOnStart(root, proxyAt(root, clock));

    expect(recovered).toMatchObject({ status: 'rolled-back' });
    expect(await liveCert(root)).toBe(first.certPem);
  });

  it('undoes an abandoned install before starting another', async () => {
    // Two pending states cannot coexist: the second would overwrite the first's
    // rollback target and strand it, leaving nothing to return to.
    const third = makePair({ subject: '/CN=third.example.test' });
    const ports = proxyAt(root, clock);
    await stageBundle(root, second.certPem, second.keyPem, ports);

    const staged = await stageBundle(root, third.certPem, third.keyPem, ports);

    expect(staged.status).toBe('pending');
    const pending = await readPending(root);
    // Rolling back the third must return to the confirmed baseline, not to the
    // abandoned second.
    expect(pending?.previousFingerprint).toBe(fingerprint(first.certPem));
  });

  it('leaves nothing pending when the install is rejected outright', async () => {
    const ports = proxyAt(root, clock);

    const outcome = await stageBundle(root, second.certPem, first.keyPem, ports);

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(await readPending(root)).toBeNull();
    expect(await liveCert(root)).toBe(first.certPem);
  });
});
