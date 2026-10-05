import { userDnPatternProblem } from '@nexuspuppet/contracts';
import { InvalidUsernameError, buildBindIdentity, escapeDnValue, isDnPattern } from './dn';
import { escapeFilterValue } from './filter';

/**
 * The username becomes part of the identity a Simple bind authenticates as
 * (ADR-0030 §3). These pin that no username can change WHICH identity that is.
 */

const DN_PATTERN = 'uid={username},ou=people,dc=example,dc=com';
const UPN_PATTERN = '{username}@corp.example';

/**
 * Split a DN into RDNs the way a server does: on commas that are not escaped.
 * If an escaped username ever produced an extra RDN, this would see it.
 */
function rdns(dn: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < dn.length; i += 1) {
    const char = dn[i]!;
    if (char === '\\') {
      current += char + (dn[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Undo RFC 4514 backslash escapes, to prove nothing was lost. */
function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

describe('escapeDnValue (RFC 4514)', () => {
  it.each([
    [',', '\\,'],
    ['+', '\\+'],
    ['"', '\\"'],
    ['\\', '\\\\'],
    ['<', '\\<'],
    ['>', '\\>'],
    [';', '\\;'],
    ['=', '\\='],
  ])('escapes %s', (input, expected) => {
    expect(escapeDnValue(`a${input}b`)).toBe(`a${expected}b`);
  });

  it('escapes a leading space and a leading #, which change meaning only at the start', () => {
    expect(escapeDnValue(' alice')).toBe('\\ alice');
    expect(escapeDnValue('#alice')).toBe('\\#alice');
    expect(escapeDnValue('al#ice')).toBe('al#ice');
  });

  it('escapes a trailing space, which a server would otherwise trim away', () => {
    expect(escapeDnValue('alice ')).toBe('alice\\ ');
    expect(escapeDnValue('al ice')).toBe('al ice');
  });

  it('escapes a value that is a single space at both ends at once', () => {
    expect(escapeDnValue(' ')).toBe('\\ ');
  });

  it('refuses control characters rather than encoding them', () => {
    for (const bad of ['ali\u0000ce', 'alice\n', '\u001b[0m', 'a\u007f']) {
      expect(() => escapeDnValue(bad)).toThrow(InvalidUsernameError);
    }
  });

  it('passes UTF-8 through unchanged', () => {
    expect(escapeDnValue('Zoë Ångström')).toBe('Zoë Ångström');
  });

  /** It is not the filter escaping: the two sets differ, in both directions. */
  it('differs from RFC 4515 filter escaping', () => {
    expect(escapeDnValue('a*b(c)')).toBe('a*b(c)');
    expect(escapeFilterValue('a,b+c')).toBe('a,b+c');
  });
});

describe('buildBindIdentity with a DN pattern', () => {
  /**
   * Usernames that would add an RDN, add a multi-valued RDN, end the value,
   * or start a hex-encoded one. Each must land as ONE attribute value of the
   * ONE RDN the pattern put it in, and decode back to exactly what was typed.
   */
  const adversarial = [
    'alice,ou=admins',
    'alice,dc=example,dc=com',
    'alice+cn=admin',
    'alice"',
    '"alice"',
    'alice\\',
    'alice\\,ou=admins',
    '<alice>',
    'alice;ou=admins',
    'uid=admin',
    'alice=',
    ' alice',
    'alice ',
    '#616c696365',
    '\\2c',
    'a,b+c"d\\e<f>g;h=i',
  ];

  it.each(adversarial)('keeps %j inside the uid value', (username) => {
    const identity = buildBindIdentity(DN_PATTERN, username);
    const parts = rdns(identity);

    expect(parts).toHaveLength(4);
    expect(parts.slice(1)).toEqual(['ou=people', 'dc=example', 'dc=com']);
    expect(parts[0]!.startsWith('uid=')).toBe(true);
    // No unescaped `+` (a second attribute in the RDN) or `=` after the first.
    expect(parts[0]!.slice(4)).not.toMatch(/(^|[^\\])(\\\\)*[+=]/);
    expect(unescape(parts[0]!.slice(4))).toBe(username);
  });

  it('builds the ordinary case unchanged', () => {
    expect(buildBindIdentity(DN_PATTERN, 'alice')).toBe('uid=alice,ou=people,dc=example,dc=com');
  });

  it('does not interpret $ sequences from the username as replacement patterns', () => {
    expect(buildBindIdentity(DN_PATTERN, "$&$'$`")).toBe("uid=$&$'$`,ou=people,dc=example,dc=com");
  });

  it('refuses an empty username', () => {
    expect(() => buildBindIdentity(DN_PATTERN, '')).toThrow(InvalidUsernameError);
  });

  it('refuses a control character', () => {
    expect(() => buildBindIdentity(DN_PATTERN, 'alice\u0000')).toThrow(InvalidUsernameError);
  });
});

describe('buildBindIdentity with a UPN pattern', () => {
  it('builds the ordinary case', () => {
    expect(buildBindIdentity(UPN_PATTERN, 'jdoe')).toBe('jdoe@corp.example');
    expect(buildBindIdentity(UPN_PATTERN, 'j.doe-2_x')).toBe('j.doe-2_x@corp.example');
  });

  /**
   * A UPN is not a DN, so there is nothing to escape into. Anything that could
   * name a different account — another domain, a down-level name, a DN — is
   * refused instead.
   */
  it.each([
    'jdoe@other.example', // a different domain
    'CORP\\administrator', // a down-level name
    'cn=admin,dc=corp', // a DN
    'jdoe,ou=x',
    'jdoe;x',
    'jdoe+x',
    'j doe',
    ' jdoe',
    'jdoe\t',
    'jdoe\u0000',
    'jdoe\n',
    '*',
    'jdoe)(objectClass=*',
    '"jdoe"',
    '<jdoe>',
  ])('refuses %j', (username) => {
    expect(() => buildBindIdentity(UPN_PATTERN, username)).toThrow(InvalidUsernameError);
  });

  it('refuses an empty username', () => {
    expect(() => buildBindIdentity(UPN_PATTERN, '')).toThrow(InvalidUsernameError);
  });
});

describe('the User DN pattern itself', () => {
  it.each([
    'uid={username},ou=people,dc=example,dc=com',
    'cn={username},ou=Users,dc=corp,dc=example',
    'cn={username}+sn=x,dc=example',
    '{username}@corp.example',
    '{username}@CORP.EXAMPLE.COM',
  ])('accepts %j', (pattern) => {
    expect(userDnPatternProblem(pattern)).toBeNull();
  });

  it.each([
    ['no placeholder', 'uid=alice,dc=example'],
    ['two placeholders', 'uid={username},cn={username},dc=example'],
    ['placeholder inside a value', 'uid=x{username},dc=example'],
    ['placeholder as an attribute type', '{username}=x,dc=example'],
    ['bare placeholder', '{username}'],
    ['down-level name', 'CORP\\{username}'],
    ['UPN with spaces', '{username}@corp example'],
    ['UPN with a second @', '{username}@x@corp.example'],
    ['control character', 'uid={username},dc=example\n'],
  ])('refuses a pattern with %s', (_why, pattern) => {
    expect(userDnPatternProblem(pattern)).not.toBeNull();
  });

  it('tells a DN pattern from a UPN one by the =', () => {
    expect(isDnPattern(DN_PATTERN)).toBe(true);
    expect(isDnPattern(UPN_PATTERN)).toBe(false);
  });

  it('will not build an identity from an unusable pattern', () => {
    expect(() => buildBindIdentity('{username}', 'alice')).toThrow(/Unusable User DN pattern/);
  });
});
