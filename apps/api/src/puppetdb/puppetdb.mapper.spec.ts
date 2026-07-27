import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mapNode,
  mapReport,
  mapResourceEvent,
  mapReportSummary,
  mapFactsetToFacts,
  projectFacts,
  toNodeStatus,
  durationBetween,
} from './puppetdb.mapper';

/**
 * These run against the synthetic fixtures in /fixtures, generated from the
 * PuppetDB 8 v4 API documentation by scripts/generate-fixtures.mjs.
 *
 * They prove the mappers handle the DOCUMENTED shapes. They do not prove
 * behaviour against a real estate — see fixtures/README.md.
 */

const fixtures = join(__dirname, '../../../../fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as T;

type Raw = Record<string, unknown>;

const nodes = load<Raw[]>('nodes-query.sample.json');
const factsets = load<Raw[]>('factset-single-node.sample.json');
const successReports = load<Raw[]>('report-success.sample.json');
const failureReports = load<Raw[]>('report-failure.sample.json');

describe('fixtures', () => {
  it('provide a 50-node inventory', () => {
    expect(nodes).toHaveLength(50);
  });

  it('include the states an inventory must render distinctly', () => {
    expect(nodes.some((n) => n['deactivated'] !== null)).toBe(true);
    expect(nodes.some((n) => n['expired'] !== null)).toBe(true);
    expect(nodes.some((n) => n['latest_report_status'] === 'failed')).toBe(true);
  });
});

describe('mapNode', () => {
  it('maps every fixture node without throwing', () => {
    const mapped = nodes.map(mapNode);
    expect(mapped).toHaveLength(50);
    expect(mapped.every((n) => n.certname.length > 0)).toBe(true);
  });

  it('collapses the three environments with report taking precedence', () => {
    const node = mapNode({
      certname: 'a',
      report_environment: 'production',
      facts_environment: 'staging',
      catalog_environment: 'development',
    });
    expect(node.environment).toBe('production');
    // The raw values survive, so a half-completed environment move stays visible.
    expect(node.factsEnvironment).toBe('staging');
    expect(node.catalogEnvironment).toBe('development');
  });

  it('falls back through facts then catalog', () => {
    expect(mapNode({ certname: 'a', facts_environment: 'staging' }).environment).toBe('staging');
    expect(mapNode({ certname: 'a', catalog_environment: 'dev' }).environment).toBe('dev');
    expect(mapNode({ certname: 'a' }).environment).toBeNull();
  });

  // The wire fields are timestamps, not booleans — a node records WHEN it was
  // deactivated. Treating them as booleans would make every active node look
  // deactivated, since a non-empty string is truthy.
  describe('deactivated / expired are timestamps', () => {
    it('derives isActive from both being null', () => {
      expect(mapNode({ certname: 'a', deactivated: null, expired: null }).isActive).toBe(true);
    });

    it('is inactive when deactivated', () => {
      const n = mapNode({ certname: 'a', deactivated: '2026-07-24T09:00:00.000Z', expired: null });
      expect(n.isActive).toBe(false);
      expect(n.deactivated).toBe('2026-07-24T09:00:00.000Z');
    });

    it('is inactive when expired', () => {
      expect(mapNode({ certname: 'a', expired: '2026-07-19T09:00:00.000Z' }).isActive).toBe(false);
    });

    it('matches the fixture: exactly one deactivated and one expired node', () => {
      const mapped = nodes.map(mapNode);
      expect(mapped.filter((n) => n.deactivated !== null)).toHaveLength(1);
      expect(mapped.filter((n) => n.expired !== null)).toHaveLength(1);
      expect(mapped.filter((n) => !n.isActive)).toHaveLength(2);
    });
  });

  it('reports a deactivated node with a null status as unknown, not a crash', () => {
    const deactivated = nodes.find((n) => n['deactivated'] !== null) as Raw;
    expect(mapNode(deactivated).latestReportStatus).toBe('unknown');
  });
});

describe('toNodeStatus', () => {
  it.each(['changed', 'unchanged', 'failed'])('passes through %s', (s) => {
    expect(toNodeStatus(s)).toBe(s);
  });

  // Older servers emit `success`; current ones do not.
  it('maps the legacy success value to unchanged', () => {
    expect(toNodeStatus('success')).toBe('unchanged');
  });

  // A PuppetDB of a different version must degrade, never throw — one
  // unexpected value must not blank the whole inventory page.
  it.each([null, undefined, 42, {}, 'brand_new_status'])('degrades %p to unknown', (v) => {
    expect(toNodeStatus(v)).toBe('unknown');
  });
});

describe('mapReport', () => {
  const success = mapReport(successReports[0] as Raw);
  const failure = mapReport(failureReports[0] as Raw);

  it('maps the successful report', () => {
    expect(success.status).toBe('changed');
    expect(success.noop).toBe(false);
    expect(success.puppetVersion).toBe('8.10.0');
  });

  it('maps the failed report', () => {
    expect(failure.status).toBe('failed');
  });

  // Asserting the certname LITERAL would only restate the fixture. What matters
  // is that the fixture set is internally coherent: a report must belong to a
  // node the inventory actually contains, or anything cross-referencing them
  // lands on a node that is not there.
  it('references nodes that exist in the inventory fixture', () => {
    const estate = new Map(nodes.map((n) => [String(n['certname']), n]));

    for (const report of [success, failure]) {
      expect(estate.has(report.certname)).toBe(true);
      // And the node's advertised latest_report_hash resolves to this report,
      // so the inventory's "view report" link works.
      expect(estate.get(report.certname)?.['latest_report_hash']).toBe(report.hash);
    }
  });

  // PuppetDB carries no duration field. Deriving it is the mapper's job.
  it('derives duration from start and end time', () => {
    expect(success.durationSeconds).toBe(12);
    expect(failure.durationSeconds).toBe(47);
  });

  it('keeps configuration_version as a string even when numeric', () => {
    expect(typeof success.configurationVersion).toBe('string');
  });
});

describe('durationBetween', () => {
  it('returns seconds with millisecond precision', () => {
    expect(durationBetween('2026-07-27T09:00:00.000Z', '2026-07-27T09:00:12.500Z')).toBe(12.5);
  });

  // A nonsense number in the UI is worse than an absent one.
  it.each([
    [null, '2026-07-27T09:00:00.000Z'],
    ['2026-07-27T09:00:00.000Z', null],
    ['not-a-date', '2026-07-27T09:00:00.000Z'],
    ['2026-07-27T09:00:12.000Z', '2026-07-27T09:00:00.000Z'], // end before start
  ])('returns null for (%p, %p)', (a, b) => {
    expect(durationBetween(a, b)).toBeNull();
  });
});

describe('mapResourceEvent', () => {
  const events = (failureReports[0] as Raw)['resource_events'] as Raw;
  const data = events['data'] as Raw[];

  it('maps every event in the failed report', () => {
    const mapped = data.map(mapResourceEvent);
    expect(mapped).toHaveLength(4);
    expect(mapped.map((e) => e.status).sort()).toEqual(['failure', 'noop', 'skipped', 'skipped']);
  });

  it('preserves the failure message an operator triages from', () => {
    const failed = data.map(mapResourceEvent).find((e) => e.status === 'failure');
    expect(failed?.resourceType).toBe('Package');
    expect(failed?.message).toContain('Unable to find a match');
    expect(failed?.file).toContain('postgres.pp');
    expect(failed?.line).toBe(18);
  });

  // The dependency chain is what explains why a run failed the way it did.
  it('preserves the containment path', () => {
    const failed = data.map(mapResourceEvent).find((e) => e.status === 'failure');
    expect(failed?.containmentPath).toEqual([
      'Stage[main]',
      'Profile::Db::Postgres',
      'Package[postgresql16-server]',
    ]);
    expect(failed?.containingClass).toBe('Profile::Db::Postgres');
  });

  it('tolerates the all-null fields of a skipped event', () => {
    const skipped = data.map(mapResourceEvent).find((e) => e.status === 'skipped');
    expect(skipped?.property).toBeNull();
    expect(skipped?.message).toBeNull();
    expect(skipped?.correctiveChange).toBeNull();
  });

  it('defaults an unrecognised status to skipped rather than throwing', () => {
    expect(mapResourceEvent({ status: 'nonsense' }).status).toBe('skipped');
  });

  it('defaults a missing containment_path to an empty array', () => {
    expect(mapResourceEvent({ status: 'success' }).containmentPath).toEqual([]);
  });
});

describe('mapReportSummary', () => {
  it('extracts counters from the failed report', () => {
    const metrics = (failureReports[0] as Raw)['metrics'] as Raw;
    const summary = mapReportSummary(metrics['data']);

    expect(summary.resourcesTotal).toBe(214);
    expect(summary.resourcesFailed).toBe(1);
    expect(summary.resourcesSkipped).toBe(2);
    expect(summary.eventsTotal).toBe(4);
  });

  it('returns nulls rather than throwing when metrics are absent', () => {
    expect(mapReportSummary(undefined)).toEqual({
      resourcesTotal: null,
      resourcesChanged: null,
      resourcesFailed: null,
      resourcesSkipped: null,
      eventsTotal: null,
      timeTotalSeconds: null,
    });
  });
});

describe('mapFactsetToFacts', () => {
  const facts = mapFactsetToFacts(factsets[0] as Raw);

  it('keys the {name, value} list by fact name', () => {
    expect(facts['kernel']).toBe('Linux');
    expect(facts['is_virtual']).toBe(true);
  });

  it('preserves structured fact values', () => {
    const os = facts['os'] as Record<string, unknown>;
    expect(os['family']).toBe('RedHat');
    expect((os['release'] as Record<string, unknown>)['major']).toBe('9');
  });

  // These are the values that break naive YAML emitters downstream in the ENC.
  it('preserves strings that look like other types', () => {
    expect(facts['rack_position']).toBe('0755');
    expect(facts['maintenance_window']).toBe('yes');
  });

  it('returns an empty object for a malformed factset', () => {
    expect(mapFactsetToFacts({})).toEqual({});
    expect(mapFactsetToFacts({ facts: { data: 'not-an-array' } })).toEqual({});
  });
});

describe('projectFacts', () => {
  const facts = mapFactsetToFacts(factsets[0] as Raw);

  it('keeps only the allow-listed facts', () => {
    const projected = projectFacts(facts, ['os', 'kernel']);
    expect(Object.keys(projected).sort()).toEqual(['kernel', 'os']);
  });

  // A rule referencing an unprojected fact can never match; the UI must warn
  // rather than silently never matching (ADR-0004).
  it('omits facts that are absent rather than inserting undefined', () => {
    const projected = projectFacts(facts, ['os', 'not_a_real_fact']);
    expect('not_a_real_fact' in projected).toBe(false);
  });

  it('drops the unbounded remainder', () => {
    const projected = projectFacts(facts, ['os']);
    expect(Object.keys(projected)).toHaveLength(1);
    expect(Object.keys(facts).length).toBeGreaterThan(10);
  });
});
