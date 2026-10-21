import type { SearchOptions, SearchResult } from 'ldapts';
import { ldapConfigSchema, type LdapConfig } from './config';
import { AD_SEARCH_FILTER, AD_SEARCH_FILTER_WITHOUT_MAIL, dialectDefaults } from './dialect';
import {
  LdapAuthProvider,
  searchedAttributes,
  type LdapIdentityStore,
  type StoredIdentity,
} from './ldap-auth.provider';
import { AMBIGUOUS_SIGN_IN_NAME, LdaptsDirectory, type LdapClientFactory } from './ldap-client';

/**
 * "User not found" from an Active Directory whose mail is not the UPN.
 *
 * Reported by an operator and reproduced on staging against Windows Server
 * 2025: the person's NexusPuppet account was created with their work email,
 * alice.admin@example.com, which is their AD `mail`. Their UPN is
 * alice.admin@corp.local, because the email domain is not the AD domain —
 * the ordinary state of a corporate AD. The resolver found the account by the
 * email; the AD default filter matched only sAMAccountName and
 * userPrincipalName, so the directory found nobody, the login was refused like
 * a wrong password, and NOTHING was logged.
 *
 * These run the real provider and the real LdaptsDirectory against an
 * in-memory directory that evaluates the filter it is sent — so what is under
 * test is the filter the code actually builds, not a fake that says yes.
 */

interface Person {
  dn: string;
  sAMAccountName: string;
  userPrincipalName: string;
  mail: string;
  password: string;
  memberOf: string[];
}

const OPS = 'cn=puppet-ops,ou=groups,dc=corp,dc=local';
const PASSWORD = 'Corr3ct-Horse-Battery';

const ALICE: Person = {
  dn: 'cn=Alice Admin,ou=people,dc=corp,dc=local',
  sAMAccountName: 'alice.admin',
  userPrincipalName: 'alice.admin@corp.local',
  mail: 'alice.admin@example.com',
  password: PASSWORD,
  memberOf: [OPS],
};

/** Somebody else whose MAIL is Alice's UPN — a typo, or a hostile edit. */
const MALLORY: Person = {
  dn: 'cn=Mallory,ou=people,dc=corp,dc=local',
  sAMAccountName: 'mallory',
  userPrincipalName: 'mallory@corp.local',
  mail: 'alice.admin@corp.local',
  password: 'mallory-knows-this',
  memberOf: [OPS],
};

const SERVICE = { dn: 'cn=svc-nexuspuppet,ou=service,dc=corp,dc=local', password: 'svc-pw' };

/**
 * Just enough of an LDAP filter to evaluate the ones these tests send:
 * `&`, `|` and equality, case-insensitive as AD compares these attributes.
 * `objectClass=user` and `objectCategory=person` hold for every person here.
 */
function matches(filter: string, person: Person): boolean {
  const inner = filter.slice(1, -1);
  if (inner.startsWith('&') || inner.startsWith('|')) {
    const parts = children(inner.slice(1));
    return inner.startsWith('&')
      ? parts.every((part) => matches(part, person))
      : parts.some((part) => matches(part, person));
  }
  const at = inner.indexOf('=');
  const attribute = inner.slice(0, at);
  const value = inner.slice(at + 1).toLowerCase();
  if (attribute === 'objectClass') return value === 'user';
  if (attribute === 'objectCategory') return value === 'person';
  const held = (person as unknown as Record<string, unknown>)[attribute];
  return typeof held === 'string' && held.toLowerCase() === value;
}

function children(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (list[i] === ')') {
      depth -= 1;
      if (depth === 0) out.push(list.slice(start, i + 1));
    }
  }
  return out;
}

