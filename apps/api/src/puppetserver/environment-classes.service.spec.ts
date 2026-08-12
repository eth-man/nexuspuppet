import { PuppetServerUnavailableError, type IPuppetServerClient } from '@nexuspuppet/contracts';
import { EnvironmentClassesService } from './environment-classes.service';

/** One class, named so a test can tell two fetches apart. */
const bodyWith = (...names: string[]) => ({
  files: [{ path: '/m.pp', classes: names.map((name) => ({ name, params: [] })) }],
});

interface StubOptions {
  etag?: string | null;
  notModified?: boolean;
  delayMs?: number;
}

class StubClient implements IPuppetServerClient {
  calls: Array<{ environment: string; etag: string | null }> = [];
  private queue: Array<() => Promise<unknown> | unknown> = [];

  constructor(private readonly defaults: StubOptions = {}) {}

  /** Queue one response (or thrown error) for the next call. */
  next(fn: () => unknown): this {
    this.queue.push(fn);
    return this;
  }

  async listEnvironmentClasses(environment: string, etag: string | null) {
    this.calls.push({ environment, etag });
    const fn = this.queue.shift();
    const body = fn === undefined ? bodyWith('base') : await fn();

    if (this.defaults.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.defaults.delayMs));
    }

    if (this.defaults.notModified === true) {
      return { notModified: true, body: null, etag: this.defaults.etag ?? etag };
    }
    return { notModified: false, body, etag: this.defaults.etag ?? null };
  }
}

const service = (client: IPuppetServerClient | null, ttlMs = 60_000) =>
  new EnvironmentClassesService(client, { ttlMs, defaultEnvironment: 'production' });

