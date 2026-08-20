import type { IPuppetDbClient, Page, PuppetNode, ResourceSummary } from '@nexuspuppet/contracts';
import { NodesController } from './nodes.controller';
import { ResourcesController } from './resources.controller';

/*
 * CSV export, through the route (#243 phase 3).
 *
 * The CSV writer is tested exhaustively in pure/csv.spec.ts. This asserts the
 * two things only the ROUTE can get wrong:
 *
 *   - a hostile value actually reaches the writer, rather than being
 *     interpolated somewhere on the way past it
 *   - the export covers the whole result set, not the page on screen
 *
 * The hostile case cannot be proven against the dev fixtures — no node there
 * is malicious, and adding one would change an estate size the browser tests
 * assert on. So it is injected here, where it belongs.
 */

const node = (over: Partial<PuppetNode> = {}): PuppetNode =>
  ({
    certname: 'web01.example.com',
    environment: 'production',
    reportEnvironment: 'production',
    factsEnvironment: 'production',
    catalogEnvironment: 'production',
    reportTimestamp: '2026-08-20T10:00:00.000Z',
    factsTimestamp: '2026-08-20T10:00:00.000Z',
    catalogTimestamp: '2026-08-20T10:00:00.000Z',
    latestReportStatus: 'unchanged',
    latestReportHash: 'abc',
    latestReportNoop: false,
    deactivated: null,
    expired: null,
    isActive: true,
    ...over,
  }) as PuppetNode;

/** Collects everything the controller streams. */
function fakeResponse() {
  const chunks: string[] = [];
  return {
    body: () => chunks.join(''),
    res: {
      write: (chunk: string) => chunks.push(chunk),
      end: () => undefined,
    } as never,
  };
}

function controllerServing(pages: PuppetNode[][], total?: number) {
  let call = 0;
  const puppetdb = {
    listNodes: (): Promise<Page<PuppetNode>> => {
      const items = pages[call] ?? [];
      call += 1;
      return Promise.resolve({
        items,
        total: total ?? pages.flat().length,
        limit: 500,
        offset: 0,
      });
    },
  } as unknown as IPuppetDbClient;

  return new NodesController(puppetdb, {} as never);
}

const query = { filter: {}, page: { limit: 50, offset: 0, order: 'asc' as const } };

describe('node CSV export', () => {
  /*
   * THE ATTACK, end to end. A certname is chosen by the agent, so a machine
   * that presents this one puts a DDE command into the operator's spreadsheet.
   */
  it('defuses a hostile certname on the way out', async () => {
    const hostile = String.raw`=cmd|'/c calc'!A0`;
    const { res, body } = fakeResponse();

    await controllerServing([[node({ certname: hostile })]]).exportCsv(query as never, res);

    expect(body()).toContain(`"'${hostile}"`);
    // The bare formula must not appear at the start of any field.
    expect(body()).not.toContain(`,"${hostile}"`);
    expect(body()).not.toContain(`\r\n"${hostile}"`);
  });

  it('leads with a BOM and a header row', async () => {
    const { res, body } = fakeResponse();

    await controllerServing([[node()]]).exportCsv(query as never, res);

    expect(body().startsWith('﻿"certname"')).toBe(true);
    expect(body().split('\r\n')[0]).toContain('"environment","status"');
  });

  /*
   * THE WHOLE RESULT SET. Exporting one page because that is what the table
   * showed would answer a different question than the one asked, silently.
   */
  it('pages through until the result set is exhausted', async () => {
    const full = Array.from({ length: 500 }, (_, i) => node({ certname: `n${String(i)}` }));
    const { res, body } = fakeResponse();

    await controllerServing([full, [node({ certname: 'last' })]]).exportCsv(query as never, res);

    const rows = body().trimEnd().split('\r\n');
    expect(rows).toHaveLength(502); // header + 500 + 1
    expect(rows[rows.length - 1]).toContain('"last"');
  });

  /*
   * A truncated export that LOOKS complete is worse than either a complete one
   * or an error — somebody acts on it believing it is the whole estate.
   */
  it('says so in the file when it truncates', async () => {
    const page = Array.from({ length: 500 }, (_, i) => node({ certname: `n${String(i)}` }));
    const { res, body } = fakeResponse();

    // 200 pages of 500 would exceed the cap; total claims far more.
    const pages = Array.from({ length: 120 }, () => page);
    await controllerServing(pages, 1_000_000).exportCsv(query as never, res);

    expect(body()).toContain('# truncated at 50000 rows of 1000000');
  });

  it('stops cleanly on a short page without claiming truncation', async () => {
    const { res, body } = fakeResponse();

    await controllerServing([[node(), node({ certname: 'b' })]]).exportCsv(query as never, res);

    expect(body()).not.toContain('# truncated');
  });
});

/*
 * Resource export (#243 phase 3).
 *
 * ONE ROW PER NODE, not per group. The screen leads with variance because that
 * is the question on screen; what somebody carries to a ticket is which
 * machines, and a summary row saying "2 variants" cannot be filtered or pasted
 * into a change record.
 */
describe('resource CSV export', () => {
  const summary = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
    certname: 'web01.example.com',
    type: 'File',
    title: '/etc/ssh/sshd_config',
    file: '/etc/puppetlabs/code/.../base.pp',
    line: 31,
    environment: 'production',
    resourceHash: 'aaaaaaaa1111',
    exported: false,
    tags: [],
    ...over,
  });

  function controllerFor(items: ResourceSummary[]) {
    const puppetdb = {
      countResources: () => Promise.resolve(items.length),
      searchResources: () => Promise.resolve({ items, total: items.length, limit: 500, offset: 0 }),
    } as unknown as IPuppetDbClient;
    return new ResourcesController(puppetdb, { parameterQuery: async () => undefined } as never);
  }

  const filter = { type: 'File' } as never;

  it('writes a row per node, with the group context on each', async () => {
    const { res, body } = fakeResponse();

    await controllerFor([
      summary({ certname: 'ok1', resourceHash: 'same' }),
      summary({ certname: 'ok2', resourceHash: 'same' }),
      summary({ certname: 'drifted', resourceHash: 'other' }),
    ]).exportCsv(filter, res);

    const rows = body().trimEnd().split('\r\n');
    expect(rows).toHaveLength(4); // header + three nodes
    expect(rows[1]).toContain('"ok1"');
    expect(rows[3]).toContain('"drifted"');
    // Baseline first, and every row carries the group's variant count.
    expect(rows[1]).toContain('"true"');
    expect(rows[3]).toContain('"false"');
    expect(rows[3]).toContain('"2"');
  });

  /*
   * NO PARAMETER VALUES. That is what keeps this an ordinary read rather than
   * a disclosure, and therefore unaudited (ADR-0025 §4, §6).
   */
  it('contains no parameter values at all', async () => {
    const { res, body } = fakeResponse();

    await controllerFor([summary()]).exportCsv(filter, res);

    expect(body()).not.toContain('parameters');
    expect(body()).not.toContain('PermitRootLogin');
  });

  it('says so rather than exporting a sample when the match is too large', async () => {
    const puppetdb = {
      countResources: () => Promise.resolve(999_999),
      searchResources: () => Promise.resolve({ items: [], total: 0, limit: 500, offset: 0 }),
    } as unknown as IPuppetDbClient;
    const { res, body } = fakeResponse();

    await new ResourcesController(puppetdb, {
      parameterQuery: async () => undefined,
    } as never).exportCsv(filter, res);

    expect(body()).toContain('# 999999 resources match');
    expect(body().trimEnd().split('\r\n')).toHaveLength(2); // header + the notice
  });
});
