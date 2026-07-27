import { createHash } from 'node:crypto';
import { stringify, parse } from 'yaml';
import { PUPPET_CLASS_NAME, type EncDocument, type PuppetValue } from '@nexuspuppet/contracts';

/**
 * Deterministic YAML rendering for the ENC handoff (ADR-0003, ADR-0009).
 *
 * DETERMINISM IS LOAD-BEARING, not cosmetic. Identical input must produce
 * byte-identical output, because the content hash of this string is what
 * decides whether a file is rewritten. Non-deterministic key ordering would
 * cause every materialization pass to rewrite every file and bump every
 * revision, turning a no-op into estate-wide churn.
 *
 * `node:crypto` is imported here for hashing only — it is deterministic and
 * involves no I/O, clock, or randomness.
 */

export class InvalidEncDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEncDocumentError';
  }
}

export interface RenderedEnc {
  yaml: string;
  /** SHA-256 of `yaml`, stored as EncMaterialization.contentHash. */
  contentHash: string;
}

const YAML_OPTIONS = {
  // The single most important option in this file.
  sortMapEntries: true,
  indent: 2,
  lineWidth: 0,
} as const;

/**
 * Render an ENC document, validate it, and hash it.
 *
 * @throws InvalidEncDocumentError if a class name is invalid or the rendered
 *         YAML does not survive a round trip.
 */
export function renderEncDocument(document: EncDocument): RenderedEnc {
  assertValidClassNames(document);

  const payload = {
    classes: sortRecord(document.classes),
    parameters: sortRecord(document.parameters),
    ...(document.environment === undefined ? {} : { environment: document.environment }),
  };

  const body = stringify(payload, YAML_OPTIONS);

  // A header costs nothing and answers "what wrote this file?" for the operator
  // who finds it during an incident. It is deterministic — no timestamp — so it
  // does not perturb the content hash.
  const yaml = `---\n# Managed by NexusPuppet. Do not edit by hand; changes are overwritten.\n${body}`;

  assertRoundTrips(yaml, payload);

  return {
    yaml,
    contentHash: createHash('sha256').update(yaml, 'utf8').digest('hex'),
  };
}

/**
 * The classification a node receives when it matches no groups, or has not been
 * materialized yet. Always present on disk so an unknown node gets a defined,
 * safe result instead of a compilation failure (ADR-0003).
 */
export function renderDefaultDocument(environment?: string): RenderedEnc {
  return renderEncDocument({
    classes: {},
    parameters: {},
    ...(environment === undefined ? {} : { environment }),
  });
}

function assertValidClassNames(document: EncDocument): void {
  for (const className of Object.keys(document.classes)) {
    if (!PUPPET_CLASS_NAME.test(className)) {
      // Caught at write time rather than during catalog compilation, where it
      // would surface as an opaque failure on the agent.
      throw new InvalidEncDocumentError(
        `"${className}" is not a valid Puppet class name (expected e.g. profile::base)`,
      );
    }
  }
}

/**
 * Parse the rendered YAML back and compare structurally. A document that fails
 * to round-trip is never written — a malformed ENC file would be applied to
 * real machines.
 */
function assertRoundTrips(yaml: string, expected: unknown): void {
  let reparsed: unknown;
  try {
    reparsed = parse(yaml);
  } catch (error) {
    throw new InvalidEncDocumentError(
      `Rendered YAML could not be parsed back: ${(error as Error).message}`,
    );
  }

  if (!deepEquals(reparsed, expected)) {
    throw new InvalidEncDocumentError(
      'Rendered YAML did not survive a round trip; refusing to write.',
    );
  }
}

/** Recursively sort object keys so output ordering never depends on insertion order. */
function sortRecord<T>(input: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key] as T;
    out[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (sortRecord(value as Record<string, PuppetValue>) as unknown as T)
        : value;
  }
  return out;
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEquals(item, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) =>
      deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }

  return false;
}
