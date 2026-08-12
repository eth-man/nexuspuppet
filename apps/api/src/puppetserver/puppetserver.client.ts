import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { Agent, request } from 'undici';
import { PuppetServerUnavailableError, type IPuppetServerClient } from '@nexuspuppet/contracts';

/**
 * Read-only puppetserver client (ADR-0024).
 *
 * ONE ENDPOINT, deliberately. There is no general puppetserver client here: no
 * catalog compilation, no CA access, no environment deployment, and above all
 * no `puppet-admin-api` environment-cache flush, which is a mutation ADR-0024
 * §8 forbids us. A second endpoint is a superseding ADR, not a new method.
 *
 * THIS IS NOT THE DEPENDENCY ADR-0003 FORBIDS. That rule is directional —
 * nothing may make Puppet depend on NexusPuppet at runtime. This is the other
 * direction, out of band, and every caller degrades to free text when it fails.
 *
 * Certificates load lazily and a failure to load them is reported as
 * unavailable rather than thrown at boot, exactly as PuppetDbClient does: this
 * is a suggestion source, and it must never be able to prevent the console from
 * starting.
 */

export interface PuppetServerClientOptions {
  baseUrl: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  /**
   * Applies to an UNCACHED fetch, which reparses the whole environment and is a
   * minutes operation on a large estate.
   *
   * Foreman's Smart Proxy uses 15s when it holds a cache entry and a much
   * longer ceiling otherwise (MAX_PUPPETAPI_TIMEOUT = 300). A design that
   * assumes this is fast times out in exactly the estates that need it most.
   */
  timeoutMs: number;
}

const CLASSES_PATH = '/puppet/v3/environment_classes';

@Injectable()
export class PuppetServerClient implements IPuppetServerClient {
  private readonly logger = new Logger(PuppetServerClient.name);
  private readonly baseUrl: string;

  private agent: Agent | null = null;
  private agentError: string | null = null;

  constructor(private readonly options: PuppetServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async listEnvironmentClasses(
    environment: string,
    etag: string | null,
  ): Promise<{ notModified: boolean; body: unknown; etag: string | null }> {
    const agent = await this.getAgent();
    // encodeURIComponent, not interpolation: an environment name reaches this
    // from a group's configuration, and a query string is a grammar like any
    // other.
    const url = `${this.baseUrl}${CLASSES_PATH}?environment=${encodeURIComponent(environment)}`;

    let response;
    try {
      response = await request(url, {
        method: 'GET',
        dispatcher: agent,
        headers: {
          accept: 'application/json',
          // Sent when we hold one. puppetserver only ISSUES an ETag when
          // `environment-class-cache-enabled` is true in puppetserver.conf,
          // which is OFF BY DEFAULT — so this is an optimisation that usually
          // does nothing, never a requirement (ADR-0024 §6).
          ...(etag === null ? {} : { 'if-none-match': etag }),
        },
        headersTimeout: this.options.timeoutMs,
        bodyTimeout: this.options.timeoutMs,
      });
    } catch (error) {
      throw new PuppetServerUnavailableError(
        `Could not reach puppetserver at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const responseEtag = this.headerValue(response.headers['etag']);

    if (response.statusCode === 304) {
      // Body must still be drained or the connection is not returned to the
      // pool, and a picker refreshed often enough would exhaust it.
      await response.body.dump();
      return { notModified: true, body: null, etag: responseEtag ?? etag };
    }

    if (response.statusCode >= 400) {
      const body = await response.body.text().catch(() => '');
      throw new PuppetServerUnavailableError(
        `puppetserver returned ${response.statusCode} for ${CLASSES_PATH}: ${body.slice(0, 300)}`,
        { statusCode: response.statusCode },
      );
    }

    return { notModified: false, body: await response.body.json(), etag: responseEtag };
  }

  private headerValue(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0] ?? null;
    return null;
  }

  private async getAgent(): Promise<Agent> {
    if (this.agent !== null) return this.agent;
    if (this.agentError !== null) {
      throw new PuppetServerUnavailableError(this.agentError);
    }

    try {
      // Read separately so a diagnostic can name the file that actually failed;
      // an unreadable KEY reported as a CERT problem sends an operator to
      // inspect the wrong file.
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
          // puppetserver presents a certificate signed by the Puppet CA, which
          // is not in the system trust store — hence the explicit `ca`.
          // Verification stays ON.
          rejectUnauthorized: true,
        },
      });
      return this.agent;
    } catch (error) {
      this.agentError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Class suggestions are unavailable: ${this.agentError}. The class field falls back to free text.`,
      );
      throw new PuppetServerUnavailableError(this.agentError);
    }
  }

  private async readPem(path: string, label: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      throw new Error(
        `Could not read the ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
