import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { Agent, request } from 'undici';
import {
  PuppetDbUnavailableError,
  type IPuppetDbClient,
  type NodeFilter,
  type Page,
  type PageRequest,
  type PuppetDbHealth,
  type PuppetNode,
  type PuppetReport,
  type ReportSummary,
  type ResourceEvent,
} from '@nexuspuppet/contracts';
import {
  buildCountQuery,
  buildEventsQuery,
  buildNodeQuery,
  buildPagination,
  buildReportByHashQuery,
  buildReportQuery,
  type PqlAst,
} from './pql-builder';
import {
  mapFactsetToFacts,
  mapNode,
  mapReport,
  mapReportSummary,
  mapResourceEvent,
} from './puppetdb.mapper';

/**
 * Read-only PuppetDB client over mTLS (ADR-0004).
 *
 * Certificates are loaded LAZILY, on first use, and a failure to load them is
 * reported as "PuppetDB unavailable" rather than thrown at boot. That is
 * deliberate: the classification half of the product does not depend on
 * PuppetDB at all, so a missing or expired certificate must degrade the
 * inventory screens and leave the ENC working. Failing at startup would take
 * the whole console down over a dependency half of it never touches.
 *
 * Queries are sent as AST JSON built by pql-builder — no caller-supplied
 * string ever reaches the query grammar.
 */

export interface PuppetDbClientOptions {
  baseUrl: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  timeoutMs: number;
}

const QUERY_PATH = '/pdb/query/v4';

@Injectable()
export class PuppetDbClient implements IPuppetDbClient {
  private readonly logger = new Logger(PuppetDbClient.name);
  private readonly baseUrl: string;

  private agent: Agent | null = null;
  private agentError: string | null = null;
  private lastSuccessAt: string | null = null;

