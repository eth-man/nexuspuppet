import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  PUPPETDB_CLIENT,
  factFilterSchema,
  resourceFilterSchema,
  type IPuppetDbClient,
  type ResourceFilter,
  type ResourceGroup,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../auth/auth.guard';
import { groupResources } from './pure/group-resources';

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
  constructor(@Inject(PUPPETDB_CLIENT) private readonly puppetdb: IPuppetDbClient) {}

  @Get()
  async search(
    @Query(new ZodValidationPipe(searchQuerySchema)) filter: SearchQuery,
  ): Promise<ResourceSearchResult> {
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
}
