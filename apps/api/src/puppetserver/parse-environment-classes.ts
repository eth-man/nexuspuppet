import type {
  ClassFileError,
  ClassParameterSuggestion,
  ClassSuggestion,
} from '@nexuspuppet/contracts';

/**
 * Turn a `/puppet/v3/environment_classes` body into suggestions (ADR-0024).
 *
 * PURE. No I/O, no clock. Everything the caller needs to decide staleness is
 * stamped outside this file.
 *
 * TOLERANT BY CONSTRUCTION. This parses a payload from another team's server,
 * across versions we do not control. Anything unrecognised is skipped rather
 * than thrown, because a single odd entry must never blank a picker whose whole
 * purpose is to stop operators guessing. What cannot be skipped silently — a
 * manifest puppetserver itself failed to parse — is returned as a file error so
 * the operator learns their class is missing because a FILE is broken.
 */

/** Shape actually returned by puppetserver, verified against OpenVox 8.15.2. */
interface RawParam {
  name?: unknown;
  type?: unknown;
  default_literal?: unknown;
  default_source?: unknown;
}

interface RawClass {
  name?: unknown;
  params?: unknown;
}

interface RawFile {
  path?: unknown;
  classes?: unknown;
  error?: unknown;
}

export interface ParsedEnvironmentClasses {
  classes: ClassSuggestion[];
  fileErrors: ClassFileError[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Options inside `Enum['absent', 'present']`, so the form can offer a select.
 *
 * Deliberately a narrow regex over the type signature rather than a Puppet type
 * parser. Anything more elaborate is a second implementation of Puppet's type
 * system that we would have to keep in step with it; if this does not match, the
 * field falls back to free text and nothing is lost.
 */
export function parseEnumValues(type: string | null): string[] {
  if (type === null) return [];
  const match = /^Enum\[(.*)\]$/s.exec(type.trim());
  if (match === null) return [];

  const inner = match[1];
  if (inner === undefined) return [];

  const values: string[] = [];
  // Only quoted members are taken. A bare or interpolated member is not a
  // literal choice we can safely offer.
  const member = /'([^']*)'|"([^"]*)"/g;
  let found: RegExpExecArray | null = member.exec(inner);
  while (found !== null) {
    const value = found[1] ?? found[2];
    if (value !== undefined) values.push(value);
    found = member.exec(inner);
  }
  return values;
}

function parseParam(raw: unknown): ClassParameterSuggestion | null {
  if (!isRecord(raw)) return null;
  const param = raw as RawParam;

  const name = asString(param.name);
  if (name === null || name === '') return null;

  const type = asString(param.type);
  const source = asString(param.default_source);
  const enumValues = parseEnumValues(type);

  // `default_literal` present means a value we can prefill. It may legitimately
  // be false, 0 or "" — so presence of the KEY decides, not truthiness. Reading
  // this as `if (param.default_literal)` would silently turn every
  // `false` default into "required", which is the kind of wrong that looks
  // right in every test written with a string.
  if (Object.hasOwn(param, 'default_literal')) {
    return {
      name,
      type,
      kind: 'literal',
      defaultValue: param.default_literal,
      ...(source === null ? {} : { defaultSource: source }),
      enumValues,
    };
  }

  // A `$`-prefixed source is a reference to another variable, resolved at
  // compile time — not a value. Smart Proxy rewrites these to `${…}` for the
  // same reason. Prefilling the literal text "$facts" would be quietly wrong,
  // so the source is shown as a hint and nothing is prefilled.
  if (source !== null && source.startsWith('$')) {
    return { name, type, kind: 'expression', defaultSource: source, enumValues };
  }

  // `undef` is Puppet for "no default value", not a default of the string
  // "undef". Anything else non-literal is still an expression we cannot prefill.
  if (source !== null && source !== 'undef') {
    return { name, type, kind: 'expression', defaultSource: source, enumValues };
  }

  // Neither a literal nor a usable source: the parameter is REQUIRED, and this
  // is the single most useful thing the form can know. `pubkey` versus `users`
  // in the measured payload is exactly this distinction.
  return {
    name,
    type,
    kind: 'required',
    ...(source === null ? {} : { defaultSource: source }),
    enumValues,
  };
}

export function parseEnvironmentClasses(body: unknown): ParsedEnvironmentClasses {
  const classes: ClassSuggestion[] = [];
  const fileErrors: ClassFileError[] = [];

  if (!isRecord(body) || !Array.isArray(body.files)) {
    return { classes, fileErrors };
  }

  for (const entry of body.files) {
    if (!isRecord(entry)) continue;
    const file = entry as RawFile;
    const path = asString(file.path);

    // A file puppetserver could not parse carries `error` instead of `classes`.
    // Surfaced, never swallowed: an operator hunting a class that is missing
    // because its manifest is broken should be told which file.
    if (file.error !== undefined && file.error !== null) {
      const message = isRecord(file.error)
        ? (asString(file.error.msg) ?? asString(file.error.kind) ?? 'could not be parsed')
        : (asString(file.error) ?? 'could not be parsed');
      fileErrors.push({ path, message });
      continue;
    }

    if (!Array.isArray(file.classes)) continue;

    for (const rawClass of file.classes) {
      if (!isRecord(rawClass)) continue;
      const klass = rawClass as RawClass;
      const name = asString(klass.name);
      if (name === null || name === '') continue;

      const params = Array.isArray(klass.params)
        ? klass.params.map(parseParam).filter((p): p is ClassParameterSuggestion => p !== null)
        : [];

      classes.push({ name, path, params });
    }
  }

  // Sorted so the picker is stable between fetches. puppetserver's order
  // follows the filesystem, which is not an order anybody can predict, and a
  // list that reshuffles on every refresh is hard to trust.
  classes.sort((a, b) => a.name.localeCompare(b.name));

  return { classes, fileErrors };
}
