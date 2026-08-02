import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CERT_FILE, LIVE_LINK, type ProxyPorts } from '../src/install';
import { mintGrant } from '@nexuspuppet/tls-grant';
import { createHelperServer } from '../src/server';
import { makePair } from './fixtures';

jest.setTimeout(180_000);

const SECRET = 'c'.repeat(48);
const inside = (issuedAt: Date) => new Date(issuedAt.getTime() + 60_000);
const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;

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

describe('helper HTTP surface', () => {
  const first = makePair({ subject: '/CN=first.example.test' });
  const second = makePair({ subject: '/CN=second.example.test' });

  let root: string;
  let clock: { now: Date };
  let server: Server;
  let origin: string;

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const liveCert = async () =>
    readFile(join(root, await readlink(join(root, LIVE_LINK)), CERT_FILE), 'utf8');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexuspuppet-server-'));
    clock = { now: inside(first.issuedAt) };
    server = createHelperServer({
      root,
      secret: SECRET,
      windowSeconds: 120,
      ports: proxyAt(root, clock),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

    // A confirmed baseline to roll back to.
    const grant = mintGrant(SECRET, clock.now);
    const staged = await post('/console-tls/install', {
      grant,
      certificate: first.certPem,
      privateKey: first.keyPem,
    });
    await post('/console-tls/confirm', { confirmationToken: staged.body['confirmationToken'] });
  });

  afterEach(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('answers 202, not 200, for an install that is not yet committed', async () => {
    // The status code carries the meaning: serving, but it will be undone
    // unless a browser vouches for it.
    const res = await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: second.certPem,
      privateKey: second.keyPem,
    });

    expect(res.status).toBe(202);
    expect(res.body['status']).toBe('pending');
    expect(typeof res.body['confirmationToken']).toBe('string');
    expect(typeof res.body['expiresAt']).toBe('string');
  });

  it('commits when the client confirms', async () => {
    const staged = await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: second.certPem,
      privateKey: second.keyPem,
    });

    const res = await post('/console-tls/confirm', {
      confirmationToken: staged.body['confirmationToken'],
    });

    expect(res.status).toBe(200);
    expect(res.body['status']).toBe('confirmed');
    expect(await liveCert()).toBe(second.certPem);
  });

  it('rolls back on the next request once the window has closed', async () => {
    // Checked per request as well as on a timer: a helper whose timer was
    // starved must not commit an install by omission.
    await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: second.certPem,
      privateKey: second.keyPem,
    });
    clock.now = new Date(clock.now.getTime() + 121_000);

    const res = await fetch(`${origin}/console-tls/status`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['pending']).toBeNull();
    expect(await liveCert()).toBe(first.certPem);
  });

  describe('the grant', () => {
    it('refuses an install with no grant', async () => {
      const res = await post('/console-tls/install', {
        certificate: second.certPem,
        privateKey: second.keyPem,
      });

      expect(res.status).toBe(400);
      expect(await liveCert()).toBe(first.certPem);
    });

    it('refuses one signed with the wrong key', async () => {
      const res = await post('/console-tls/install', {
        grant: mintGrant('d'.repeat(48), clock.now),
        certificate: second.certPem,
        privateKey: second.keyPem,
      });

      expect(res.status).toBe(403);
      expect(await liveCert()).toBe(first.certPem);
    });

    it('refuses an expired one', async () => {
      const grant = mintGrant(SECRET, clock.now, undefined, 60);
      clock.now = new Date(clock.now.getTime() + 61_000);

      const res = await post('/console-tls/install', {
        grant,
        certificate: second.certPem,
        privateKey: second.keyPem,
      });

      expect(res.status).toBe(403);
    });

    it('refuses a replay of one already spent', async () => {
      const grant = mintGrant(SECRET, clock.now);
      const staged = await post('/console-tls/install', {
        grant,
        certificate: second.certPem,
        privateKey: second.keyPem,
      });
      await post('/console-tls/confirm', { confirmationToken: staged.body['confirmationToken'] });

      const replay = await post('/console-tls/install', {
        grant,
        certificate: first.certPem,
        privateKey: first.keyPem,
      });

      expect(replay.status).toBe(403);
      expect(await liveCert()).toBe(second.certPem);
    });

    it('gives the same answer whatever is wrong with it', async () => {
      // Distinguishing expired from forged tells an attacker which half to
      // work on.
      const forged = await post('/console-tls/install', {
        grant: mintGrant('d'.repeat(48), clock.now),
        certificate: second.certPem,
        privateKey: second.keyPem,
      });
      const expiredGrant = mintGrant(SECRET, clock.now, undefined, 1);
      clock.now = new Date(clock.now.getTime() + 5000);
      const expired = await post('/console-tls/install', {
        grant: expiredGrant,
        certificate: second.certPem,
        privateKey: second.keyPem,
      });

      expect(forged.body).toEqual(expired.body);
    });
  });

  it('reports a rejected bundle as 422, with the reason', async () => {
    const res = await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: second.certPem,
      privateKey: first.keyPem,
    });

    expect(res.status).toBe(422);
    expect(res.body['rejection']).toMatchObject({ reason: 'mismatch' });
    expect(await liveCert()).toBe(first.certPem);
  });

  it('refuses a confirmation with the wrong token and keeps the install pending', async () => {
    await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: second.certPem,
      privateKey: second.keyPem,
    });

    const res = await post('/console-tls/confirm', { confirmationToken: 'nope' });

    expect(res.status).toBe(403);
    expect(await liveCert()).toBe(second.certPem);
  });

  it('answers 410 for a confirmation that arrives too late', async () => {
    const staged = await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: second.certPem,
      privateKey: second.keyPem,
    });
    clock.now = new Date(clock.now.getTime() + 121_000);

    const res = await post('/console-tls/confirm', {
      confirmationToken: staged.body['confirmationToken'],
    });

    expect(res.status).toBe(410);
    expect(await liveCert()).toBe(first.certPem);
  });

  it('exposes no way to read the certificate or key', async () => {
    // Compromising this process must yield the ability to REPLACE the console's
    // certificate, not to steal the one it holds.
    for (const path of ['/console-tls/certificate', '/console-tls/key', '/live/console.key', '/']) {
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    }

    const status = await (await fetch(`${origin}/console-tls/status`)).json();
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
  });

  it('refuses an oversized body with an answer, not a dropped connection', async () => {
    // Destroying the socket makes a refusal look like a network fault, and the
    // operator goes looking for the wrong problem.
    const res = await post('/console-tls/install', {
      grant: mintGrant(SECRET, clock.now),
      certificate: 'x'.repeat(300 * 1024),
      privateKey: second.keyPem,
    });

    expect(res.status).toBe(413);
    expect(String(res.body['message'])).toMatch(/larger than/i);
    expect(await liveCert()).toBe(first.certPem);
  });
});
