import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import {
  PUPPETDB_CLIENT,
  pageRequestSchema,
  type IPuppetDbClient,
  type Page,
  type PageRequest,
  type PuppetReport,
  type ReportSummary,
  type ResourceEvent,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Run reports and failure triage (ADR-0004, read-only).
 *
 * The product requirement this serves is "find why a node's run failed in
 * under two minutes", so the failure view returns the report, its counters,
 * and its events together — three round trips would put the answer three
 * clicks away.
 */

const pageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    orderBy: z.string().max(64).optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .transform((raw): PageRequest =>
    pageRequestSchema.parse({
      limit: raw.limit,
      offset: raw.offset,
      ...(raw.orderBy === undefined ? {} : { orderBy: raw.orderBy }),
      order: raw.order,
    }),
  );

export interface ReportDetail {
  report: PuppetReport;
  summary: ReportSummary | null;
  events: ResourceEvent[];
}

@Controller()
export class ReportsController {
  constructor(@Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient) {}

  /** Reports for one node, newest first by default. */
  @Get('nodes/:certname/reports')
  list(
    @Param('certname') certname: string,
    @Query(new ZodValidationPipe(pageQuerySchema)) page: PageRequest,
  ): Promise<Page<PuppetReport>> {
    return this.puppetdb.listReports(certname, page);
  }

  /**
   * One report with everything needed to triage it.
   *
   * Events are fetched alongside the report rather than behind another request:
   * nobody opens a failed report and then decides they would rather not see
   * why it failed.
   */
  @Get('reports/:hash')
  async detail(@Param('hash') hash: string): Promise<ReportDetail> {
    const report = await this.puppetdb.getReport(hash);
    if (report === null) throw new NotFoundException(`No such report: ${hash}`);

    const [summary, events] = await Promise.all([
      this.puppetdb.getReportSummary(hash),
      this.puppetdb.getReportEvents(hash),
    ]);

    return {
      report,
      summary,
      // Failures first, then skipped: the causal chain in the order an operator
      // reads it. A run with 200 successful events and one failure must not
      // bury the failure.
      events: [...events].sort((a, b) => severity(a.status) - severity(b.status)),
    };
  }

  @Get('reports/:hash/events')
  events(@Param('hash') hash: string): Promise<ResourceEvent[]> {
    return this.puppetdb.getReportEvents(hash);
  }

  @Get('environments')
  environments(): Promise<string[]> {
    return this.puppetdb.listEnvironments();
  }
}

const SEVERITY: Record<ResourceEvent['status'], number> = {
  failure: 0,
  skipped: 1,
  noop: 2,
  success: 3,
};

function severity(status: ResourceEvent['status']): number {
  return SEVERITY[status];
}
