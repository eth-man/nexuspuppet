import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PuppetDbClient, type PuppetDbClientOptions } from './puppetdb.client';

/**
 * "Last contact" must survive a restart.
 *
 * Production restarted during a PuppetDB outage and then told operators, for
 * three weeks, that PuppetDB "is not answering and never has" — while its own
 * ManagedNode rows had been projected from PuppetDB the day it went down. The
 * in-memory timestamp was the only source, and a restart erased it.
 *
 * Certificates that do not exist are the cheapest way to make every call fail
 * without a network: health() then reports unreachable, which is exactly the
 * state in which the recalled value matters.
 */
describe('PuppetDbClient last contact', () => {
  const missing = join(tmpdir(), 'nexuspuppet-no-such-dir');

  const client = (lastKnownContact?: PuppetDbClientOptions['lastKnownContact']) =>
    new PuppetDbClient({
      baseUrl: 'https://puppetdb.invalid:8081',
      certPath: join(missing, 'client.pem'),
      keyPath: join(missing, 'client.key'),
      caPath: join(missing, 'ca.pem'),
      timeoutMs: 1000,
      ...(lastKnownContact === undefined ? {} : { lastKnownContact }),
    });

  it('reports the recalled contact after a restart instead of "never"', async () => {
    const at = new Date('2026-08-20T16:00:49.973Z');
    const health = await client(() => Promise.resolve(at)).health();

    expect(health.reachable).toBe(false);
    expect(health.lastSuccessAt).toBe(at.toISOString());
  });

  it('carries the recalled contact on the error the inventory screens render', async () => {
    const at = new Date('2026-08-20T16:00:49.973Z');
    const c = client(() => Promise.resolve(at));

    await expect(c.listEnvironments()).rejects.toMatchObject({
      lastSuccessAt: at.toISOString(),
    });
  });

  it('says "never" only when there is genuinely nothing to recall', async () => {
    expect((await client(() => Promise.resolve(null)).health()).lastSuccessAt).toBeNull();
    expect((await client().health()).lastSuccessAt).toBeNull();
  });

  it('recalls once, not on every failing call', async () => {
    const recall = jest.fn(() => Promise.resolve(new Date('2026-08-20T16:00:00Z')));
    const c = client(recall);

    await c.health();
    await c.health();
    await c.health();

    expect(recall).toHaveBeenCalledTimes(1);
  });

  it('asks again after a failed recall rather than settling on "never"', async () => {
    const at = new Date('2026-08-20T16:00:00Z');
    const recall = jest
      .fn<Promise<Date | null>, []>()
      .mockRejectedValueOnce(new Error('database not ready'))
      .mockResolvedValue(at);
    const c = client(recall);

    expect((await c.health()).lastSuccessAt).toBeNull();
    expect((await c.health()).lastSuccessAt).toBe(at.toISOString());
    expect(recall).toHaveBeenCalledTimes(2);
  });
});
