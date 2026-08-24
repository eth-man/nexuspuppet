import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  PUPPETDB_CLIENT,
  factFilterSchema,
  nodeFilterSchema,
  pageRequestSchema,
  type IPuppetDbClient,
  type NodeFilter,
  type Page,
  type PageRequest,
  type PuppetNode,
  type NodeClassificationExplanation,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CSV_BOM, csvRow } from './pure/csv';
import { RequirePermission } from '../auth/auth.guard';
import { ClassificationService } from '../classification/classification.service';

/**
 * Node inventory (ADR-0004).
 *
 * Every parameter is validated by a contracts schema before it reaches the
 * client, and the client builds an AST query — no caller-supplied string ever
 * reaches PuppetDB's query grammar. There is deliberately no endpoint here
 * that accepts PQL.
 *
 * PuppetDB outages surface as 503 PUPPETDB_UNAVAILABLE via
 * PuppetDbExceptionFilter, never as an empty list.
 */

/**
 * How many rows one export may contain.
 *
 * An export is a file somebody opens in a spreadsheet, and it is also a query
 * this process pages through synchronously. Both have a limit; this is the
 * lower of the two, and it is stated in the file when it is reached.
 */
const MAX_EXPORT_ROWS = 50_000;

/** One PuppetDB page while streaming. The API caps a page request at 500. */
const EXPORT_PAGE = 500;

/** Query string arrives as strings; coerce before the contract schema sees it. */
const listQuerySchema = z
  .object({
    certnameContains: z.string().max(255).optional(),
    environments: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
    statuses: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
    /*
     * Facts arrive as a JSON string — they are the one filter that is not a
     * scalar or a comma list (#243).
     *
     * Parsed here rather than accepted loosely: a malformed value must be a 400
     * naming the problem, never a filter silently dropped. Dropping it is
     * exactly what happened while this field did not exist, and the symptom was
     * a filter that appeared to work because the unfiltered list came back.
     */
    facts: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw === '') return undefined;
        try {
          return factFilterSchema.array().max(10).parse(JSON.parse(raw));
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: 'facts must be a JSON array of {path, operator, value}',
          });
          return z.NEVER;
        }
      }),
    staleBefore: z.string().optional(),
    includeInactive: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => v === true || v === 'true'),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    orderBy: z.string().max(64).optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .transform((raw) => {
    const filter: NodeFilter = nodeFilterSchema.parse({
      ...(raw.certnameContains === undefined ? {} : { certnameContains: raw.certnameContains }),
      ...(raw.environments === undefined ? {} : { environments: raw.environments }),
      ...(raw.statuses === undefined ? {} : { statuses: raw.statuses }),
      ...(raw.staleBefore === undefined ? {} : { staleBefore: raw.staleBefore }),
      // Rebuilt field by field on purpose, so an unknown query parameter cannot
      // reach the filter — which also means every NEW field must be added here
      // or it is silently dropped. Facts were.
      ...(raw.facts === undefined ? {} : { facts: raw.facts }),
      includeInactive: raw.includeInactive,
    });

    const page: PageRequest = pageRequestSchema.parse({
      limit: raw.limit,
      offset: raw.offset,
      ...(raw.orderBy === undefined ? {} : { orderBy: raw.orderBy }),
      order: raw.order,
    });

    return { filter, page };
  });

type ListQuery = z.infer<typeof listQuerySchema>;

@RequirePermission('inventory:read')
@Controller('nodes')
export class NodesController {
  constructor(
    @Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient,
    private readonly classification: ClassificationService,
  ) {}

  /**
   * Why this node is classified the way it is: applied groups in merge order,
   * conflicts, and whether a change is still queued.
   *
   * Served from local state, so it keeps working during a PuppetDB outage —
   * classification does not depend on PuppetDB (ADR-0003).
   */
  @RequirePermission('classification:read')
  @Get(':certname/classification')
  explain(@Param('certname') certname: string): Promise<NodeClassificationExplanation> {
    return this.classification.explain(certname);
  }

  /** Server-driven pagination: a 10,000-row estate is never shipped whole. */
  @Get()
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery): Promise<Page<PuppetNode>> {
    return this.puppetdb.listNodes(query.filter, query.page);
  }

  /**
   * The filtered node list as CSV (#243 phase 3).
   *
   * "Give me all the Ubuntu 22.04 boxes" is usually a question somebody has to
   * answer SOMEWHERE ELSE — a ticket, a change record, a spreadsheet somebody
   * else owns. That is the whole reason this exists.
   *
   * THE WHOLE RESULT SET, not the page on screen. Exporting 50 of 3,000 rows
   * because that is what the table was showing would answer a different
   * question than the one asked, and silently.
   *
   * STREAMED, page by page, so a large estate is never assembled in memory
   * first. Bounded by MAX_EXPORT_ROWS, and when the bound is hit the file says
   * so in its last line rather than simply stopping — a truncated export that
   * looks complete is the worst of the three possible outcomes.
   *
   * Declared BEFORE `:certname`, or Nest routes `export.csv` into it as a
   * certname. The same shadowing already bites `/node-groups/fact-paths`.
   */
  @Get('export.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="nexuspuppet-nodes.csv"')
  // No caching: an export is a point-in-time answer, and a stale one presented
  // as current is how somebody acts on an estate that has moved on.
  @Header('cache-control', 'no-store')
  async exportCsv(
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
    @Res() response: Response,
  ): Promise<void> {
    response.write(CSV_BOM);
    response.write(
      csvRow([
        'certname',
        'environment',
        'status',
        'last_report',
        'facts_timestamp',
        'noop',
        'active',
      ]),
    );

    let written = 0;
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await this.puppetdb.listNodes(query.filter, {
        limit: Math.min(EXPORT_PAGE, MAX_EXPORT_ROWS - written),
        offset,
        order: 'asc',
        orderBy: 'certname',
      });

      for (const node of page.items) {
        response.write(
          csvRow([
            node.certname,
            node.environment,
            node.latestReportStatus,
            node.reportTimestamp,
            node.factsTimestamp,
            node.latestReportNoop,
            node.isActive,
          ]),
        );
      }

      written += page.items.length;
      if (page.items.length < EXPORT_PAGE || written >= MAX_EXPORT_ROWS) {
        if (written >= MAX_EXPORT_ROWS && written < page.total) {
          // A comment row, because a CSV has nowhere else to say this and a
          // file that simply stops looks exactly like a complete one.
          response.write(
            csvRow([
              `# truncated at ${String(MAX_EXPORT_ROWS)} rows of ${String(page.total)} — narrow the filter`,
            ]),
          );
        }
        break;
      }
    }

    response.end();
  }

  @Get(':certname')
  async get(@Param('certname') certname: string): Promise<PuppetNode> {
    const node = await this.puppetdb.getNode(certname);
    if (node === null) throw new NotFoundException(`No such node: ${certname}`);
    return node;
  }

  /**
   * The FULL fact set, straight from PuppetDB — not the projected subset used
   * for rule evaluation (ADR-0004). Operators writing a matching rule need to
   * see every fact, including the ones not currently projected.
   */
  @Get(':certname/facts')
  getFacts(@Param('certname') certname: string): Promise<Record<string, unknown>> {
    return this.puppetdb.getFacts(certname);
  }
}
