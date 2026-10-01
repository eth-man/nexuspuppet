import type { TarEntry } from '../../replication/ustar';
import { safeHost } from '../../logging/pure/log-record';
import { capOldestFirst, type HostLog } from './log-window';
import {
  addCounts,
  emptyCounts,
  prepareSecrets,
  redact,
  type RedactionCounts,
  type SecretValue,
} from './redaction';

/**
 * Assembling a support bundle (ADR-0028).
 *
 * PURE: everything the collectors gathered goes in, the archive's entries and
 * its manifest come out. No clock — `generatedAt` is an input — so the same
 * input produces the same archive, and every decision about what is kept,
 * truncated or redacted is testable without a database or a filesystem.
 */

/** The API's own log lines are capped at this many bytes, uncompressed. */
export const LOG_CAP_BYTES = 100 * 1024 * 1024;
/** Audit rows beyond this are dropped oldest-first and the manifest says so. */
export const AUDIT_ROW_CAP = 50_000;

export const HOST_SCRIPT = 'scripts/support-bundle.sh';

/**
 * What NO bundle contains, whatever the operator ticks (ADR-0028 §6). Stated in
 * every manifest. The redaction pass enforces the first four a second time.
 */
export const NEVER_INCLUDED = [
  'Secret environment values: reported only as set/unset, and their literal values are redacted wherever they appear.',
  'Stored provider secrets (the encrypted column): never read, never decrypted.',
  'Password hashes, refresh tokens and their hashes, and access tokens (JWTs).',
  'Private keys.',
  'Node facts and ENC documents.',
  'Container, host and systemd logs, which the API cannot see and must not be given access to (ADR-0013). Collect those with scripts/support-bundle.sh on the host.',
] as const;

/** What the default bundle leaves out, and the opt-in adds (ADR-0028 §6). */
export const EXCLUDED_BY_DEFAULT = [
  'The user list and every identity: no email addresses, names or user ids. Users are counted per role, and email addresses anywhere are masked.',
  'Client IP addresses and user agents recorded in the audit trail.',
  'Audit before/after payloads, which can hold classification parameter values — and parameter values can be credentials.',
  'The classification itself — groups, rules, pins, classes and parameter values — and saved queries.',
] as const;

/** What the opt-in adds. Listed in the manifest of a bundle that has it. */
export const PERSONAL_DATA_CONTENTS = [
  'audit/audit-log.jsonl with actor id and email, client IP address, user agent, entity label, and before/after payloads.',
  'personal/users.json: every account with email, display name, role, source, state, last login and lockout — and a count of active sessions, never a token.',
  'config/classification.json: every node group with its rules, pins, classes and parameter values IN FULL. Parameters can hold secrets.',
  'config/saved-queries.json: every saved query with its owner, filter and sharing.',
] as const;

export interface ConditionRow {
  key: string;
  kind: string;
  severity: string;
  summary: string;
  consecutiveFailures: number;
  openedAt: string | null;
  resolvedAt: string | null;
  lastEvaluatedAt: string;
}

export type SinkState =
  | { enabled: true; directory: string; file: string; maxBytes: number; keep: number }
  | { enabled: false; directory: string; reason: string };

export interface BundleInput {
  /** ISO-8601 UTC. The clock is read by the caller, never here. */
  generatedAt: string;
  hours: number;
  /**
   * The operator ticked "include configuration and personal data". Changes
   * the filename, the manifest's first lines and the email rule — never the
   * secret rules. The collectors decide what else is gathered.
   */
  includesPersonalData: boolean;
  api: {
    host: string;
    version: string;
    nodeVersion: string;
    pid: number;
    uptimeSeconds: number;
  };
  logs: {
    directory: string;
    /** This replica's sink. Other replicas are known only by their files. */
    sink: SinkState;
    /** Why the directory could not be listed, if it could not. */
    readError: string | null;
    hosts: HostLog[];
  };
  /** Operational facts the summary is written from. */
  signals: {
    conditions: ConditionRow[];
    materializationFailed: number;
    materializationPending: number;
    auditDeliveryQueued: number;
    newestProjectionAt: string | null;
  };
  /** Everything else, by archive path. Serialised as pretty JSON. */
  json: Record<string, unknown>;
  audit: { rows: unknown[]; truncated: number };
  secrets: SecretValue[];
  logCapBytes?: number;
}

export interface BuiltBundle {
  entries: TarEntry[];
  manifest: Record<string, unknown>;
  fileName: string;
  generatedAt: string;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** `20260930T120000Z` — sortable, and legal in every filesystem. */
export function compactTimestamp(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * The name says which variant it is, so a file sitting in Downloads cannot be
 * mistaken for the one that is safe to attach to a public ticket.
 */
export function bundleFileName(
  host: string,
  generatedAt: string,
  includesPersonalData = false,
): string {
  const marker = includesPersonalData ? '-with-personal-data' : '';
  return `nexuspuppet-support-${safeHost(host)}-${compactTimestamp(generatedAt)}${marker}.tar.gz`;
}

function subtractHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) - hours * 3_600_000).toISOString();
}

