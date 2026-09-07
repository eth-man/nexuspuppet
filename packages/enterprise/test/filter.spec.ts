import { buildFilter, escapeFilterValue } from '../src/ldap/filter';

/**
 * LDAP filter injection is the LDAP analogue of SQL injection, and the payoff
 * for an attacker is higher here: a filter that matches everything returns the
 * first directory entry, which the provider then binds against.
 */
describe('escapeFilterValue', () => {
  it('escapes the RFC 4515 metacharacters', () => {
    expect(escapeFilterValue('*')).toBe('\\2a');
    expect(escapeFilterValue('(')).toBe('\\28');
    expect(escapeFilterValue(')')).toBe('\\29');
    expect(escapeFilterValue('\\')).toBe('\\5c');
    expect(escapeFilterValue('\0')).toBe('\\00');
  });

  it('leaves ordinary text, including UTF-8, alone', () => {
    expect(escapeFilterValue('alice@example.com')).toBe('alice@example.com');
    expect(escapeFilterValue('Ané Müller')).toBe('Ané Müller');
  });

  it('escapes control characters some directories mishandle', () => {
    expect(escapeFilterValue('a\nb')).toBe('a\\0ab');
    expect(escapeFilterValue('a\x7fb')).toBe('a\\7fb');
  });

  it('neutralises a wildcard that would otherwise match every entry', () => {
    // `(mail=*)` matches the whole directory; the provider would then bind
    // against whichever entry came back first.
    expect(buildFilter('(mail={{input}})', '*')).toBe('(mail=\\2a)');
  });

  it('neutralises an attempt to close the clause and append another', () => {
    const payload = 'x)(|(uid=*';
    expect(buildFilter('(&(objectClass=person)(mail={{input}}))', payload)).toBe(
      '(&(objectClass=person)(mail=x\\29\\28|\\28uid=\\2a))',
    );
    // Examine only the substituted value: the template's own parentheses are
    // legitimate structure, so scanning the whole filter would flag those too.
    expect(escapeFilterValue(payload)).not.toMatch(/[()*\\](?![0-9a-f]{2})/);
  });
});

describe('buildFilter', () => {
  it('substitutes every occurrence of the placeholder', () => {
    expect(buildFilter('(|(uid={{input}})(mail={{input}}))', 'bob')).toBe(
      '(|(uid=bob)(mail=bob))',
    );
  });

  /**
   * A template without the placeholder ignores the username entirely, matches
   * the whole subtree, and authenticates whoever happens to be first. It has to
   * be impossible to configure, not merely discouraged.
   */
  it('refuses a template that ignores the supplied identifier', () => {
    expect(() => buildFilter('(objectClass=person)', 'bob')).toThrow(/must contain/i);
  });
});
