import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import {
  PUPPETDB_CLIENT,
  nodeFilterSchema,
  pageRequestSchema,
  type IPuppetDbClient,
  type NodeFilter,
  type Page,
  type PageRequest,
  type PuppetNode,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../auth/auth.guard';

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
  constructor(@Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient) {}

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