  constructor(private readonly options: PuppetDbClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async health(): Promise<PuppetDbHealth> {
    try {
      // /pdb/meta/v1/version is the cheapest liveness probe PuppetDB offers.
      const body = await this.get<{ version?: string }>('/pdb/meta/v1/version');
      return {
        reachable: true,
        lastSuccessAt: this.lastSuccessAt,
        version: body.version ?? null,
      };
    } catch (error) {
      return {
        reachable: false,
        lastSuccessAt: this.lastSuccessAt,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listNodes(filter: NodeFilter, page: PageRequest): Promise<Page<PuppetNode>> {
    const query = buildNodeQuery(filter);

    // Two requests rather than PuppetDB's include_total, which is markedly
    // slower on large estates.
    const [rows, total] = await Promise.all([
      this.query<Record<string, unknown>[]>('/nodes', query, buildPagination(page)),
      this.count('/nodes', query),
    ]);

    return { items: rows.map(mapNode), total, limit: page.limit, offset: page.offset };
  }

  async getNode(certname: string): Promise<PuppetNode | null> {
    const rows = await this.query<Record<string, unknown>[]>('/nodes', ['=', 'certname', certname]);
    const row = rows[0];
    return row === undefined ? null : mapNode(row);
  }

  async getFacts(certname: string): Promise<Record<string, unknown>> {
    const rows = await this.query<Record<string, unknown>[]>('/factsets', [
      '=',
      'certname',
      certname,
    ]);
    const row = rows[0];
    return row === undefined ? {} : mapFactsetToFacts(row);
  }

  async listReports(certname: string, page: PageRequest): Promise<Page<PuppetReport>> {
    const query = buildReportQuery(certname);

    // Newest first is what report triage always wants, so an unspecified sort
    // means most-recent-run rather than alphabetical-by-hash.
    const pagination = buildPagination({
      ...page,
      orderBy: page.orderBy ?? 'receive_time',
      order: page.orderBy === undefined ? 'desc' : page.order,
    });

    const [rows, total] = await Promise.all([
      this.query<Record<string, unknown>[]>('/reports', query, pagination),
      this.count('/reports', query),
    ]);

    return { items: rows.map(mapReport), total, limit: page.limit, offset: page.offset };
  }

  async getReport(hash: string): Promise<PuppetReport | null> {
    const rows = await this.query<Record<string, unknown>[]>(
      '/reports',
      buildReportByHashQuery(hash),
    );
    const row = rows[0];
    return row === undefined ? null : mapReport(row);
  }

  async getReportEvents(hash: string): Promise<ResourceEvent[]> {
    const rows = await this.query<Record<string, unknown>[]>('/events', buildEventsQuery(hash));
    return rows.map(mapResourceEvent);
  }

  async getReportSummary(hash: string): Promise<ReportSummary | null> {
    const rows = await this.query<Record<string, unknown>[]>(
      '/reports',
      buildReportByHashQuery(hash),
    );
    const row = rows[0];
    if (row === undefined) return null;

    const metrics = row['metrics'];
    const data =
      metrics !== null && typeof metrics === 'object'
        ? (metrics as Record<string, unknown>)['data']
        : undefined;

    return mapReportSummary(data);
  }

  async listEnvironments(): Promise<string[]> {
    const rows = await this.query<Array<{ name?: unknown }>>('/environments');
    return rows
      .map((r) => r.name)
      .filter((n): n is string => typeof n === 'string')
      .sort();
  }

  // -------------------------------------------------------------------------

  private async count(endpoint: string, query: PqlAst | null): Promise<number> {
    const rows = await this.query<Array<{ count?: unknown }>>(endpoint, buildCountQuery(query));
    const value = rows[0]?.count;
    return typeof value === 'number' ? value : 0;
  }

  private async query<T>(
    endpoint: string,
    query?: PqlAst | null,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const search = new URLSearchParams();
    if (query !== undefined && query !== null) {
      // The AST is serialised whole. Values occupy their own slots and cannot
      // become syntax (ADR-0004).
      search.set('query', JSON.stringify(query));
    }
    for (const [key, value] of Object.entries(params)) {
      search.set(key, String(value));
    }

    const suffix = search.toString();
    return this.get<T>(`${QUERY_PATH}${endpoint}${suffix === '' ? '' : `?${suffix}`}`);
  }

  private async get<T>(path: string): Promise<T> {
    const agent = await this.getAgent();
    const url = `${this.baseUrl}${path}`;

    let response;
    try {
      response = await request(url, {
        method: 'GET',
        dispatcher: agent,
        headers: { accept: 'application/json' },
        headersTimeout: this.options.timeoutMs,
        bodyTimeout: this.options.timeoutMs,
      });
    } catch (error) {
      throw new PuppetDbUnavailableError(
        `Could not reach PuppetDB at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { lastSuccessAt: this.lastSuccessAt, cause: error },
      );
    }

    if (response.statusCode >= 400) {
      const body = await response.body.text().catch(() => '');
      throw new PuppetDbUnavailableError(
        `PuppetDB returned ${response.statusCode} for ${path}: ${body.slice(0, 500)}`,
        { lastSuccessAt: this.lastSuccessAt, statusCode: response.statusCode },
      );
    }

    const parsed = (await response.body.json()) as T;
    this.lastSuccessAt = new Date().toISOString();
    return parsed;
  }

  /**
   * Build the mTLS dispatcher on first use.
   *
   * A previous failure is cached so a missing certificate does not re-read the
   * filesystem on every request; `resetAgent()` clears it after a rotation.
   */
  private async getAgent(): Promise<Agent> {
    if (this.agent !== null) return this.agent;

    if (this.agentError !== null) {
      throw new PuppetDbUnavailableError(this.agentError, {
        lastSuccessAt: this.lastSuccessAt,
      });
    }

    try {
      const [cert, key, ca] = await Promise.all([
        readFile(this.options.certPath, 'utf8'),
        readFile(this.options.keyPath, 'utf8'),
        readFile(this.options.caPath, 'utf8'),
      ]);

      this.agent = new Agent({
        connect: {
          cert,
          key,
          ca,
          // PuppetDB presents a certificate signed by the Puppet CA, which is
          // not in the system trust store — hence the explicit `ca` above.
          // Verification stays ON: disabling it would defeat the point of mTLS.
          rejectUnauthorized: true,
        },
        headersTimeout: this.options.timeoutMs,
        bodyTimeout: this.options.timeoutMs,
      });

      this.logger.log('PuppetDB mTLS client initialised.');
      return this.agent;
    } catch (error) {
      this.agentError =
        `PuppetDB client certificates could not be loaded (${this.options.certPath}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Inventory and report views are unavailable; classification is unaffected.';

      this.logger.warn(this.agentError);
      throw new PuppetDbUnavailableError(this.agentError, { lastSuccessAt: this.lastSuccessAt });
    }
  }

  /** Call after rotating certificates on disk. */
  resetAgent(): void {
    void this.agent?.close();
    this.agent = null;
    this.agentError = null;
  }
}
