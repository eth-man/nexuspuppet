import { ldapConfigSchema, type LdapConfig } from './config';
import { AD_CAPABILITY_OID } from './dialect';
import {
  LdapAuthProvider,
  type LdapIdentityStore,
  type StoredIdentity,
} from './ldap-auth.provider';
import {
  ANONYMOUS_REFUSED,
  LdapUnavailableError,
  type LdapDirectory,
  type LdapEntry,
  type OwnEntryLookup,
} from './ldap-client';

/**
 * The three bind types (ADR-0030 §3), and the directory type detected rather
 * than chosen (§4), through the provider.
 */

const silent = { log: (): void => {}, warn: (): void => {}, error: (): void => {} };

const ENTRY: LdapEntry = {
  dn: 'uid=alice,ou=people,dc=example,dc=com',
  email: 'alice@example.com',
  displayName: 'Alice Ng',
  groupDns: ['cn=ops,ou=groups,dc=example,dc=com'],
};

const IDENTITY: StoredIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'VIEWER',
  isActive: true,
  authSource: 'ldap',
};

const MAPPINGS = [{ groupDn: 'cn=ops,ou=groups,dc=example,dc=com', role: 'OPERATOR' }];

function config(overrides: Record<string, unknown>): LdapConfig {
  return ldapConfigSchema.parse({
    host: 'dc01.example.com',
    protocol: 'ldaps',
    searchBase: 'ou=people,dc=example,dc=com',
    roleMappings: MAPPINGS,
    ...overrides,
  });
}

const REGULAR = config({
  bindType: 'regular',
  bindDn: 'cn=svc,dc=example,dc=com',
  bindPassword: 'svc-secret',
});
const ANONYMOUS = config({ bindType: 'anonymous' });
const SIMPLE_DN = config({
  bindType: 'simple',
  userDnPattern: 'uid={username},ou=people,dc=example,dc=com',
});
const SIMPLE_UPN = config({
  bindType: 'simple',
  userDnPattern: '{username}@corp.example',
  detectedDialect: 'ad',
});

/** A directory that records every call, so a test can assert which were made. */
function recordingDirectory(overrides: Partial<LdapDirectory> = {}): LdapDirectory & {
  calls: string[];
  binds: Array<{ identity: string; lookup: OwnEntryLookup }>;
} {
  const calls: string[] = [];
  const binds: Array<{ identity: string; lookup: OwnEntryLookup }> = [];
  const base: LdapDirectory = {
    findEntry: async () => {
      calls.push('findEntry');
      return ENTRY;
    },
    verifyCredentials: async () => {
      calls.push('verifyCredentials');
      return true;
    },
    findGroupsContaining: async () => {
      calls.push('findGroupsContaining');
      return [];
    },
    bindAndRead: async (identity, _password, lookup) => {
      calls.push('bindAndRead');
      binds.push({ identity, lookup });
      return { bound: true, entry: ENTRY, nestedGroups: null };
    },
    detectDialect: async () => {
      calls.push('detectDialect');
      return { dialect: 'openldap', readAs: 'anonymous' };
    },
  };
  return Object.assign({ ...base, ...overrides }, { calls, binds });
}

function identities(): LdapIdentityStore {
  return {
    findByEmail: async () => IDENTITY,
    findById: async () => IDENTITY,
    recordLogin: async () => {},
  };
}

function provider(cfg: LdapConfig, directory: LdapDirectory): LdapAuthProvider {
  return new LdapAuthProvider({
    config: cfg,
    directory,
    identities: identities(),
    logger: silent,
    directoryFor: () => directory,
  });
}

/**
 * An empty password is an unauthenticated bind, which many servers accept.
 * Refused before ANY directory call, whichever bind type is configured.
 */
describe('an empty password', () => {
  it.each([
    ['Regular', REGULAR],
    ['Anonymous', ANONYMOUS],
    ['Simple (DN)', SIMPLE_DN],
    ['Simple (UPN)', SIMPLE_UPN],
  ])('is refused without contacting the directory (%s)', async (_name, cfg) => {
    const directory = recordingDirectory();
    const result = await provider(cfg, directory).authenticate({
      email: 'alice@example.com',
      password: '',
    });

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(directory.calls).toEqual([]);
  });
});