/** An Active Directory holding `people`, as an ldapts client factory. */
function directoryOf(people: Person[]): { factory: LdapClientFactory; binds: string[] } {
  const binds: string[] = [];
  const factory: LdapClientFactory = () => ({
    startTLS: async () => {},
    bind: async (dn, password) => {
      binds.push(dn);
      const ok =
        (dn === SERVICE.dn && password === SERVICE.password) ||
        people.some((person) => person.dn === dn && person.password === password);
      if (!ok) {
        throw Object.assign(new Error('80090308: AcceptSecurityContext error, data 52e'), {
          code: 49,
        });
      }
    },
    search: async (_base: string, options?: SearchOptions): Promise<SearchResult> => {
      const found = people.filter((person) => matches(String(options?.filter), person));
      const limit = options?.sizeLimit ?? 0;
      if (limit > 0 && found.length > limit) {
        throw Object.assign(new Error('sizeLimitExceeded'), { code: 4 });
      }
      return {
        searchEntries: found.map((person) => ({
          dn: person.dn,
          mail: person.mail,
          displayName: person.dn,
          memberOf: person.memberOf,
        })),
        searchReferences: [],
      };
    },
    unbind: async () => {},
  });
  return { factory, binds };
}

function adConfig(overrides: Record<string, unknown> = {}): LdapConfig {
  return ldapConfigSchema.parse({
    host: 'dc01.corp.local',
    protocol: 'ldaps',
    bindType: 'regular',
    bindDn: SERVICE.dn,
    bindPassword: SERVICE.password,
    searchBase: 'ou=people,dc=corp,dc=local',
    dialect: 'ad',
    roleMappings: [{ groupDn: OPS, role: 'OPERATOR' }],
    ...overrides,
  });
}

function account(email: string): StoredIdentity {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    email,
    displayName: 'Alice (stored)',
    role: 'VIEWER',
    isActive: true,
    authSource: 'ldap',
  };
}

/** Accounts as core stores them: found by the email, lower-cased. */
function accounts(...emails: string[]): LdapIdentityStore {
  return {
    findByEmail: async (email) => (emails.includes(email.toLowerCase()) ? account(email) : null),
    findById: async () => null,
    recordLogin: async () => {},
  };
}

interface Lines {
  log: string[];
  warn: string[];
  error: string[];
}

function spy(): Lines & {
  logger: { log(m: string): void; warn(m: string): void; error(m: string): void };
} {
  const lines: Lines = { log: [], warn: [], error: [] };
  return {
    ...lines,
    logger: {
      log: (m) => lines.log.push(m),
      warn: (m) => lines.warn.push(m),
      error: (m) => lines.error.push(m),
    },
  };
}

function provider(
  config: LdapConfig,
  people: Person[],
  identities: LdapIdentityStore,
  logger = spy().logger,
): { provider: LdapAuthProvider; binds: string[] } {
  const directory = directoryOf(people);
  return {
    provider: new LdapAuthProvider({
      config,
      directory: new LdaptsDirectory(config, logger, directory.factory),
      identities,
      logger,
    }),
    binds: directory.binds,
  };
}

describe('the Active Directory default filter', () => {
  it('matches the sign-in address against mail, as well as the UPN and sAMAccountName', () => {
    const filter = adConfig().searchFilter;
    expect(filter).toBe(AD_SEARCH_FILTER);
    expect(filter).toContain('(mail={{input}})');
    expect(filter).toContain('(userPrincipalName={{input}})');
    expect(filter).toContain('(sAMAccountName={{input}})');
    // Computer accounts are objectClass=user too.
    expect(filter).toContain('(objectCategory=person)');
  });

  it('leaves the OpenLDAP default alone', () => {
    expect(dialectDefaults('openldap').searchFilter).toBe(
      '(&(objectClass=person)(mail={{input}}))',
    );
  });

  it('applies to a saved configuration with no filter of its own — no migration', () => {
    // What staging's stored row looks like: no searchFilter key at all.
    const stored = ldapConfigSchema.parse({
      host: 'dc01.corp.local',
      port: 636,
      protocol: 'ldaps',
      bindType: 'anonymous',
      detectedDialect: 'ad',
      searchBase: 'dc=corp,dc=local',
    });
    expect(stored.searchFilter).toBe(AD_SEARCH_FILTER);
  });

  it('reads the former default, carried into a saved row, as the default', () => {
    const adopted = adConfig({ searchFilter: AD_SEARCH_FILTER_WITHOUT_MAIL });
    expect(adopted.searchFilter).toBe(AD_SEARCH_FILTER);
  });

  it('keeps a filter somebody chose', () => {
    const custom = '(&(objectClass=user)(employeeID={{input}}))';
    expect(adConfig({ searchFilter: custom }).searchFilter).toBe(custom);
    // The old string on an OpenLDAP configuration is somebody's choice, not
    // the AD default carried over.
    expect(
      ldapConfigSchema.parse({
        host: 'ldap.example.com',
        protocol: 'ldaps',
        bindType: 'anonymous',
        searchBase: 'dc=example',
        searchFilter: AD_SEARCH_FILTER_WITHOUT_MAIL,
      }).searchFilter,
    ).toBe(AD_SEARCH_FILTER_WITHOUT_MAIL);
  });

  it('is not reported back as if it had been chosen, so adopting the environment does not freeze it', () => {
    const p = provider(adConfig(), [], accounts()).provider;
    expect(p.currentConfiguration()).not.toHaveProperty('searchFilter');

    const custom = '(&(objectClass=user)(employeeID={{input}}))';
    expect(
      provider(adConfig({ searchFilter: custom }), [], accounts()).provider.currentConfiguration(),
    ).toMatchObject({ searchFilter: custom });
  });
});

