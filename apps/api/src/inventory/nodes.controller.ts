import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
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
