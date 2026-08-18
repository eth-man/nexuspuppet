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
  type FactRow,
  type ReportSummary,
  type ResourceEvent,
  type ResourceFilter,
  type ResourceSummary,
  type ResourceParameters,
} from '@nexuspuppet/contracts';
import {
  buildCountQuery,
  buildEventsQuery,
  buildFactsQuery,
  buildNodeQuery,
  buildPagination,
  buildReportByHashQuery,
  buildReportQuery,
  buildResourceListQuery,
  buildResourceParametersQuery,
  buildResourceQuery,
  type PqlAst,
} from './pql-builder';
import {
  mapFactsetToFacts,
  mapNode,
  mapReport,
  mapReportSummary,
  mapResourceEvent,
  mapResourceSummary,
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

  async listFacts(factNames: readonly string[], page: PageRequest): Promise<Page<FactRow>> {
    const query = buildFactsQuery(factNames);

    // An empty allow-list must fetch nothing, not everything.
    if (query === null) {
      return { items: [], total: 0, limit: page.limit, offset: page.offset };
    }

    const [rows, total] = await Promise.all([
      this.query<Record<string, unknown>[]>('/facts', query, {
        ...buildPagination({ ...page, orderBy: 'certname' }),
        order_by: JSON.stringify([{ field: 'certname', order: 'asc' }]),
      }),
      this.count('/facts', query),
    ]);

    return {
      items: rows.map((row) => ({
        certname: String(row['certname'] ?? ''),
        name: String(row['name'] ?? ''),
        value: row['value'] ?? null,
      })),
      total,
      limit: page.limit,
      offset: page.offset,
    };
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

  async countResources(filter: ResourceFilter): Promise<number> {
    // The CONDITION, deliberately not the list query: wrapping an already
    // projected query in a count extract would nest two extracts and ask
    // PuppetDB to count a projection rather than the matching rows.
    return this.count('/resources', buildResourceQuery(filter));
  }

  async getResourceParameters(
    type: string,
    title: string,
    certnames: readonly string[],
  ): Promise<ResourceParameters[]> {
    const query = buildResourceParametersQuery(type, title, certnames);

    // An empty list fetches nothing, not everything. This is the one call that
    // returns the estate's configuration payload, so the degenerate case has
    // to fail closed.
    if (query === null) return [];

    const rows = await this.query<Record<string, unknown>[]>('/resources', query, {
      // Bounded by the caller's list, and bounded again here: a caller that
      // somehow passed hundreds of certnames still cannot pull the estate.
      limit: certnames.length,
      offset: 0,
      order_by: JSON.stringify([{ field: 'certname', order: 'asc' }]),
    });

    return rows.map((row) => ({
      certname: String(row['certname'] ?? ''),
      resourceHash: String(row['resource'] ?? ''),
      parameters:
        row['parameters'] !== null && typeof row['parameters'] === 'object'
          ? (row['parameters'] as Record<string, unknown>)
          : {},
    }));
  }

  async searchResources(filter: ResourceFilter, page: PageRequest): Promise<Page<ResourceSummary>> {
    const [rows, total] = await Promise.all([
      this.query<Record<string, unknown>[]>('/resources', buildResourceListQuery(filter), {
        ...buildPagination({ ...page, orderBy: 'certname' }),
        order_by: JSON.stringify([
          // Grouping happens above this, but a stable order makes the grouping
          // deterministic and the pagination honest.
          { field: 'title', order: 'asc' },
          { field: 'certname', order: 'asc' },
        ]),
      }),
      this.countResources(filter),
    ]);

    return {
      items: rows.map(mapResourceSummary),
      total,
      limit: page.limit,
      offset: page.offset,
    };
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
      // Read each separately so the diagnostic can name the file that actually
      // failed. Under a single Promise.all the message could only ever cite one
      // path, and an unreadable KEY would send an operator to inspect the CERT.
      const [cert, key, ca] = await Promise.all([
        this.readPem(this.options.certPath, 'client certificate'),
        this.readPem(this.options.keyPath, 'client key'),
        this.readPem(this.options.caPath, 'CA certificate'),
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
        `${error instanceof Error ? error.message : String(error)} ` +
        'Inventory and report views are unavailable; classification is unaffected.';

      this.logger.warn(this.agentError);
      throw new PuppetDbUnavailableError(this.agentError, { lastSuccessAt: this.lastSuccessAt });
    }
  }

  /**
   * Read one PEM, turning the two failures operators actually hit into
   * sentences rather than errno strings.
   *
   * EACCES is the one worth spelling out. The container runs as a non-root uid,
   * so the natural `install -o root -g root` produces a file that exists, has
   * the right name and the right mode, and still cannot be read — which looks
   * nothing like a permissions problem from the console, where it surfaces only
   * as "PuppetDB unreachable".
   */
  private async readPem(path: string, role: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const uid = process.getuid?.();
      const asUid = uid === undefined ? '' : ` This process runs as uid ${uid}.`;

      if (code === 'ENOENT') {
        throw new Error(`PuppetDB ${role} not found at ${path}.`, { cause: error });
      }
      if (code === 'EACCES') {
        throw new Error(
          `PuppetDB ${role} at ${path} exists but is not readable.${asUid} ` +
            'Own the certificate directory and its files by that uid — see DEPLOYMENT.md §3. ' +
            'Do not chown to the container gid; on the host that number is an unrelated system group.',
          { cause: error },
        );
      }
      throw new Error(
        `PuppetDB ${role} at ${path} could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}.`,
        { cause: error },
      );
    }
  }

  /** Call after rotating certificates on disk. */
  resetAgent(): void {
    void this.agent?.close();
    this.agent = null;
    this.agentError = null;
  }
}