function ageOf(fromIso: string, toIso: string): string {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  const hours = ms / 3_600_000;
  if (hours < 1) return `${String(Math.max(0, Math.round(ms / 60_000)))} min`;
  if (hours < 48) return `${String(Math.round(hours))} h`;
  return `${String(Math.floor(hours / 24))} days`;
}

/**
 * The things a reader must see first, in plain sentences.
 *
 * Written for the incident that motivated this feature: production blind to
 * PuppetDB for six weeks, visible only as a WARN every 30 seconds and one open
 * condition. A bundle from that deployment must lead with "PuppetDB has been
 * unreachable for 42 days", not leave it for somebody to find on line 90,000.
 */
export function attentionItems(input: BundleInput, logCoverage: string[]): string[] {
  const now = input.generatedAt;
  const items: string[] = [];
  const open = input.signals.conditions
    .filter((c) => c.openedAt !== null && c.resolvedAt === null)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

  for (const condition of open) {
    items.push(
      `OPEN ${condition.severity.toUpperCase()} condition "${condition.key}" since ` +
        `${condition.openedAt ?? '?'} (${ageOf(condition.openedAt ?? now, now)}): ${condition.summary}`,
    );
  }

  const from = subtractHours(now, input.hours);
  for (const condition of input.signals.conditions) {
    if (condition.resolvedAt !== null && condition.resolvedAt >= from) {
      items.push(
        `Resolved within the window: "${condition.key}" at ${condition.resolvedAt}: ${condition.summary}`,
      );
    }
  }

  if (input.signals.newestProjectionAt === null) {
    items.push('No node has ever been projected from PuppetDB into the local cache.');
  } else if (Date.parse(now) - Date.parse(input.signals.newestProjectionAt) > 3_600_000) {
    items.push(
      `The newest PuppetDB projection is ${ageOf(input.signals.newestProjectionAt, now)} old ` +
        `(${input.signals.newestProjectionAt}). The node cache is not being refreshed.`,
    );
  }

  if (input.signals.materializationFailed > 0) {
    items.push(
      `${String(input.signals.materializationFailed)} ENC materialization job(s) FAILED and will ` +
        'not be retried; those nodes run their previous classification. See database/materialization-jobs.json.',
    );
  }
  if (input.signals.materializationPending > 100) {
    items.push(
      `${String(input.signals.materializationPending)} ENC materialization jobs are pending.`,
    );
  }
  if (input.signals.auditDeliveryQueued > 0) {
    items.push(
      `${String(input.signals.auditDeliveryQueued)} audit record(s) are waiting to be forwarded. ` +
        'See database/audit-delivery.json.',
    );
  }

  return [...items, ...logCoverage];
}