describe('EnvironmentClassesService', () => {
  describe('when puppetserver is not configured', () => {
    /*
     * PUPPETSERVER_URL unset is OFF, and silent. An operator who never wants
     * NexusPuppet talking to their Puppet server should see today's behaviour
     * and no nagging (ADR-0024 §4).
     */
    it('reports disabled without an error message', async () => {
      const index = await service(null).index('production');

      expect(index.status).toBe('disabled');
      expect(index.classes).toEqual([]);
      expect(index.message).toBeUndefined();
    });
  });

  describe('caching', () => {
    it('serves the second call from cache without touching puppetserver', async () => {
      const client = new StubClient();
      const svc = service(client);

      await svc.index('production');
      const second = await svc.index('production');

      expect(client.calls).toHaveLength(1);
      expect(second.cached).toBe(true);
    });

    it('refetches once the entry is older than the TTL', async () => {
      const client = new StubClient();
      const svc = service(client, 0);

      await svc.index('production');
      await svc.index('production');

      expect(client.calls).toHaveLength(2);
    });

    /*
     * ADR-0024 §7. A global cache would show production's classes to a group
     * pinned to development — plausible-looking names, and a compile error
     * later on every node that group matches.
     */
    it('keys the cache by environment', async () => {
      const client = new StubClient();
      client.next(() => bodyWith('prod_only')).next(() => bodyWith('dev_only'));
      const svc = service(client);

      const prod = await svc.index('production');
      const dev = await svc.index('development');

      expect(prod.classes.map((c) => c.name)).toEqual(['prod_only']);
      expect(dev.classes.map((c) => c.name)).toEqual(['dev_only']);
      expect(client.calls.map((c) => c.environment)).toEqual(['production', 'development']);
    });
  });

  /*
   * ADR-0024 §7. The service owns the default so that "inherits" and "names it
   * explicitly" resolve through one path — two places defaulting independently
   * is how a picker ends up scoped to a different environment from its group.
   */
  describe('default environment', () => {
    it.each([
      ['undefined', undefined],
      ['an empty string', ''],
      ['whitespace', '   '],
    ])('falls back to the configured default for %s', async (_label, requested) => {
      const client = new StubClient();
      const index = await service(client).index(requested);

      expect(index.environment).toBe('production');
      expect(client.calls[0]?.environment).toBe('production');
    });

    it('uses an explicitly named environment, trimmed', async () => {
      const client = new StubClient();
      const index = await service(client).index('  staging  ');

      expect(index.environment).toBe('staging');
      expect(client.calls[0]?.environment).toBe('staging');
    });
  });

  /*
   * An uncached fetch reparses the whole environment and can take minutes.
   * Three operators opening the same page must produce ONE fetch.
   */
  describe('request coalescing', () => {
    it('collapses concurrent callers for one environment into a single fetch', async () => {
      const client = new StubClient({ delayMs: 10 });
      const svc = service(client);

      const results = await Promise.all([
        svc.index('production'),
        svc.index('production'),
        svc.index('production'),
      ]);

      expect(client.calls).toHaveLength(1);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
    });

    it('does not collapse across different environments', async () => {
      const client = new StubClient({ delayMs: 10 });
      const svc = service(client);

      await Promise.all([svc.index('production'), svc.index('development')]);

      expect(client.calls).toHaveLength(2);
    });

    it('allows a later fetch once the in-flight one settles', async () => {
      const client = new StubClient();
      const svc = service(client, 0);

      await svc.index('production');
      await svc.index('production');

      expect(client.calls).toHaveLength(2);
    });
  });

  describe('refresh', () => {
    it('bypasses a cache entry that is still fresh', async () => {
      const client = new StubClient();
      client.next(() => bodyWith('old')).next(() => bodyWith('old', 'new'));
      const svc = service(client);

      await svc.index('production');
      const refreshed = await svc.index('production', true);

      expect(client.calls).toHaveLength(2);
      expect(refreshed.classes.map((c) => c.name)).toEqual(['new', 'old']);
      expect(refreshed.unchangedAfterRefresh).toBeUndefined();
    });

    /*
     * THE TWO-CACHE TRAP (ADR-0024 §8). With environment-class-cache-enabled
     * on, puppetserver keeps serving pre-deployment classes until r10k flushes
     * its environment cache. The refresh then changes nothing and looks broken.
     * We cannot fix it — flushing is a mutation §2 forbids — so we must SAY it.
     */
    it('flags a refresh that produced an identical list', async () => {
      const client = new StubClient();
      client.next(() => bodyWith('same')).next(() => bodyWith('same'));
      const svc = service(client);

      await svc.index('production');
      const refreshed = await svc.index('production', true);

      expect(refreshed.unchangedAfterRefresh).toBe(true);
    });

    it('does not flag the very first fetch as unchanged', async () => {
      const svc = service(new StubClient());

      expect((await svc.index('production', true)).unchangedAfterRefresh).toBeUndefined();
    });
  });

  /*
   * ADR-0024 §9. Nothing on this path may prevent a classification write.
   */
  describe('degradation', () => {
    it('names the auth.conf fix on a 403 rather than reporting a bare refusal', async () => {
      const client = new StubClient();
      client.next(() => {
        throw new PuppetServerUnavailableError('puppetserver returned 403', { statusCode: 403 });
      });

      const index = await service(client).index('production');

      expect(index.status).toBe('forbidden');
      expect(index.message).toContain('auth.conf');
      expect(index.message).toContain('/puppet/v3/environment_classes');
    });

    it.each([
      ['a timeout', new PuppetServerUnavailableError('headers timeout')],
      ['a 500', new PuppetServerUnavailableError('returned 500', { statusCode: 500 })],
      ['a non-Error throw', 'something odd'],
    ])('reports %s as unavailable instead of throwing', async (_label, thrown) => {
      const client = new StubClient();
      client.next(() => {
        throw thrown;
      });

      const index = await service(client).index('production');

      expect(index.status).toBe('unavailable');
      expect(index.classes).toEqual([]);
      expect(index.message).toBeTruthy();
    });

    /*
     * A stale list beats no list: the operator can still recognise the class
     * they meant, and fetchedAt is shown so they can judge its age.
     */
    it('keeps serving the last good list when a later fetch fails', async () => {
      const client = new StubClient();
      client
        .next(() => bodyWith('known'))
        .next(() => {
          throw new PuppetServerUnavailableError('gone away');
        });
      const svc = service(client, 0);

      await svc.index('production');
      const degraded = await svc.index('production');

      expect(degraded.classes.map((c) => c.name)).toEqual(['known']);
      expect(degraded.status).toBe('unavailable');
      expect(degraded.message).toContain('last successful fetch');
      expect(degraded.fetchedAt).not.toBeNull();
    });

    it('does not leave a failed fetch stuck in flight', async () => {
      const client = new StubClient();
      client.next(() => {
        throw new PuppetServerUnavailableError('first fails');
      });
      const svc = service(client);

      await svc.index('production');
      const second = await svc.index('production');

      // A rejected promise left in the coalescing map would make every later
      // call return the same failure for ever.
      expect(client.calls).toHaveLength(2);
      expect(second.status).toBe('ok');
    });
  });

  describe('ETag revalidation, when the operator has enabled it', () => {
    it('sends the stored etag and keeps the parsed list on a 304', async () => {
      const client = new StubClient({ etag: 'abc', notModified: false });
      const svc = service(client, 0);
      await svc.index('production');

      const revalidating = new StubClient({ etag: 'abc', notModified: true });
      // Reuse the populated service by pointing it at a 304-answering client.
      Object.defineProperty(svc, 'client', { value: revalidating });

      const index = await svc.index('production');

      expect(revalidating.calls[0]?.etag).toBe('abc');
      expect(index.classes.map((c) => c.name)).toEqual(['base']);
    });
  });
});
