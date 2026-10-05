import {
  LDAP_EMAIL_PLACEHOLDER,
  LDAP_USERNAME_PLACEHOLDER,
  hasControlCharacter,
  userDnPatternProblem,
} from '@nexuspuppet/contracts';

/**
 * Building the identity a Simple bind authenticates as (ADR-0030 §3).
 *
 * Simple bind has no service account to look the person up, so the bind
 * identity is MADE from what they typed: `uid={username},ou=people,…` or
 * `{username}@corp.example`. That makes the username part of the identity a
 * directory checks the password against, and an unescaped one can change
 * which identity that is — `alice,ou=admins` turns one RDN into two.
 *
 * DN escaping is NOT filter escaping. `filter.ts` implements RFC 4515, whose
 * metacharacters are `* ( ) \ NUL`; a DN's are `, + " \ < > ; =`, plus a
 * leading space or `#` and a trailing space (RFC 4514 §2.4). A filter-escaped
 * value is not safe in a DN, and the other way round.
 */

/** Characters that must be escaped anywhere in a DN attribute value (RFC 4514 §2.4). */
const DN_SPECIALS = new Set([',', '+', '"', '\\', '<', '>', ';', '=']);

/** A sign-in name that cannot be turned into a bind identity. */
export class InvalidUsernameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUsernameError';
  }
}

/**
 * Escape a value for use as a DN attribute value (RFC 4514 §2.4).
 *
 * Every special is written as a backslash and the character itself — the
 * form both RFC 4514 and the older RFC 2253 accept, so Active Directory and
 * OpenLDAP read it the same way. Control characters are refused rather than
 * hex-escaped: nobody's username contains one, and a value that does is an
 * attempt, not a typo.
 */
export function escapeDnValue(value: string): string {
  if (hasControlCharacter(value)) {
    throw new InvalidUsernameError('The username contains a control character.');
  }

  const chars = Array.from(value);
  return chars
    .map((char, index) => {
      if (DN_SPECIALS.has(char)) return `\\${char}`;
      if (index === 0 && (char === ' ' || char === '#')) return `\\${char}`;
      if (index === chars.length - 1 && char === ' ') return '\\ ';
      return char;
    })
    .join('');
}

/**
 * Characters refused in the username part of a UPN-style pattern.
 *
 * A UPN is not a DN, so there is nothing to escape INTO: a second `@` names a
 * different domain, a `\` makes it a down-level `DOMAIN\user` name, and the
 * DN specials would let it be read as a DN. None of them belongs in the local
 * part of a sign-in name, so they are refused, along with whitespace and
 * anything a filter would treat specially.
 */
const UPN_FORBIDDEN = /[\s@\\,;=+<>"()*/[\]:|?]/;

/**
 * The two values a pattern can take from the sign-in address.
 *
 * `email` is the address exactly as the caller normalised it — the provider
 * passes what the resolver looked the account up by, trimmed and lower-cased —
 * and `username` is everything before its LAST `@`. An address with no `@`
 * has no domain, so its username is the whole of it.
 */
export function signInParts(address: string): { email: string; username: string } {
  const at = address.lastIndexOf('@');
  return { email: address, username: at === -1 ? address : address.slice(0, at) };
}

/**
 * The sign-in address placed into the pattern, escaped or validated for its
 * context (ADR-0030 §3).
 *
 * - **DN pattern:** the `{email}` or `{username}` value is escaped for DN
 *   context, so no address can add an RDN, add a value to one, or end it.
 * - **`{username}@domain`:** the username must be a plain local part — no
 *   `@`, which would move it to another domain, and nothing else that could
 *   name a different account.
 * - **`{email}`:** exactly one `@`, with a plain local part and a plain domain
 *   on either side of it.
 */
export function buildBindIdentity(pattern: string, address: string): string {
  const problem = userDnPatternProblem(pattern);
  if (problem !== null) throw new Error(`Unusable User DN pattern: ${problem}`);
  if (address === '') throw new InvalidUsernameError('The sign-in address is empty.');

  const usesEmail = pattern.includes(LDAP_EMAIL_PLACEHOLDER);
  const placeholder = usesEmail ? LDAP_EMAIL_PLACEHOLDER : LDAP_USERNAME_PLACEHOLDER;
  const { email, username } = signInParts(address);
  const value = usesEmail ? email : username;
  if (value === '') throw new InvalidUsernameError('The sign-in name is empty.');

  if (isDnPattern(pattern)) {
    return pattern.replace(placeholder, () => escapeDnValue(value));
  }

  const plain = (part: string) =>
    part !== '' && !hasControlCharacter(part) && !UPN_FORBIDDEN.test(part);

  if (usesEmail) {
    const at = email.indexOf('@');
    const valid =
      at > 0 &&
      at === email.lastIndexOf('@') &&
      plain(email.slice(0, at)) &&
      plain(email.slice(at + 1));
    if (!valid) {
      throw new InvalidUsernameError('The sign-in address is not a plain user@domain.');
    }
    return email;
  }

  if (!plain(username)) {
    throw new InvalidUsernameError('The username contains a character a UPN cannot hold.');
  }
  return pattern.replace(placeholder, () => username);
}

/** A pattern with `=` is a DN; one without is a UPN (`{email}` or `{username}@domain`). */
export function isDnPattern(pattern: string): boolean {
  return pattern.includes('=');
}
