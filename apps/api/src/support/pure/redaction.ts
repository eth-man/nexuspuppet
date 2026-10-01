/**
 * The redaction pass every text file in a support bundle goes through before
 * it is archived (ADR-0028 §4).
 *
 * PURE: text and a list of known secret values in, text and counts out.
 *
 * It is the SECOND line of defence, not the first. The first is that each
 * collector reads an allow-list of fields — no `secrets` column, no audit
 * payloads, no identities. This pass exists for what an allow-list cannot see:
 * a secret that reached a log line, an error message that quoted a connection
 * string, a key pasted into a field that was never meant to hold one.
 */

export interface SecretValue {
  /** The environment variable (or derived name) the value came from. */
  name: string;
  value: string;
}

export type RedactionRule =
  'secret-value' | 'pem-private-key' | 'url-credentials' | 'jwt' | 'email';

export type RedactionCounts = Record<RedactionRule, number>;

export const emptyCounts = (): RedactionCounts => ({
  'secret-value': 0,
  'pem-private-key': 0,
  'url-credentials': 0,
  jwt: 0,
  email: 0,
});

/**
 * Shorter than this and a literal replacement does more harm than good: a
 * six-character password is also a substring of ordinary words, hostnames and
 * hashes, and blanking every occurrence makes the bundle unreadable while
 * protecting nothing a guess would not find. Values this short are reported in
 * the manifest BY NAME as not redacted, so the operator knows.
 */
export const MIN_SECRET_LENGTH = 6;

export interface PreparedSecrets {
  /** Longest first, so a value containing another is replaced whole. */
  patterns: Array<{ name: string; needle: string }>;
  /**
   * Every name whose value is searched for — including one whose value is
   * identical to another's and so shares its needle (POSTGRES_PASSWORD and the
   * password inside DATABASE_URL, typically). Reporting only the name a match
   * is labelled with made a searched secret look unsearched.
   */
  searched: string[];
  /** Names skipped because their value was too short to redact safely. */
  tooShort: string[];
}

/**
 * Turn raw secret values into the literal needles to search for.
 *
 * Each value is searched both as-is and JSON-escaped, because most of the
 * bundle is JSON: a secret containing `"` or `\` appears in a serialised file
 * as `\"` or `\\`, and a literal search for the raw value would walk past it.
 */
export function prepareSecrets(secrets: readonly SecretValue[]): PreparedSecrets {
  // needle -> the name it is labelled with. When two names share a value, the
  // alphabetically first labels it, so the result never depends on the order
  // the environment happened to enumerate in.
  const byNeedle = new Map<string, string>();
  const searched = new Set<string>();
  const tooShort = new Set<string>();

  for (const { name, value } of secrets) {
    if (value.length < MIN_SECRET_LENGTH) {
      if (value.length > 0) tooShort.add(name);
      continue;
    }
    searched.add(name);

    const escaped = JSON.stringify(value).slice(1, -1);
    for (const needle of escaped === value ? [value] : [value, escaped]) {
      const existing = byNeedle.get(needle);
      if (existing === undefined || name.localeCompare(existing) < 0) byNeedle.set(needle, name);
    }
  }

  // Longest first, so a value containing another is replaced whole.
  const patterns = [...byNeedle].map(([needle, name]) => ({ name, needle }));
  patterns.sort((a, b) => b.needle.length - a.needle.length || a.name.localeCompare(b.name));
  return { patterns, searched: [...searched].sort(), tooShort: [...tooShort].sort() };
}

/*
 * Structural patterns. Each is deliberately conservative about what it
 * matches: a false positive costs a support engineer one field, a false
 * negative ships a credential.
 */

/** A whole PEM private key block — RSA, EC, ENCRYPTED, OPENSSH or plain PKCS#8. */
const PEM_BLOCK =
  /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
/** A BEGIN with no END in the same text — a truncated line, a split log entry. */
const PEM_DANGLING = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[^\n]*/g;
/**
 * `scheme://userinfo@` — a password, or a token used as a username. The
 * lookahead keeps the rule from matching its own replacement, so a second pass
 * over redacted text changes and counts nothing.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED:URL-CREDENTIALS\]@)[^\s/@"'<>]+@/gi;
/** Three base64url segments, the first a JSON header: `eyJ…`. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
/** An email address. Identities are excluded by default (ADR-0028 §4, §6). */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

function countingReplace(
  text: string,
  pattern: RegExp,
  replacement: (match: string, ...groups: string[]) => string,
  onMatch: () => void,
): string {
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    onMatch();
    return replacement(match, ...(rest.filter((part) => typeof part === 'string') as string[]));
  });
}

/**
 * Redact one text. Returns the new text and what was replaced.
 *
 * Order matters and is fixed: literal secrets first, because they are the
 * most specific — a known database password inside a URL is named for what
 * it is rather than reported as a generic URL credential.
 *
 * `keepEmails` turns off the email rule, and nothing else. It is for a bundle
 * whose operator explicitly asked for personal data (ADR-0028 §6): masking the
 * addresses there would defeat the request. Every SECRET rule still runs — no
 * option exists to switch those off, by design.
 */
export function redact(
  text: string,
  secrets: PreparedSecrets,
  options: { keepEmails?: boolean } = {},
): { text: string; counts: RedactionCounts } {
  const counts = emptyCounts();
  let out = text;

  for (const { name, needle } of secrets.patterns) {
    if (!out.includes(needle)) continue;
    const parts = out.split(needle);
    counts['secret-value'] += parts.length - 1;
    out = parts.join(`[REDACTED:${name}]`);
  }

  out = countingReplace(
    out,
    PEM_BLOCK,
    () => '[REDACTED:PEM-PRIVATE-KEY]',
    () => counts['pem-private-key']++,
  );
  out = countingReplace(
    out,
    PEM_DANGLING,
    () => '[REDACTED:PEM-PRIVATE-KEY]',
    () => counts['pem-private-key']++,
  );
  out = countingReplace(
    out,
    URL_USERINFO,
    (_match, scheme) => `${scheme ?? ''}[REDACTED:URL-CREDENTIALS]@`,
    () => counts['url-credentials']++,
  );
  out = countingReplace(
    out,
    JWT,
    () => '[REDACTED:JWT]',
    () => counts.jwt++,
  );
  if (options.keepEmails !== true) {
    out = countingReplace(
      out,
      EMAIL,
      () => '[REDACTED:EMAIL]',
      () => counts.email++,
    );
  }

  return { text: out, counts };
}

export function addCounts(into: RedactionCounts, from: RedactionCounts): RedactionCounts {
  for (const rule of Object.keys(into) as RedactionRule[]) into[rule] += from[rule];
  return into;
}
