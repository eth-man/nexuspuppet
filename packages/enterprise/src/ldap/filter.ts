/**
 * LDAP search-filter construction.
 *
 * This is the LDAP counterpart of the rule that governs PuppetDB queries in
 * core: NEVER interpolate user input into a filter. An unescaped `*` in the
 * username turns `(uid=alice)` into `(uid=*)`, which matches the first entry in
 * the directory — frequently a service account. Worse, `(uid=x)(|(uid=*))` can
 * append clauses the author never wrote.
 *
 * The escaping below is RFC 4515 §3: the four filter metacharacters plus NUL
 * must be written as a backslash followed by two hex digits. Everything else is
 * passed through, including UTF-8, which RFC 4515 permits.
 */

/** Characters that change the MEANING of a filter, per RFC 4515 §3. */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\5c'], // must be first conceptually; Map order is irrelevant here
  ['*', '\\2a'],
  ['(', '\\28'],
  [')', '\\29'],
  ['\0', '\\00'],
]);

/**
 * Escape a value for use inside an LDAP filter (RFC 4515 §3).
 *
 * Also escapes the DEL character and every C0 control, which some directory
 * servers mishandle and which have no legitimate place in a username.
 */
export function escapeFilterValue(value: string): string {
  let out = '';
  for (const char of value) {
    const mapped = ESCAPES.get(char);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(16).padStart(2, '0')}`;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Build a search filter from a template, escaping every substitution.
 *
 * The template uses `{{input}}` as the placeholder for the supplied identifier,
 * so an operator can express any filter their directory needs — a `uid` lookup,
 * a `mail` lookup, one constrained by `objectClass` — without this package
 * having to anticipate the schema.
 *
 *   buildFilter('(&(objectClass=person)(mail={{input}}))', 'a*b')
 *     -> '(&(objectClass=person)(mail=a\\2ab))'
 *
 * Throws when the template has no placeholder. A filter that silently ignores
 * the username would match every entry in the directory, and the first result
 * would be bound against — an authentication bypass that looks like a working
 * login.
 */
export function buildFilter(template: string, input: string): string {
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(
      `LDAP search filter template must contain ${PLACEHOLDER}; refusing to run a filter that ignores the supplied identifier.`,
    );
  }
  return template.split(PLACEHOLDER).join(escapeFilterValue(input));
}

export const PLACEHOLDER = '{{input}}';