describe('signing in to Active Directory with an email that is mail, not the UPN', () => {
  it('finds the person by their mail and signs them in to that account', async () => {
    const { provider: p } = provider(adConfig(), [ALICE], accounts('alice.admin@example.com'));

    const result = await p.authenticate({ email: 'Alice.Admin@Example.com', password: PASSWORD });

    expect(result).toMatchObject({
      ok: true,
      principal: { email: 'alice.admin@example.com', role: 'OPERATOR', authSource: 'ldap' },
    });
  });

  it('still finds the person by their UPN, and binds as them', async () => {
    // Unchanged by this fix: with Regular bind the session belongs to the
    // account the entry's mail names, which is why both exist here.
    const { provider: p, binds } = provider(
      adConfig(),
      [ALICE],
      accounts('alice.admin@corp.local', 'alice.admin@example.com'),
    );

    const result = await p.authenticate({ email: 'alice.admin@corp.local', password: PASSWORD });

    expect(result.ok).toBe(true);
    expect(binds).toEqual([SERVICE.dn, ALICE.dn]);
  });

  it('refuses an address that is one entry’s mail and another’s UPN, binding as neither', async () => {
    const { provider: p, binds } = provider(
      adConfig(),
      [MALLORY, ALICE],
      accounts('alice.admin@corp.local'),
    );

    // Mallory knows her own password and types Alice's UPN, which is her mail.
    const result = await p.authenticate({
      email: 'alice.admin@corp.local',
      password: MALLORY.password,
    });

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    // Only the service account bound: no person was tried.
    expect(binds).toEqual([SERVICE.dn]);
  });

  it('logs the ambiguity for the operator, by name', async () => {
    const lines = spy();
    const { provider: p } = provider(
      adConfig(),
      [ALICE, MALLORY],
      accounts('alice.admin@corp.local'),
      lines.logger,
    );

    await p.authenticate({ email: 'alice.admin@corp.local', password: MALLORY.password });

    expect(lines.error.join('\n')).toContain(AMBIGUOUS_SIGN_IN_NAME);
    expect(JSON.stringify(lines)).not.toContain(MALLORY.password);
  });
});

/**
 * The reason a directory user is refused goes to the API log — never to the
 * caller, who gets the same answer for every cause (ADR-0015 §2).
 */
