import type { ResourceFilter } from '@nexuspuppet/contracts';
import { resourceFilterSchema } from '@nexuspuppet/contracts';
import { buildResourceQuery, buildResourceListQuery, RESOURCE_LIST_FIELDS } from './pql-builder';

/*
 * Resource search queries (ADR-0025).
 *
 * The assertions that matter here are about what is ABSENT: `parameters` from
 * the projection, and any user string from a position where PQL would read it
 * as syntax.
 */

const filter = (over: Partial<ResourceFilter> = {}): ResourceFilter => ({
  type: 'File',
  ...over,
});

describe('buildResourceListQuery', () => {
  /*
   * §4. THE DISCLOSURE CONTROL, asserted rather than assumed. A value that is
   * never fetched cannot leak through a rendering bug, a log line, an error
   * page or a screenshot — but only while nobody adds the field back.
   */
  it('never asks PuppetDB for parameters', () => {
    const query = buildResourceListQuery(filter({ title: '/etc/ssh/sshd_config' }));

    expect(JSON.stringify(query)).not.toContain('parameters');
    expect(RESOURCE_LIST_FIELDS).not.toContain('parameters');
  });

  it('projects exactly the fields a list may show', () => {
    expect(buildResourceListQuery(filter())[1]).toEqual([...RESOURCE_LIST_FIELDS]);
  });

  /*
   * The projection must wrap the condition, not replace it. An extract with no
   * condition is every resource in the estate.
   */
  it('keeps the condition inside the projection', () => {
    const query = buildResourceListQuery(filter({ title: '/etc/motd' }));

    expect(query[0]).toBe('extract');
    expect(query[2]).toEqual(buildResourceQuery(filter({ title: '/etc/motd' })));
  });

  /*
   * The resource hash IS in the projection, and must stay there: without it
   * every group reports one variant, which is agreement that does not exist.
   */
  it('projects the resource hash, which consistency is computed from', () => {
    expect(RESOURCE_LIST_FIELDS).toContain('resource');
  });
});

describe('buildResourceQuery', () => {
  it('always constrains the type', () => {
    expect(buildResourceQuery(filter())).toEqual(['=', 'type', 'File']);
  });

  it('matches an exact title', () => {
    expect(buildResourceQuery(filter({ title: '/etc/motd' }))).toEqual([
      'and',
      ['=', 'type', 'File'],
      ['=', 'title', '/etc/motd'],
    ]);
  });

  /*
   * A title is a FILE PATH. Unescaped, `/etc/foo.conf` would match
   * `/etc/fooXconf`, and a title containing `.*` would match everything.
   */
  it('escapes a substring title so a path cannot act as a pattern', () => {
    const query = buildResourceQuery(filter({ titleContains: '/etc/foo.conf' }));

    expect(query).toEqual(['and', ['=', 'type', 'File'], ['~', 'title', '/etc/foo\\.conf']]);
  });

  it("filters on the resource's own environment", () => {
    expect(buildResourceQuery(filter({ environments: ['production', 'staging'] }))).toEqual([
      'and',
      ['=', 'type', 'File'],
      ['or', ['=', 'environment', 'production'], ['=', 'environment', 'staging']],
    ]);
  });

  /*
   * §5. Parameter conditions are the oracle, and they compile to a value slot
   * — never to concatenated syntax.
   */
  it('compiles a parameter condition to a bound value', () => {
    const query = buildResourceQuery(
      filter({ parameters: [{ path: 'mode', operator: 'EQUALS', value: '0666' }] }),
    );

    expect(query).toEqual(['and', ['=', 'type', 'File'], ['=', 'parameters.mode', '0666']]);
  });

  /*
   * The same subtlety the fact filter has: a resource that does not CARRY the
   * parameter has no opinion, and reporting it as "not equal to X" would
   * quietly include resources the operator never asked about.
   */
  it('requires a parameter to exist before excluding a value', () => {
    const query = buildResourceQuery(
      filter({ parameters: [{ path: 'mode', operator: 'NOT_EQUALS', value: '0600' }] }),
    );

    expect(query[2]).toEqual([
      'and',
      ['~', 'parameters.mode', '.*'],
      ['not', ['=', 'parameters.mode', '0600']],
    ]);
  });

  /*
   * §7 composition: node-level facts reach a resource query as an `in certname`
   * subquery, because `resources` and `inventory` are different entities and
   * only the certname is common to both. This is the shape verified against a
   * real PuppetDB in #246.
   */
  it('composes with the fact filter as an inventory subquery', () => {
    const query = buildResourceQuery(
      filter({ facts: [{ path: 'os.name', operator: 'EQUALS', value: 'Ubuntu' }] }),
    );

    expect(query[2]).toEqual([
      'in',
      'certname',
      ['from', 'inventory', ['extract', 'certname', ['=', 'facts.os.name', 'Ubuntu']]],
    ]);
  });

  it('ands every condition together', () => {
    const query = buildResourceQuery(
      filter({
        title: '/etc/motd',
        environments: ['production'],
        exported: false,
        parameters: [{ path: 'mode', operator: 'EQUALS', value: '0644' }],
        facts: [{ path: 'os.name', operator: 'EQUALS', value: 'Ubuntu' }],
      }),
    );

    // `and` plus six conditions — the mandatory type, and one each for title,
    // environment, exported, the parameter condition and the fact subquery.
    expect(query[0]).toBe('and');
    expect(query).toHaveLength(7);
  });
});

describe('resourceFilterSchema', () => {
  /*
   * §10. THE FLOOR. An unnarrowed resource query is the estate's entire
   * catalog, and refusing it in the schema means it cannot be issued by
   * forgetting a parameter rather than by choosing to.
   */
  it('refuses a search with no type', () => {
    expect(resourceFilterSchema.safeParse({}).success).toBe(false);
    expect(resourceFilterSchema.safeParse({ type: '' }).success).toBe(false);
  });

  it('accepts a namespaced type', () => {
    expect(resourceFilterSchema.safeParse({ type: 'Nginx::Config' }).success).toBe(true);
  });

  /*
   * A type becomes a VALUE in the AST, not a field name — but it is also the
   * one thing the schema can constrain tightly, so it does.
   */
  it('refuses a type that is not a resource type', () => {
    expect(resourceFilterSchema.safeParse({ type: 'file' }).success).toBe(false);
    expect(resourceFilterSchema.safeParse({ type: 'File; DROP' }).success).toBe(false);
  });

  it('bounds how many conditions one search may carry', () => {
    const many = Array.from({ length: 11 }, () => ({
      path: 'mode',
      operator: 'EQUALS' as const,
      value: '0644',
    }));

    expect(resourceFilterSchema.safeParse({ type: 'File', parameters: many }).success).toBe(false);
  });
});
