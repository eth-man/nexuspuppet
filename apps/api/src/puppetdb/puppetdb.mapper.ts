import type {
  NodeStatus,
  PuppetNode,
  PuppetReport,
  ReportSummary,
  ResourceEvent,
  ResourceSummary,
} from '@nexuspuppet/contracts';

/**
 * Pure translation from PuppetDB wire shapes to our domain types (ADR-0004).
 *
 * Kept separate from the HTTP client so it can be tested exhaustively against
 * the fixtures in /fixtures without a network or a certificate. Every quirk
 * handled here is a real difference between what PuppetDB documents and what
 * our domain types promise:
 *
 *   - three environment fields collapse to one, with the raw values preserved
 *   - `deactivated` / `expired` are TIMESTAMPS OR NULL, not booleans
 *   - `latest_report_status` is null for deactivated / never-reported nodes
 *   - reports carry NO duration field; it is derived from start/end
 *
 * Everything here tolerates missing and null fields. A PuppetDB of a different
 * version must degrade to "unknown", never throw — one unexpected field must
 * not blank the whole inventory page.
 */

const REPORT_STATUSES = new Set(['changed', 'unchanged', 'failed']);

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Older servers have been observed returning `success` where current ones
 * return `changed`/`unchanged`. Anything unrecognised — including null, which
 * is what a deactivated node returns — becomes `unknown` rather than throwing.
 */
export function toNodeStatus(value: unknown): NodeStatus {
  if (typeof value !== 'string') return 'unknown';
  if (REPORT_STATUSES.has(value)) return value as NodeStatus;
  if (value === 'success') return 'unchanged';
  return 'unknown';
}

export function mapNode(raw: Record<string, unknown>): PuppetNode {
  const reportEnvironment = str(raw['report_environment']);
  const factsEnvironment = str(raw['facts_environment']);
  const catalogEnvironment = str(raw['catalog_environment']);

  const deactivated = str(raw['deactivated']);
  const expired = str(raw['expired']);

  return {
    certname: String(raw['certname'] ?? ''),

    // Resolution order documented in the contract. Reports are the freshest
    // signal of where a node actually is.
    environment: reportEnvironment ?? factsEnvironment ?? catalogEnvironment,
    reportEnvironment,
    factsEnvironment,
    catalogEnvironment,

    reportTimestamp: str(raw['report_timestamp']),
    factsTimestamp: str(raw['facts_timestamp']),
    catalogTimestamp: str(raw['catalog_timestamp']),

    latestReportStatus: toNodeStatus(raw['latest_report_status']),
    latestReportHash: str(raw['latest_report_hash']),
    latestReportNoop: bool(raw['latest_report_noop']),

    deactivated,
    expired,
    isActive: deactivated === null && expired === null,
  };
}

export function mapReport(raw: Record<string, unknown>): PuppetReport {
  const startTime = str(raw['start_time']);
  const endTime = str(raw['end_time']);

  return {
    hash: String(raw['hash'] ?? ''),
    certname: String(raw['certname'] ?? ''),
    environment: str(raw['environment']),
    status: toNodeStatus(raw['status']),
    noop: bool(raw['noop']),
    noopPending: bool(raw['noop_pending']),
    puppetVersion: str(raw['puppet_version']),
    configurationVersion:
      raw['configuration_version'] === null || raw['configuration_version'] === undefined
        ? null
        : String(raw['configuration_version']),
    transactionUuid: str(raw['transaction_uuid']),
    catalogUuid: str(raw['catalog_uuid']),
    cachedCatalogStatus: str(raw['cached_catalog_status']),
    startTime,
    endTime,
    receiveTime: str(raw['receive_time']),
    durationSeconds: durationBetween(startTime, endTime),
  };
}

/**
 * PuppetDB reports carry no duration. The `time`/`total` metric is close but
 * measures catalog application only and is absent on some report formats, so
 * wall-clock from start to end is the honest number.
 *
 * Returns null rather than a negative or NaN duration when either bound is
 * missing or unparseable — a nonsense number rendered in the UI is worse than
 * an absent one.
 */
