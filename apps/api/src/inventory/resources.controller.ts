import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import {
  PUPPETDB_CLIENT,
  factFilterSchema,
  resourceFilterSchema,
  type IPuppetDbClient,
  type ResourceComparison,
  type ResourceFilter,
  type ResourceGroup,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../auth/auth.guard';
import { groupResources } from './pure/group-resources';
import { differingKeys } from './pure/diff-parameters';
import { ResourceReadAudit } from './resource-read-audit';
import type { AuthenticatedRequest } from '../auth/auth.guard';

/**
 * Estate-wide resource search (ADR-0025).
 *
 * The console could say what a node SHOULD get and never what it DOES get.
 * This reads the catalog PuppetDB already indexes, and answers the question
 * that is not a lookup: do all these nodes AGREE about this resource.
 *
 * `resources:read`, deliberately not `inventory:read` (§3). Facts describe a
 * machine; resource parameters are its configuration payload, and a class
 * parameter may hold a credential.
 *
 * PARAMETERS ARE NOT SERVED HERE. This endpoint returns the consistency view
 * built from hashes alone — no parameter crosses the wire (§4, §7). Expansion
 * and parameter-value display arrive with their audit trail, together, so that
 * disclosure never briefly exists without the record of it (§6).
 */

/**
 * How many matching resources this endpoint will group.
 *
 * ADR-0025 §10. The number is a rendering and memory bound, not a PuppetDB
 * one — grouping happens in this process, and an estate-wide `type=File` with
 * no other narrowing is millions of rows. Above it the operator is told the
 * count and asked to narrow, which is a sentence they can act on rather than a
 * browser that stops responding.
 */
export const MAX_GROUPED_RESOURCES = 5_000;

/** One page of PuppetDB rows while collecting up to the cap. */
const FETCH_PAGE = 500;

const jsonFilterList = (label: string) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === '') return undefined;
      try {
        return factFilterSchema.array().max(10).parse(JSON.parse(raw));
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a JSON array of filter conditions.`,
        });
        return z.NEVER;
      }
    });

/**
 * Query string arrives as strings; coerce before the contract schema sees it.
 *
 * `type` has no default and is not optional. An unnarrowed resource query is
 * the estate's entire catalog, and refusing it here means it can never be
 * issued by forgetting a parameter — the same reasoning as the fact allow-list,
 * where an empty list fetches nothing rather than everything.
 */
export const searchQuerySchema = z
  .object({
    /*
     * THE CONTRACT'S OWN FIELD SCHEMAS, reused rather than restated.
     *
     * One source for the constraint, and — the reason it is written this way —
     * a violation is reported by the OUTER object, which the validation pipe
     * turns into a 400 naming the field. The first version validated by calling
     * `resourceFilterSchema.parse()` inside a `.transform()`, where the throw
     * escaped the pipe: `type=file`, an operator forgetting one capital letter,
     * answered 500 Internal Server Error. A 500 on user input reads as a broken
     * server and gets escalated as one.
     */
    type: resourceFilterSchema.shape.type,
    title: resourceFilterSchema.shape.title,
    titleContains: resourceFilterSchema.shape.titleContains,
    environments: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
    facts: jsonFilterList('facts'),
    parameters: jsonFilterList('parameters'),
    exported: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
  })
  .transform((raw): ResourceFilter => ({
    type: raw.type,
    ...(raw.title === undefined ? {} : { title: raw.title }),
    ...(raw.titleContains === undefined ? {} : { titleContains: raw.titleContains }),
    ...(raw.environments === undefined ? {} : { environments: raw.environments }),
    ...(raw.facts === undefined ? {} : { facts: raw.facts }),
    ...(raw.parameters === undefined ? {} : { parameters: raw.parameters }),
    ...(raw.exported === undefined ? {} : { exported: raw.exported }),
  }));

/** The parsed, validated filter — the schema transforms straight to it. */
type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Which nodes' parameters to fetch when a resource is expanded (ADR-0025 §9).
 *
 * An EXPLICIT list of certnames, capped, and never a pattern. One
 * representative per variant is what the UI asks for — bounded by variant
 * count rather than by the hundreds of nodes carrying the resource — and a cap
 * here means no caller can turn this into a bulk export of the estate's
 * configuration by passing the whole inventory.
 */
export const MAX_EXPANDED_NODES = 10;

export const expandQuerySchema = z.object({
  type: resourceFilterSchema.shape.type,
  // Required and exact. Expansion is about ONE resource; a substring here
  // would let a single call rake in every file whose path contains "conf".
  title: z.string().min(1).max(1024),
  environment: z.string().max(128).optional(),
  certnames: z
    .string()
    .min(1)
    .transform((raw) =>
      raw
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== ''),
    )
    .refine((list) => list.length > 0 && list.length <= MAX_EXPANDED_NODES, {
      message: `Name between 1 and ${String(MAX_EXPANDED_NODES)} nodes.`,
    }),
});

type ExpandQuery = z.infer<typeof expandQuerySchema>;

/**
 * What the search returns.
 *
 * `tooMany` is a first-class outcome, not an error. The operator asked a
 * legitimate question that is simply too broad, and the useful answer is the
 * number plus an instruction — not a 500, and certainly not a truncated list
 * presented as if it were complete.
 */
export interface ResourceSearchResult {
  total: number;
  tooMany: boolean;
  limit: number;
  groups: ResourceGroup[];
}

@RequirePermission('resources:read')
@Controller('resources')
export class ResourcesController {
  constructor(
    @Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient,
    private readonly readAudit: ResourceReadAudit,
  ) {}

  @Get()
  async search(
    @Query(new ZodValidationPipe(searchQuerySchema)) filter: SearchQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<ResourceSearchResult> {
    /*
     * A parameter-VALUE filter is the oracle (§5), so it is recorded — before
     * the query runs, not after. A trail written only on success would miss
     * exactly the probe that errored, and an attacker learns as much from a
     * failure as from a hit.
     *
     * Searching by type and title is NOT recorded: it discloses nothing, and
     * burying the events that matter under thousands that do not is how an
     * audit trail stops being read.
     */
    if (filter.parameters !== undefined && filter.parameters.length > 0) {
      await this.readAudit.parameterQuery(request, filter);
    }

    // COUNT BEFORE FETCH (§10). Cheap, and it turns "the browser stopped
    // responding" into a number the operator can narrow against.
    const total = await this.puppetdb.countResources(filter);

    if (total > MAX_GROUPED_RESOURCES) {
      return { total, tooMany: true, limit: MAX_GROUPED_RESOURCES, groups: [] };
    }

    const collected = [];
    for (let offset = 0; offset < total; offset += FETCH_PAGE) {
      const page = await this.puppetdb.searchResources(filter, {
        limit: FETCH_PAGE,
        offset,
        order: 'asc',
      });
      collected.push(...page.items);
      // The estate can change under a multi-page read. Stop on a short page
      // rather than looping against a total that was true one request ago.
      if (page.items.length < FETCH_PAGE) break;
    }

    return {
      total,
      tooMany: false,
      limit: MAX_GROUPED_RESOURCES,
      groups: groupResources(collected),
    };
  }

  /**
   * The parameters behind one resource, for named nodes (ADR-0025 §9).
   *
   * THE DISCLOSURE, and the only route that returns parameter values. One
   * representative per variant, diffed server-side, and audited unconditionally
   * — the audit row is written BEFORE the fetch, so a read cannot happen
   * without the record of it existing first. Writing it afterwards would leave
   * a window where a crash loses the evidence but not the disclosure.
   */
  @Get('parameters')
  async parameters(
    @Query(new ZodValidationPipe(expandQuerySchema)) query: ExpandQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<ResourceComparison> {
    await this.readAudit.parametersRead(request, query.type, query.title, query.certnames);

    const variants = await this.puppetdb.getResourceParameters(
      query.type,
      query.title,
      query.certnames,
    );

    return {
      type: query.type,
      title: query.title,
      environment: query.environment ?? '',
      // In the order the caller named them, which is the order the group
      // listed its variants: baseline first, then the odd ones out.
      variants: query.certnames
        .map((certname) => variants.find((v) => v.certname === certname))
        .filter((v): v is NonNullable<typeof v> => v !== undefined),
      differingKeys: differingKeys(variants),
    };
  }
}