/** Build the archive's entries and manifest. */
export function buildBundle(input: BundleInput): BuiltBundle {
  const to = input.generatedAt;
  const from = subtractHours(to, input.hours);
  const capBytes = input.logCapBytes ?? LOG_CAP_BYTES;
  const secrets = prepareSecrets(input.secrets);

  const capped = capOldestFirst(input.logs.hosts, capBytes);

  // --- log coverage: what a reader must know before trusting the logs -------
  const coverage: string[] = [];
  if (!input.logs.sink.enabled) {
    coverage.push(
      `This replica (${input.api.host}) is not keeping a local log copy: ${input.logs.sink.reason}.`,
    );
  }
  if (input.logs.readError !== null) {
    coverage.push(`The log directory could not be read: ${input.logs.readError}.`);
  }
  if (capped.hosts.length === 0) {
    coverage.push(
      `NO API LOGS are included: no log files were found in ${input.logs.directory}. ` +
        `Use ${HOST_SCRIPT} on the host for container logs.`,
    );
  }

  const replicas = capped.hosts.map((host) => {
    const inWindow = host.lines;
    const coversWindow = host.earliestOnDisk !== null && host.earliestOnDisk <= from;
    if (!coversWindow) {
      coverage.push(
        `Logs for ${host.host} begin at ${host.earliestOnDisk ?? 'no line at all'}, after the ` +
          `window start (${from}): the replica started later, or older lines were rotated away.`,
      );
    }
    return {
      host: host.host,
      file: `logs/api-${safeHost(host.host)}.log`,
      sourceFiles: host.files,
      linesInWindow: inWindow.length,
      earliestInWindow: inWindow[0]?.ts ?? null,
      latestInWindow: inWindow[inWindow.length - 1]?.ts ?? null,
      earliestOnDisk: host.earliestOnDisk,
      latestOnDisk: host.latestOnDisk,
      coversWindow,
      unparseableLines: host.unparseable,
    };
  });

  if (capped.droppedLines > 0) {
    coverage.push(
      `Logs were capped at ${String(capBytes)} bytes: the oldest ${String(capped.droppedLines)} ` +
        `line(s) were dropped, and the kept history begins at ${capped.keptFrom ?? '?'}.`,
    );
  }

  // --- the files, each redacted before anything measures it -----------------
  const totals = emptyCounts();
  const perFile: Record<string, RedactionCounts> = {};
  const files: Array<{ name: string; text: string }> = [];

  // The email rule is the only one the opt-in switches off: identities are
  // what was asked for. Every secret rule runs in both variants.
  const keepEmails = input.includesPersonalData;

  const add = (name: string, text: string): void => {
    const result = redact(text, secrets, { keepEmails });
    addCounts(totals, result.counts);
    if (Object.values(result.counts).some((n) => n > 0)) perFile[name] = result.counts;
    files.push({ name, text: result.text });
  };

  for (const host of capped.hosts) {
    add(`logs/api-${safeHost(host.host)}.log`, host.lines.map((line) => `${line.text}\n`).join(''));
  }
  for (const name of Object.keys(input.json).sort()) add(name, pretty(input.json[name]));
  add('audit/audit-log.jsonl', input.audit.rows.map((row) => `${JSON.stringify(row)}\n`).join(''));

  const attention = attentionItems(input, coverage);
  const summary = [
    'NexusPuppet support bundle',
    '==========================',
    '',
    ...(input.includesPersonalData
      ? [
          'THIS BUNDLE CONTAINS PERSONAL DATA AND THE FULL CLASSIFICATION: email addresses,',
          'client IP addresses, audit before/after values and class parameter values, which',
          'can include secrets. Share it only with someone entitled to see all of that.',
          '',
        ]
      : []),
    `Generated ${to} on ${input.api.host}, version ${input.api.version}.`,
    `Window: ${from} to ${to} (${String(input.hours)} h).`,
    '',
    attention.length === 0 ? 'Nothing needs attention.' : 'Needs attention:',
    ...attention.map((item) => `  - ${item}`),
    '',
    'Start with manifest.json for what is here and what is not, then status/conditions.json.',
    `Container, host and systemd logs are not in this archive: run ${HOST_SCRIPT} on the`,
    'host, passing this file with --include, to produce one archive for support.',
    '',
  ].join('\n');
  add('summary.txt', summary);

  // --- the manifest, written last so it can describe everything above -------
  const manifest: Record<string, unknown> = {
    format: 'nexuspuppet-support-bundle/1',
    // FIRST, before anything else a reader or a script sees.
    includesPersonalData: input.includesPersonalData,
    ...(input.includesPersonalData ? { personalData: PERSONAL_DATA_CONTENTS } : {}),
    product: 'NexusPuppet',
    version: input.api.version,
    generatedAt: to,
    window: { from, to, hours: input.hours },
    api: input.api,
    attention,
    logs: {
      directory: input.logs.directory,
      thisReplicaSink: input.logs.sink,
      readError: input.logs.readError,
      capBytes,
      truncated:
        capped.droppedLines === 0
          ? false
          : {
              droppedLines: capped.droppedLines,
              droppedBytes: capped.droppedBytes,
              keptFrom: capped.keptFrom,
            },
      replicas,
    },
    audit: {
      file: 'audit/audit-log.jsonl',
      rows: input.audit.rows.length,
      droppedOldest: input.audit.truncated,
    },
    files: files
      .map((file) => ({ path: file.name, bytes: Buffer.byteLength(file.text, 'utf8') }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    redaction: {
      counts: totals,
      byFile: perFile,
      literalSecretsSearched: secrets.searched,
      notRedactedTooShort: secrets.tooShort,
      rules: [
        'secret-value: literal values of secret environment variables (and URL passwords within them), as-is and JSON-escaped',
        'pem-private-key: PEM private key blocks, and a BEGIN line with no END',
        // Worded without an example URL: the rule would redact its own
        // description, as it did on the first real run.
        'url-credentials: the user and password written before the @ in a URL',
        'jwt: eyJ….….… tokens',
        keepEmails
          ? 'email: NOT applied — personal data was requested for this bundle'
          : 'email: email addresses',
      ],
    },
    neverIncluded: NEVER_INCLUDED,
    excluded: input.includesPersonalData
      ? [...NEVER_INCLUDED]
      : [...NEVER_INCLUDED, ...EXCLUDED_BY_DEFAULT],
    hostSideCollection: `Container logs, docker state, systemd timers and journald are collected by ${HOST_SCRIPT} on the host. It accepts this archive with --include so support receives one file.`,
  };

  const manifestText = redact(pretty(manifest), secrets, { keepEmails }).text;

  const order = (name: string): string =>
    name === 'summary.txt' ? '0' : name.startsWith('logs/') ? `2${name}` : `1${name}`;

  return {
    manifest,
    fileName: bundleFileName(input.api.host, to, input.includesPersonalData),
    generatedAt: to,
    entries: [
      { name: 'manifest.json', content: Buffer.from(manifestText, 'utf8') },
      ...files
        .sort((a, b) => order(a.name).localeCompare(order(b.name)))
        .map((file) => ({ name: file.name, content: Buffer.from(file.text, 'utf8') })),
    ],
  };
}
