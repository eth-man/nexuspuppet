import { userDnPatternProblem } from '@nexuspuppet/contracts';
import {
  InvalidUsernameError,
  buildBindIdentity,
  escapeDnValue,
  isDnPattern,
  signInParts,
} from './dn';
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

/**
 * Values that would add an RDN, add a multi-valued RDN, end the value, or
 * start a hex-encoded one. Each must land as ONE attribute value of the ONE
 * RDN the pattern put it in, and decode back to exactly what it was.
 */
const ADVERSARIAL = [
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

/** Assert `identity` is `<attr>=<one escaped value>,<rest>` and the value decodes to `value`. */
function expectOneValue(identity: string, attr: string, rest: string[], value: string): void {
  const parts = rdns(identity);
  expect(parts).toHaveLength(1 + rest.length);
  expect(parts.slice(1)).toEqual(rest);
  expect(parts[0]!.startsWith(`${attr}=`)).toBe(true);
  // No unescaped `+` (a second attribute in the RDN) or `=` after the first.
  expect(parts[0]!.slice(attr.length + 1)).not.toMatch(/(^|[^\\])(\\\\)*[+=]/);
  expect(unescape(parts[0]!.slice(attr.length + 1))).toBe(value);
}

describe('signInParts', () => {
  it('takes {username} from before the LAST @', () => {
    expect(signInParts('alice@example.com')).toEqual({
      email: 'alice@example.com',
      username: 'alice',
    });
    expect(signInParts('a@b@example.com')).toEqual({
      email: 'a@b@example.com',
      username: 'a@b',
    });
  });

  it('treats an address with no @ as all username', () => {
    expect(signInParts('alice')).toEqual({ email: 'alice', username: 'alice' });
  });
});

describe('buildBindIdentity with a {username} DN pattern', () => {
  it('uses the part of the address before the @', () => {
    expect(buildBindIdentity(DN_PATTERN, 'alice@example.com')).toBe(
      'uid=alice,ou=people,dc=example,dc=com',
    );
  });

  it.each(ADVERSARIAL)('keeps %j inside the uid value', (local) => {
    expectOneValue(
      buildBindIdentity(DN_PATTERN, `${local}@example.com`),
      'uid',
      ['ou=people', 'dc=example', 'dc=com'],
      local,
    );
  });

  it('does not interpret $ sequences as replacement patterns', () => {
    expect(buildBindIdentity(DN_PATTERN, "$&$'$`@example.com")).toBe(
      "uid=$&$'$`,ou=people,dc=example,dc=com",
    );
  });

  it('refuses an empty address, and an address with nothing before the @', () => {
    expect(() => buildBindIdentity(DN_PATTERN, '')).toThrow(InvalidUsernameError);
    expect(() => buildBindIdentity(DN_PATTERN, '@example.com')).toThrow(InvalidUsernameError);
  });

  it('refuses a control character', () => {
    expect(() => buildBindIdentity(DN_PATTERN, 'alice\u0000@example.com')).toThrow(
      InvalidUsernameError,
    );
  });
});

describe('buildBindIdentity with an {email} DN pattern', () => {
  const EMAIL_DN = 'cn={email},ou=people,dc=example,dc=com';

  it('uses the whole address as the value', () => {
    expect(buildBindIdentity(EMAIL_DN, 'erin@example.com')).toBe(
      'cn=erin@example.com,ou=people,dc=example,dc=com',
    );
  });

  it.each(ADVERSARIAL)('keeps %j@example.com inside the cn value', (local) => {
    expectOneValue(
      buildBindIdentity(EMAIL_DN, `${local}@example.com`),
      'cn',
      ['ou=people', 'dc=example', 'dc=com'],
      `${local}@example.com`,
    );
  });

  it('escapes a DN hidden in the domain part too', () => {
    expectOneValue(
      buildBindIdentity(EMAIL_DN, 'alice@x,ou=admins,dc=example,dc=com'),
      'cn',
      ['ou=people', 'dc=example', 'dc=com'],
      'alice@x,ou=admins,dc=example,dc=com',
    );
  });
});

describe('buildBindIdentity with {username}@domain', () => {
  it('puts the part before the @ into the configured domain', () => {
    expect(buildBindIdentity(UPN_PATTERN, 'jdoe@example.com')).toBe('jdoe@corp.example');
    expect(buildBindIdentity(UPN_PATTERN, 'j.doe-2_x@example.com')).toBe('j.doe-2_x@corp.example');
  });

  /**
   * A UPN is not a DN, so there is nothing to escape into. Anything that could
   * name a different account — another domain, a down-level name, a DN — is
   * refused instead.
   */
  it.each([
    'jdoe@other@example.com', // the username would carry an @: another domain
    'CORP\\administrator@example.com', // a down-level name
    'cn=admin,dc=corp@example.com', // a DN
    'jdoe,ou=x@example.com',
    'jdoe;x@example.com',
    'jdoe+x@example.com',
    'j doe@example.com',
    'jdoe\t@example.com',
    'jdoe\u0000@example.com',
    '*@example.com',
    'jdoe)(objectClass=*@example.com',
    '"jdoe"@example.com',
    '<jdoe>@example.com',
    '@example.com',
  ])('refuses %j', (address) => {
    expect(() => buildBindIdentity(UPN_PATTERN, address)).toThrow(InvalidUsernameError);
  });
});

/**
 * {email} — what an AD UPN is, and what people sign in with. The address
 * itself becomes the bind identity, so it must be exactly one plain user@domain.
 */
describe('buildBindIdentity with {email}', () => {
  it('binds as the address signed in with', () => {
    expect(buildBindIdentity('{email}', 'alice.admin@corp.local')).toBe('alice.admin@corp.local');
  });

  it.each([
    'alice', // no domain
    '@corp.local',
    'alice@',
    'alice@corp@evil.example', // two domains
    'al ice@corp.local',
    'alice@corp local',
    'CORP\\alice@corp.local',
    'cn=alice,dc=corp@corp.local',
    'alice@corp.local,ou=x',
    'alice\u0000@corp.local',
    'alice@corp.local\n',
    '*@corp.local',
    '"alice"@corp.local',
  ])('refuses %j', (address) => {
    expect(() => buildBindIdentity('{email}', address)).toThrow(InvalidUsernameError);
  });
});

describe('the User DN pattern itself', () => {
  it.each([
    '{email}',
    'uid={username},ou=people,dc=example,dc=com',
    'cn={username},ou=Users,dc=corp,dc=example',
    'cn={email},ou=people,dc=example,dc=com',
    'mail={email},ou=people,dc=example,dc=com',
    'cn={username}+sn=x,dc=example',
    '{username}@corp.example',
    '{username}@CORP.EXAMPLE.COM',
  ])('accepts %j', (pattern) => {
    expect(userDnPatternProblem(pattern)).toBeNull();
  });

  it.each([
    ['no placeholder', 'uid=alice,dc=example'],
    ['two placeholders', 'uid={username},cn={username},dc=example'],
    ['both placeholders', 'uid={username},cn={email},dc=example'],
    ['both placeholders, as a UPN', '{username}@{email}'],
    ['placeholder inside a value', 'uid=x{username},dc=example'],
    ['{email} inside a value', 'cn=x{email},dc=example'],
    ['placeholder as an attribute type', '{username}=x,dc=example'],
    ['bare {username}', '{username}'],
    ['{email} with a domain after it', '{email}@corp.example'],
    ['down-level name', 'CORP\\{username}'],
    ['UPN with spaces', '{username}@corp example'],
    ['UPN with a second @', '{username}@x@corp.example'],
    ['control character', 'uid={username},dc=example\n'],
  ])('refuses a pattern with %s', (_why, pattern) => {
    expect(userDnPatternProblem(pattern)).not.toBeNull();
  });

  it('points a bare {username} at {email}, the pattern Active Directory needs', () => {
    expect(userDnPatternProblem('{username}')).toMatch(/\{email\} for Active Directory/);
  });

  it('tells a DN pattern from a UPN one by the =', () => {
    expect(isDnPattern(DN_PATTERN)).toBe(true);
    expect(isDnPattern(UPN_PATTERN)).toBe(false);
    expect(isDnPattern('{email}')).toBe(false);
  });

  it('will not build an identity from an unusable pattern', () => {
    expect(() => buildBindIdentity('{username}', 'alice@example.com')).toThrow(
      /Unusable User DN pattern/,
    );
  });
});