describe('Regular bind', () => {
  it('searches as the service account, then binds as the person found', async () => {
    const directory = recordingDirectory();
    const result = await provider(REGULAR, directory).authenticate({
      email: 'alice@example.com',
      password: 'pw',
    });

    expect(result.ok).toBe(true);
    expect(directory.calls).toEqual(['findEntry', 'verifyCredentials']);
  });
});

describe('Anonymous bind', () => {
  it('searches, then binds as the person found — the same two steps as before', async () => {
    const directory = recordingDirectory();
    const result = await provider(ANONYMOUS, directory).authenticate({
      email: 'alice@example.com',
      password: 'pw',
    });

    expect(result.ok).toBe(true);
    expect(directory.calls).toEqual(['findEntry', 'verifyCredentials']);
  });
});

/**
 * People sign in with their account's EMAIL — the resolver finds the account
 * by it before asking any directory — so that is what these type.
 */
describe('Simple bind', () => {
  const SIMPLE_EMAIL = config({
    bindType: 'simple',
    userDnPattern: '{email}',
    detectedDialect: 'ad',
  });

  it('binds as uid={username} — the part of the address before the @ — and searches nothing first', async () => {
    const directory = recordingDirectory();
    const result = await provider(SIMPLE_DN, directory).authenticate({
      email: ' Alice@Example.com ',
      password: 'pw',
    });

    expect(result).toMatchObject({
      ok: true,
      principal: { role: 'OPERATOR', email: 'alice@example.com' },
    });
    expect(directory.calls).toEqual(['bindAndRead']);
    expect(directory.binds).toEqual([
      {
        identity: 'uid=alice,ou=people,dc=example,dc=com',
        lookup: { dn: 'uid=alice,ou=people,dc=example,dc=com' },
      },
    ]);
  });

  /**
   * Active Directory: the address people sign in with IS their UPN, so the
   * pattern is just {email}, and the entry is found by exactly that UPN —
   * never by the typed name, which on AD can be another account's
   * sAMAccountName, whose groups would then be granted.
   */
  it('binds as {email} — the whole address, normalised as the account lookup is', async () => {
    const directory = recordingDirectory({
      bindAndRead: async (identity, _password, lookup) => {
        directory.binds.push({ identity, lookup });
        return {
          bound: true,
          entry: { ...ENTRY, email: 'Alice.Admin@corp.example.com' },
          nestedGroups: null,
        };
      },
    });
    const result = await provider(SIMPLE_EMAIL, directory).authenticate({
      email: 'Alice.Admin@Corp.Local',
      password: 'pw',
    });

    expect(directory.binds).toEqual([
      {
        identity: 'alice.admin@corp.local',
        lookup: { filter: '(userPrincipalName=alice.admin@corp.local)' },
      },
    ]);
    // The entry's mail differs from the UPN, as it often does on AD. The
    // account signed in is still the one typed, never the one the mail names.
    expect(result).toMatchObject({ ok: true });
  });

  it('signs in as the account typed, even when the entry has a different mail ({email})', async () => {
    const looked: string[] = [];
    const directory = recordingDirectory({
      bindAndRead: async () => ({
        bound: true,
        entry: { ...ENTRY, email: 'someone.else@example.com' },
        nestedGroups: null,
      }),
    });
    const p = new LdapAuthProvider({
      config: SIMPLE_EMAIL,
      directory,
      identities: {
        ...identities(),
        findByEmail: async (email) => {
          looked.push(email);
          return IDENTITY;
        },
      },
      logger: silent,
    });

    await p.authenticate({ email: 'alice.admin@corp.local', password: 'pw' });
    expect(looked).toEqual(['alice.admin@corp.local']);
  });

  it('puts {username} into a fixed UPN domain', async () => {
    const directory = recordingDirectory({
      bindAndRead: async (identity, _password, lookup) => {
        directory.binds.push({ identity, lookup });
        return { bound: true, entry: { ...ENTRY, email: null }, nestedGroups: null };
      },
    });
    await provider(SIMPLE_UPN, directory).authenticate({
      email: 'jdoe@example.com',
      password: 'pw',
    });

    expect(directory.binds).toEqual([
      {
        identity: 'jdoe@corp.example',
        lookup: { filter: '(userPrincipalName=jdoe@corp.example)' },
      },
    ]);
  });

  /**
   * {username} drops the domain: alice@x and alice@y both reach uid=alice.
   * When the entry says whose it is, it must be the address typed — or the
   * holder of uid=alice's password could sign in as somebody else's account.
   */
  it('refuses a {username} bind whose entry mail is not the address typed', async () => {
    const warnings: string[] = [];
    const directory = recordingDirectory(); // ENTRY.email is alice@example.com
    const p = new LdapAuthProvider({
      config: SIMPLE_DN,
      directory,
      identities: identities(),
      logger: { ...silent, warn: (m) => warnings.push(m) },
    });

    await expect(p.authenticate({ email: 'alice@other.example', password: 'pw' })).resolves.toEqual(
      { ok: false, reason: 'INVALID_CREDENTIALS' },
    );
    expect(warnings.join('\n')).toMatch(/mail is alice@example\.com, not the address/);
  });

  it('escapes the {username} for DN context before binding', async () => {
    const directory = recordingDirectory();
    await provider(SIMPLE_DN, directory).authenticate({
      email: 'alice,ou=admins@example.com',
      password: 'pw',
    });

    expect(directory.binds[0]?.identity).toBe(
      'uid=alice\\,ou\\=admins,ou=people,dc=example,dc=com',
    );
  });

  it('escapes the {email} for DN context before binding', async () => {
    const directory = recordingDirectory();
    await provider(
      config({ bindType: 'simple', userDnPattern: 'cn={email},ou=people,dc=example,dc=com' }),
      directory,
    ).authenticate({ email: 'a+cn=admin@example.com', password: 'pw' });

    expect(directory.binds[0]?.identity).toBe(
      'cn=a\\+cn\\=admin@example.com,ou=people,dc=example,dc=com',
    );
  });

  it.each([
    [SIMPLE_UPN, 'jdoe@evil@example.com'],
    [SIMPLE_UPN, 'CORP\\administrator@example.com'],
    [SIMPLE_UPN, 'a*@example.com'],
    [SIMPLE_EMAIL, 'jdoe@corp.local@evil.example'],
    [SIMPLE_EMAIL, 'alice'],
    [SIMPLE_EMAIL, 'jdoe\u0000@corp.local'],
  ])(
    'refuses %#: %j like a wrong password, without contacting the directory',
    async (cfg, address) => {
      const directory = recordingDirectory();
      const result = await provider(cfg, directory).authenticate({
        email: address,
        password: 'pw',
      });

      expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
      expect(directory.calls).toEqual([]);
    },
  );

  it('gives a rejected bind the same answer as an unknown user', async () => {
    const directory = recordingDirectory({ bindAndRead: async () => ({ bound: false }) });
    await expect(
      provider(SIMPLE_DN, directory).authenticate({ email: 'alice@example.com', password: 'x' }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('refuses, and says why in the log, when the person cannot read their own entry', async () => {
    const warnings: string[] = [];
    const directory = recordingDirectory({
      bindAndRead: async () => ({ bound: true, entry: null, nestedGroups: null }),
    });
    const p = new LdapAuthProvider({
      config: SIMPLE_DN,
      directory,
      identities: identities(),
      logger: { ...silent, warn: (m) => warnings.push(m) },
    });

    await expect(p.authenticate({ email: 'alice@example.com', password: 'pw' })).resolves.toEqual({
      ok: false,
      reason: 'INVALID_CREDENTIALS',
    });
    expect(warnings.join('\n')).toMatch(/could not read its own entry/);
    expect(warnings.join('\n')).not.toContain('pw');
  });

  it('adds the nested groups the directory resolved as the user', async () => {
    const nested = config({
      bindType: 'simple',
      userDnPattern: '{email}',
      detectedDialect: 'ad',
      nestedGroups: true,
      roleMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', role: 'ADMIN' }],
    });
    let asked = false;
    const directory = recordingDirectory({
      bindAndRead: async (_identity, _password, _lookup, options) => {
        asked = options.nestedGroups;
        return { bound: true, entry: ENTRY, nestedGroups: ['cn=admins,dc=example,dc=com'] };
      },
    });

    await expect(
      provider(nested, directory).authenticate({ email: 'alice@example.com', password: 'pw' }),
    ).resolves.toMatchObject({ ok: true, principal: { role: 'ADMIN' } });
    expect(asked).toBe(true);
  });

  it('falls back to direct groups when the nested query failed', async () => {
    const errors: string[] = [];
    const directory = recordingDirectory({
      bindAndRead: async () => ({
        bound: true,
        entry: ENTRY,
        nestedGroups: null,
        nestedError: 'operationsError',
      }),
    });
    const p = new LdapAuthProvider({
      config: config({
        bindType: 'simple',
        userDnPattern: '{email}',
        detectedDialect: 'ad',
        nestedGroups: true,
      }),
      directory,
      identities: identities(),
      logger: { ...silent, error: (m) => errors.push(m) },
    });

    await expect(
      p.authenticate({ email: 'alice@example.com', password: 'pw' }),
    ).resolves.toMatchObject({ ok: true, principal: { role: 'OPERATOR' } });
    expect(errors.join('\n')).toMatch(/Nested group resolution failed/);
  });

  it('reports an unreachable directory as PROVIDER_ERROR, never as bad credentials', async () => {
    const directory = recordingDirectory({
      bindAndRead: async () => {
        throw new LdapUnavailableError('The server refused STARTTLS');
      },
    });
    await expect(
      provider(SIMPLE_DN, directory).authenticate({ email: 'alice@example.com', password: 'pw' }),
    ).resolves.toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });

  it('labels the login field Email — it is the account address people type', () => {
    expect(provider(SIMPLE_DN, recordingDirectory()).identifierLabel).toBe('Email');
    expect(provider(SIMPLE_EMAIL, recordingDirectory()).identifierLabel).toBe('Email');
  });
});

/** Defect 2 from the staging run against AD: a raw 000004DC is not an answer. */
describe('Test connection when the directory refuses anonymous searches', () => {
  const candidate = {
    host: 'dc01.example.com',
    protocol: 'ldaps',
    bindType: 'anonymous',
    searchBase: 'dc=example,dc=com',
  };

  it('says so plainly, and keeps the directory’s own words beneath', async () => {
    const raw =
      'LDAP search failed: OperationsError: 000004DC: LdapErr: DSID-0C090CA2, comment: In order ' +
      'to perform this operation a successful bind must be completed on the connection., data 0, v4f7c';
    const directory = recordingDirectory({
      findEntry: async () => {
        throw new LdapUnavailableError(ANONYMOUS_REFUSED, { detail: raw });
      },
    });
    const result = await provider(ANONYMOUS, directory).verifyConfiguration(candidate);

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'This directory does not allow anonymous searches. Use Regular with a service account ' +
        '(User DN and Password).',
    );
    expect(result.details).toContainEqual({ label: 'Directory said', value: raw });
  });
});

describe('verifyConfiguration detects the directory type (ADR-0030 §4)', () => {
  const candidate = {
    host: 'dc01.example.com',
    protocol: 'starttls',
    bindType: 'regular',
    bindDn: 'cn=svc,dc=example,dc=com',
    bindPassword: 'svc-secret',
    searchBase: 'ou=people,dc=example,dc=com',
  };

  function testing(detected: 'ad' | 'openldap' | null, overrides: Partial<LdapDirectory> = {}) {
    const filters: string[] = [];
    const directory = recordingDirectory({
      detectDialect: async () => ({
        dialect: detected,
        readAs: detected === null ? null : 'anonymous',
      }),
      findEntry: async (filter) => {
        filters.push(filter);
        return null;
      },
      ...overrides,
    });
    return { p: provider(REGULAR, directory), filters, directory };
  }

  it('reports Active Directory, and probes with the AD search filter', async () => {
    const { p, filters } = testing('ad');
    const result = await p.verifyConfiguration(candidate);

    expect(result).toMatchObject({ ok: true, detectedDialect: 'ad' });
    expect(result.details).toContainEqual({
      label: 'Directory type',
      value: 'Active Directory (detected from the RootDSE)',
    });
    expect(result.message).toMatch(/over STARTTLS/);
    expect(filters[0]).toContain('sAMAccountName');
  });

  it('reports OpenLDAP, and probes with the OpenLDAP filter', async () => {
    const { p, filters } = testing('openldap');
    const result = await p.verifyConfiguration(candidate);

    expect(result).toMatchObject({ ok: true, detectedDialect: 'openldap' });
    expect(filters[0]).toContain('(mail=');
  });

  it('says so when the type could not be read, and treats it as OpenLDAP', async () => {
    const { p, filters } = testing(null);
    const result = await p.verifyConfiguration(candidate);

    expect(result).toMatchObject({ ok: true, detectedDialect: null });
    expect(result.message).toMatch(/directory type is unknown and it is treated as OpenLDAP/);
    expect(filters[0]).toContain('(mail=');
  });

  it('fails with the connection error when the RootDSE read cannot connect', async () => {
    const { p, directory } = testing('ad', {
      detectDialect: async () => {
        throw new LdapUnavailableError(
          'The server refused STARTTLS: unsupported extended operation. No credentials were sent.',
        );
      },
    });
    const result = await p.verifyConfiguration(candidate);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused STARTTLS[\s\S]*No credentials were sent/);
    // Nothing further was attempted on a connection that could not be secured.
    expect(directory.calls).not.toContain('findEntry');
  });

  it('never echoes the bind password', async () => {
    const { p } = testing('ad');
    const result = await p.verifyConfiguration(candidate);
    expect(JSON.stringify(result)).not.toContain('svc-secret');
  });

  it('tests a Simple configuration by connecting, without a search it cannot make', async () => {
    const { p, directory } = testing('ad');
    const result = await p.verifyConfiguration({
      ...candidate,
      bindType: 'simple',
      userDnPattern: '{username}@corp.example',
    });

    expect(result).toMatchObject({ ok: true, detectedDialect: 'ad' });
    expect(result.message).toMatch(/Simple bind has no service account/);
    // Nothing but the RootDSE read (stubbed above, so unrecorded): no search,
    // and no bind with credentials nobody supplied.
    expect(directory.calls).toEqual([]);
  });

  it('refuses a UPN pattern against a server that is not Active Directory', async () => {
    const { p } = testing('openldap');
    const result = await p.verifyConfiguration({
      ...candidate,
      bindType: 'simple',
      userDnPattern: '{username}@corp.example',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only works against Active Directory/);
  });
});

describe('detectDialect, for a save', () => {
  it('answers what the RootDSE said', async () => {
    const directory = recordingDirectory({
      detectDialect: async () => ({ dialect: 'ad', readAs: 'anonymous' }),
    });
    await expect(
      provider(REGULAR, directory).detectDialect({
        host: 'dc01.example.com',
        protocol: 'ldaps',
        bindType: 'anonymous',
        searchBase: 'dc=example',
      }),
    ).resolves.toBe('ad');
  });

  it('never throws: an unreachable directory is null, and the save goes ahead', async () => {
    const directory = recordingDirectory({
      detectDialect: async () => {
        throw new LdapUnavailableError('ECONNREFUSED');
      },
    });
    await expect(
      provider(REGULAR, directory).detectDialect({
        host: 'dc01.example.com',
        protocol: 'ldaps',
        bindType: 'anonymous',
        searchBase: 'dc=example',
      }),
    ).resolves.toBeNull();
  });

  it('is null for something that is not a configuration', async () => {
    await expect(provider(REGULAR, recordingDirectory()).detectDialect({})).resolves.toBeNull();
  });

  it('uses the capability OID the RootDSE carries — a constant, not a guess', () => {
    expect(AD_CAPABILITY_OID).toBe('1.2.840.113556.1.4.800');
  });
});

describe('describe() states the connection in the new terms', () => {
  it('names server, protocol and bind type, and never the password', () => {
    const description = provider(
      config({
        protocol: 'starttls',
        bindType: 'regular',
        bindDn: 'cn=svc,dc=example,dc=com',
        bindPassword: 'svc-secret',
      }),
      recordingDirectory(),
    ).describe();

    expect(description.details).toEqual(
      expect.arrayContaining([
        { label: 'Server', value: 'dc01.example.com:389' },
        { label: 'Protocol', value: 'STARTTLS' },
        { label: 'Bind type', value: 'Regular (service account)' },
        { label: 'TLS verification', value: 'enforced (system trust store)' },
      ]),
    );
    expect(JSON.stringify(description)).not.toContain('svc-secret');
  });

  it('shows the pattern for Simple, where there is no search filter to show', () => {
    expect(provider(SIMPLE_DN, recordingDirectory()).describe().details).toEqual(
      expect.arrayContaining([
        { label: 'User DN pattern', value: 'uid={username},ou=people,dc=example,dc=com' },
        { label: 'Bind account', value: 'each user' },
      ]),
    );
  });
});
