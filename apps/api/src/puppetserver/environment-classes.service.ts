import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  PUPPETSERVER_CLIENT,
  PuppetServerUnavailableError,
  type ClassIndex,
  type IPuppetServerClient,
} from '@nexuspuppet/contracts';
import {
  parseEnvironmentClasses,
  type ParsedEnvironmentClasses,
} from './parse-environment-classes';

/**
 * Per-environment cache of class suggestions (ADR-0024 §7, §8).
 *
 * KEYED BY ENVIRONMENT, NEVER GLOBAL. Classes, parameters and defaults all
 * differ between environments, and showing production's classes to a group
 * pinned to development is wrong in the way that is hardest to notice: every
 * name looks plausible, and the failure surfaces later as a compile error on
 * the nodes that group matches. Foreman's Smart Proxy keys every cache the same
 * way.
 *
 * REQUESTS ARE COALESCED. An uncached fetch reparses the whole environment and
 * can take minutes; three operators opening the same page must produce ONE
 * fetch, not three. Smart Proxy holds a futures cache for exactly this.
 *
 * NOTHING HERE THROWS AT ITS CALLER. Every failure becomes a ClassIndex with a
 * status and an operator-facing message, because a suggestion source must never
 * be able to fail a write (ADR-0024 §9).
 */

interface CacheEntry {
  parsed: ParsedEnvironmentClasses;
  etag: string | null;
  fetchedAt: string;
  /** Cheap identity for "did a refresh actually change anything?" (§8). */
  signature: string;
}

export interface EnvironmentClassesOptions {
  ttlMs: number;
  /**
   * Used when a group does not set an environment of its own.
   *
   * Owned here rather than at the call site so that "inherits" and "names it
   * explicitly" resolve through one path — two places defaulting independently
   * is how a picker ends up scoped to a different environment from the group.
   */
  defaultEnvironment: string;
}

