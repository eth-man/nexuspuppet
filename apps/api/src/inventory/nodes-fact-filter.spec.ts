import { z } from 'zod';
import { factFilterSchema, nodeFilterSchema } from '@nexuspuppet/contracts';

/*
 * THE BUG THIS EXISTS FOR (#243).
 *
 * Fact filtering shipped doing nothing. The UI built the rows and FOUR separate
 * places dropped them: the web `NodeQuery` interface, `toSearch`, the
 * controller's query schema, and its transform. None complained — the page
 * added `facts` through a conditional spread, which TypeScript does not treat
 * as an excess property.
 *
 * It looked like it worked because a filtered query still returned nodes. The
 * only assertion that would have caught it is a NEGATIVE one: a filter that
 * must return nothing. "Something came back" proves the endpoint answered, not
 * that it filtered.
 *
 * These exercise the query-string contract itself — the seam that was broken —
 * rather than PQL, which was correct all along.
 */

/** The controller's parsing, isolated: a JSON string in, typed filters out. */
const factsParam = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw === '') return undefined;
    try {
      return factFilterSchema.array().max(10).parse(JSON.parse(raw));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'bad facts' });
      return z.NEVER;
    }
  });

describe('fact filter query-string round trip', () => {
  const encode = (facts: unknown) => JSON.stringify(facts);

  it('survives the round trip the UI actually performs', () => {
    const sent = [{ path: 'os.name', operator: 'EQUALS', value: 'Ubuntu' }];
    const parsed = factsParam.parse(encode(sent));

    expect(parsed).toEqual(sent);
  });

  /*
   * The exact failure: the filter reaching the endpoint and not reaching the
   * FILTER. Rebuilt field by field, so a new field must be added explicitly or
   * it is silently dropped.
   */
  it('reaches the NodeFilter, not merely the request', () => {
    const filter = nodeFilterSchema.parse({
      facts: factsParam.parse(encode([{ path: 'os.name', operator: 'EQUALS', value: 'Ubuntu' }])),
      includeInactive: false,
    });

    expect(filter.facts).toHaveLength(1);
    expect(filter.facts?.[0]?.path).toBe('os.name');
  });

  it('is absent, not empty, when nothing was filtered', () => {
    expect(factsParam.parse(undefined)).toBeUndefined();
    expect(factsParam.parse('')).toBeUndefined();
  });

  /*
   * A malformed value must be a 400 that names the problem, never a filter
   * quietly discarded — which is the shape of the original bug.
   */
  it.each([
    ['not JSON', 'os.name=Ubuntu'],
    ['an object rather than an array', '{"path":"os.name"}'],
    ['an unknown operator', '[{"path":"os.name","operator":"SORT_OF","value":"x"}]'],
    [
      'a value where the operator takes none',
      '[{"path":"os.name","operator":"EXISTS","value":"x"}]',
    ],
    ['no value where the operator needs one', '[{"path":"os.name","operator":"EQUALS"}]'],
    [
      'a path that is not a fact name',
      '[{"path":"os name; drop","operator":"EQUALS","value":"x"}]',
    ],
  ])('refuses %s rather than dropping the filter', (_label, raw) => {
    expect(() => factsParam.parse(raw)).toThrow();
  });

  it('refuses an unbounded number of conditions', () => {
    const many = Array.from({ length: 11 }, () => ({
      path: 'os.name',
      operator: 'EQUALS',
      value: 'x',
    }));

    expect(() => factsParam.parse(encode(many))).toThrow();
  });
});