describe('why an LDAP sign-in was refused, in the log', () => {
  it('says no entry matched, where it searched and by what — at WARN', async () => {
    const lines = spy();
    const { provider: p } = provider(
      adConfig(),
      [],
      accounts('alice.admin@example.com'),
      lines.logger,
    );

    await p.authenticate({ email: 'alice.admin@example.com', password: PASSWORD });

    expect(lines.warn).toEqual([
      'LDAP login refused for alice.admin@example.com: no directory entry matched under ' +
        'ou=people,dc=corp,dc=local (searched sAMAccountName, userPrincipalName, mail). ' +
        'The NexusPuppet account’s email must equal one of those on the person’s directory ' +
        'entry — on Active Directory, their mail or their UPN.',
    ]);
    expect(lines.log).toEqual([]);
  });

  it('says the directory rejected the password — at LOG, not WARN', async () => {
    const lines = spy();
    const { provider: p } = provider(
      adConfig(),
      [ALICE],
      accounts('alice.admin@example.com'),
      lines.logger,
    );

    await p.authenticate({ email: 'alice.admin@example.com', password: 'Wrong-Password-1' });

    expect(lines.log).toEqual([
      `LDAP login refused for alice.admin@example.com: the directory rejected the password for ` +
        `${ALICE.dn} (wrong password, or the account is locked or disabled in the directory).`,
    ]);
    expect(lines.warn).toEqual([]);
  });

  it('never logs the password, whichever way it is refused', async () => {
    const secret = 'Pa55-this-must-never-be-logged';
    const lines = spy();
    const ad = (people: Person[]) =>
      provider(adConfig(), people, accounts('alice.admin@example.com'), lines.logger).provider;

    await ad([]).authenticate({ email: 'alice.admin@example.com', password: secret });
    await ad([ALICE]).authenticate({ email: 'alice.admin@example.com', password: secret });
    await ad([ALICE, { ...MALLORY, mail: ALICE.mail }]).authenticate({
      email: 'alice.admin@example.com',
      password: secret,
    });
    const simple = adConfig({ bindType: 'simple', userDnPattern: '{email}' });
    await provider(
      simple,
      [ALICE],
      accounts('alice.admin@example.com'),
      lines.logger,
    ).provider.authenticate({ email: 'alice.admin@example.com', password: secret });

    const everything = [...lines.log, ...lines.warn, ...lines.error];
    expect(everything.length).toBeGreaterThanOrEqual(4);
    for (const line of everything) expect(line).not.toContain(secret);
  });

  it('gives the caller the same answer for no entry and for a wrong password', async () => {
    const noEntry = await provider(
      adConfig(),
      [],
      accounts('alice.admin@example.com'),
    ).provider.authenticate({ email: 'alice.admin@example.com', password: PASSWORD });
    const wrongPassword = await provider(
      adConfig(),
      [ALICE],
      accounts('alice.admin@example.com'),
    ).provider.authenticate({ email: 'alice.admin@example.com', password: 'nope' });

    expect(noEntry).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(wrongPassword).toEqual(noEntry);
  });

  /*
   * Simple bind with {email} binds AS the address typed. On AD that works
   * only when the address IS the UPN: an account created with the person's
   * mail binds as alice.admin@example.com, which AD rejects. Unchanged, and
   * documented — but no longer silent.
   */
  it('Simple: says the bind was rejected, and that Simple cannot tell why', async () => {
    const lines = spy();
    const simple = adConfig({ bindType: 'simple', userDnPattern: '{email}' });
    const result = await provider(
      simple,
      [ALICE],
      accounts('alice.admin@example.com'),
      lines.logger,
    ).provider.authenticate({ email: 'alice.admin@example.com', password: PASSWORD });

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(lines.log).toEqual([
      'LDAP login refused for alice.admin@example.com: the directory rejected the password for ' +
        'alice.admin@example.com (wrong password, the account is locked or disabled in the ' +
        'directory, or no account has that name — Simple bind cannot tell these apart).',
    ]);
  });

  it('Simple: says when the address cannot be used with the pattern, before any bind', async () => {
    const lines = spy();
    const simple = adConfig({ bindType: 'simple', userDnPattern: '{username}@corp.local' });
    const { provider: p, binds } = provider(
      simple,
      [ALICE],
      accounts('al ice@example.com'),
      lines.logger,
    );

    const result = await p.authenticate({ email: 'al ice@example.com', password: PASSWORD });

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(binds).toEqual([]);
    expect(lines.warn).toHaveLength(1);
    expect(lines.warn[0]).toMatch(
      /^LDAP login refused for al ice@example\.com: the address cannot be used with the User DN pattern \{username\}@corp\.local \(/,
    );
  });
});

describe('searchedAttributes', () => {
  it('names each attribute the address is matched against, once', () => {
    expect(searchedAttributes(AD_SEARCH_FILTER)).toBe('sAMAccountName, userPrincipalName, mail');
    expect(searchedAttributes('(&(objectClass=person)(mail={{input}}))')).toBe('mail');
    expect(searchedAttributes('(|(uid={{input}})(uid={{input}}))')).toBe('uid');
  });

  it('falls back to the filter when no clause compares an attribute to the address', () => {
    expect(searchedAttributes('(cn=*{{input}}*)')).toBe('the filter (cn=*{{input}}*)');
  });
});