@Injectable()
export class EnvironmentClassesService {
  private readonly logger = new Logger(EnvironmentClassesService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();

  constructor(
    @Optional()
    @Inject(PUPPETSERVER_CLIENT)
    private readonly client: IPuppetServerClient | null,
    private readonly options: EnvironmentClassesOptions,
  ) {}

  /**
   * @param refresh discard any cached entry and refetch — the operator pressed
   * Refresh because they just deployed code (ADR-0024 §8).
   */
  async index(requested: string | undefined, refresh = false): Promise<ClassIndex> {
    const environment =
      requested !== undefined && requested.trim() !== ''
        ? requested.trim()
        : this.options.defaultEnvironment;

    // PUPPETSERVER_URL unset. Off, and silent: an operator who never wants
    // NexusPuppet talking to their Puppet server is not nagged about it.
    if (this.client === null) {
      return this.empty(environment, 'disabled');
    }

    const previous = this.cache.get(environment);

    if (!refresh) {
      const fresh = this.freshEntry(environment);
      if (fresh !== null) return this.toIndex(environment, fresh, true);
    }

    let entry: CacheEntry;
    try {
      entry = await this.fetch(environment, refresh);
    } catch (error) {
      return this.failure(environment, error, previous);
    }

    const index = this.toIndex(environment, entry, false);

    // THE TWO-CACHE TRAP (§8). With `environment-class-cache-enabled` on,
    // puppetserver serves its own cached classes until its environment cache is
    // flushed — normally by r10k. A refresh then returns an identical list and
    // looks broken. We do not call puppet-admin-api to fix it (a mutation §2
    // forbids); we say so, so the operator learns something instead of filing a
    // bug against us for someone else's cache.
    if (refresh && previous !== undefined && previous.signature === entry.signature) {
      return { ...index, unchangedAfterRefresh: true };
    }

    return index;
  }

  private freshEntry(environment: string): CacheEntry | null {
    const entry = this.cache.get(environment);
    if (entry === undefined) return null;
    const age = Date.now() - Date.parse(entry.fetchedAt);
    return age < this.options.ttlMs ? entry : null;
  }

  private async fetch(environment: string, refresh: boolean): Promise<CacheEntry> {
    // Coalesce. A second caller for the same environment joins the fetch
    // already running rather than starting another.
    //
    // A refresh deliberately joins an in-flight fetch too: it started after the
    // operator's deploy either way, so its result is what they asked for, and
    // two concurrent full reparses of one environment is the stampede this map
    // exists to prevent.
    const existing = this.inFlight.get(environment);
    if (existing !== undefined) return existing;

    const previous = refresh ? undefined : this.cache.get(environment);

    const promise = this.fetchUncoalesced(environment, previous)
      .then((entry) => {
        this.cache.set(environment, entry);
        return entry;
      })
      .finally(() => {
        this.inFlight.delete(environment);
      });

    this.inFlight.set(environment, promise);
    return promise;
  }

  private async fetchUncoalesced(
    environment: string,
    previous: CacheEntry | undefined,
  ): Promise<CacheEntry> {
    // Not asserted non-null by the caller's check alone — this runs inside a
    // promise created earlier, and the field is readonly, so narrowing here is
    // explicit rather than assumed.
    const client = this.client;
    if (client === null)
      throw new PuppetServerUnavailableError('No puppetserver client configured');

    const result = await client.listEnvironmentClasses(environment, previous?.etag ?? null);

    // 304: puppetserver confirms our copy is current. Only reachable when the
    // operator enabled the server-side class cache; without it we always get a
    // 200 and reparse.
    if (result.notModified && previous !== undefined) {
      return {
        ...previous,
        etag: result.etag ?? previous.etag,
        fetchedAt: new Date().toISOString(),
      };
    }

    const parsed = parseEnvironmentClasses(result.body);
    return {
      parsed,
      etag: result.etag,
      fetchedAt: new Date().toISOString(),
      signature: this.signatureOf(parsed),
    };
  }

  /**
   * Identity of a fetched list, for detecting a refresh that changed nothing.
   *
   * Names and parameter names only — enough to notice deployed code, cheap
   * enough to compute on every fetch, and insensitive to the ordering
   * puppetserver returns because the parser has already sorted.
   */
  private signatureOf(parsed: ParsedEnvironmentClasses): string {
    return parsed.classes
      .map((c) => `${c.name}(${c.params.map((p) => p.name).join(',')})`)
      .join('|');
  }

  private toIndex(environment: string, entry: CacheEntry, cached: boolean): ClassIndex {
    return {
      status: 'ok',
      environment,
      classes: entry.parsed.classes,
      fileErrors: entry.parsed.fileErrors,
      fetchedAt: entry.fetchedAt,
      cached,
    };
  }

  /**
   * A failed fetch is a DEGRADED SUGGESTION, never a failed request.
   *
   * A stale list beats no list: the operator can still recognise the class they
   * meant, and the age is shown so they can judge it. Only when nothing has ever
   * been fetched does the picker fall back to free text entirely.
   */
  private failure(
    environment: string,
    error: unknown,
    previous: CacheEntry | undefined,
  ): ClassIndex {
    const statusCode = error instanceof PuppetServerUnavailableError ? error.statusCode : null;
    const detail = error instanceof Error ? error.message : String(error);

    const status = statusCode === 403 ? 'forbidden' : 'unavailable';
    const message =
      statusCode === 403
        ? // The overwhelmingly likely cause, and it is fixable in one edit — so
          // name the fix rather than reporting a bare 403 that reads like a
          // broken certificate.
          'puppetserver refused the request. Add an auth.conf rule allowing this ' +
          "deployment's certname to GET /puppet/v3/environment_classes, then reload puppetserver."
        : `Could not read the class list from puppetserver: ${detail}`;

    this.logger.warn(`Class suggestions unavailable for environment "${environment}": ${detail}`);

    if (previous !== undefined) {
      return {
        ...this.toIndex(environment, previous, true),
        status,
        message: `${message} Showing the last successful fetch.`,
      };
    }

    return { ...this.empty(environment, status), message };
  }

  private empty(environment: string, status: ClassIndex['status']): ClassIndex {
    return {
      status,
      environment,
      classes: [],
      fileErrors: [],
      fetchedAt: null,
      cached: false,
    };
  }
}