export function durationBetween(startTime: string | null, endTime: string | null): number | null {
  if (startTime === null || endTime === null) return null;

  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const seconds = (end - start) / 1000;
  return seconds >= 0 ? Number(seconds.toFixed(3)) : null;
}

/**
 * A catalog resource, WITHOUT parameters (ADR-0025 §4).
 *
 * There is no `parameters` branch here on purpose. The list query does not ask
 * for the field, and this mapper could not surface it if a future change did —
 * so the disclosure control holds in two places rather than one.
 */
export function mapResourceSummary(raw: Record<string, unknown>): ResourceSummary {
  return {
    certname: String(raw['certname'] ?? ''),
    type: String(raw['type'] ?? ''),
    title: String(raw['title'] ?? ''),
    file: str(raw['file']),
    line: num(raw['line']),
    environment: String(raw['environment'] ?? ''),
    // PuppetDB calls this `resource`; we name it for what it is, because
    // `resource.resource` reads as a mistake at every call site.
    resourceHash: String(raw['resource'] ?? ''),
    exported: raw['exported'] === true,
    tags: Array.isArray(raw['tags']) ? (raw['tags'] as unknown[]).map((t) => String(t)) : [],
  };
}

export function mapResourceEvent(raw: Record<string, unknown>): ResourceEvent {
  const status = raw['status'];

  return {
    status:
      status === 'success' || status === 'failure' || status === 'noop' || status === 'skipped'
        ? status
        : 'skipped',
    timestamp: str(raw['timestamp']),
    resourceType: String(raw['resource_type'] ?? ''),
    resourceTitle: String(raw['resource_title'] ?? ''),
    property: str(raw['property']),
    oldValue: raw['old_value'] ?? null,
    newValue: raw['new_value'] ?? null,
    message: str(raw['message']),
    file: str(raw['file']),
    line: num(raw['line']),
    containmentPath: Array.isArray(raw['containment_path'])
      ? (raw['containment_path'] as unknown[]).map((s) => String(s))
      : [],
    containingClass: str(raw['containing_class']),
    correctiveChange:
      typeof raw['corrective_change'] === 'boolean' ? raw['corrective_change'] : null,
  };
}

interface Metric {
  category?: unknown;
  name?: unknown;
  value?: unknown;
}

/** Pull the counters an operator actually reads from a report's metrics list. */
export function mapReportSummary(metrics: unknown): ReportSummary {
  const list: Metric[] = Array.isArray(metrics) ? (metrics as Metric[]) : [];

  const find = (category: string, name: string): number | null => {
    const hit = list.find((m) => m.category === category && m.name === name);
    return hit === undefined ? null : num(hit.value);
  };

  return {
    resourcesTotal: find('resources', 'total'),
    resourcesChanged: find('resources', 'changed'),
    resourcesFailed: find('resources', 'failed'),
    resourcesSkipped: find('resources', 'skipped'),
    eventsTotal: find('events', 'total'),
    timeTotalSeconds: find('time', 'total'),
  };
}

/**
 * A factset's `facts.data` is [{name, value}]; the UI and the rule evaluator
 * both want a keyed object.
 */
export function mapFactsetToFacts(raw: Record<string, unknown>): Record<string, unknown> {
  const facts = raw['facts'];
  const data =
    facts !== null && typeof facts === 'object' ? (facts as Record<string, unknown>)['data'] : null;

  if (!Array.isArray(data)) return {};

  const out: Record<string, unknown> = {};
  for (const entry of data as Array<Record<string, unknown>>) {
    const name = entry['name'];
    if (typeof name === 'string') out[name] = entry['value'];
  }
  return out;
}

/**
 * Reduce a full fact set to the configured allow-list (ADR-0004). Full facts
 * are unbounded; mirroring them into ManagedNode for 1,000 nodes would be a
 * large and useless table.
 */
export function projectFacts(
  facts: Record<string, unknown>,
  allowList: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowList) {
    if (Object.prototype.hasOwnProperty.call(facts, key)) out[key] = facts[key];
  }
  return out;
}
