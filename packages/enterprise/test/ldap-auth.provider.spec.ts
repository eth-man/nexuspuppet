import { ldapConfigSchema, type LdapConfig } from '../src/ldap/config';
import {
  LdapAuthProvider,
  type LdapIdentityStore,
  type StoredIdentity,
} from '../src/ldap/ldap-auth.provider';
import { LdapUnavailableError, type LdapDirectory, type LdapEntry } from '../src/ldap/ldap-client';

const silent = { log: (): void => {}, warn: (): void => {}, error: (): void => {} };

function config(overrides: Partial<LdapConfig> = {}): LdapConfig {
  return ldapConfigSchema.parse({
    url: 'ldaps://directory.example.com:636',
    searchBase: 'ou=people,dc=example,dc=com',
    roleMappings: [
      { groupDn: 'cn=puppet-admins,ou=groups,dc=example,dc=com', role: 'ADMIN' },
      { groupDn: 'cn=ops,ou=groups,dc=example,dc=com', role: 'OPERATOR' },
    ],
    ...overrides,
  });
}

const ENTRY: LdapEntry = {
  dn: 'uid=alice,ou=people,dc=example,dc=com',
  email: 'alice@example.com',
  displayName: 'Alice Ng',
  groupDns: ['cn=ops,ou=groups,dc=example,dc=com'],
};

const IDENTITY: StoredIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  displayName: 'Alice (stale)',
  role: 'VIEWER',
  isActive: true,
  authSource: 'ldap',
};

/**
 * Annotated explicitly rather than inlined into the spread below.
 *
 * `{ ...someBase, ...Partial<LdapDirectory> }` returned as LdapDirectory does
 * NOT fail typechecking when a method is missing — the spread of an optional
 * type defeats the missing-property check. Naming the base with its type is
 * what makes adding a method to the port a compile error here, instead of a
 * runtime failure in whichever test happens to call it.
 */
const BASE_DIRECTORY: LdapDirectory = {
  findEntry: async () => ENTRY,
  verifyCredentials: async () => true,
  findGroupsContaining: async () => [],
};

function directory(overrides: Partial<LdapDirectory> = {}): LdapDirectory {
  return { ...BASE_DIRECTORY, ...overrides };
}

function identities(overrides: Partial<LdapIdentityStore> = {}): LdapIdentityStore {
  return {
    findByEmail: async () => IDENTITY,
    findById: async () => IDENTITY,
    recordLogin: async () => {},
    ...overrides,
  };
}

function provider(
  parts: {
    config?: LdapConfig;
    directory?: LdapDirectory;
    identities?: LdapIdentityStore;
    settings?: { resolve(source: string): Promise<unknown | null> };
    directoryFor?: (config: LdapConfig) => LdapDirectory;
  } = {},
): LdapAuthProvider {
  return new LdapAuthProvider({
    config: parts.config ?? config(),
    directory: parts.directory ?? directory(),
    identities: parts.identities ?? identities(),
    logger: silent,
    ...(parts.settings === undefined ? {} : { settings: parts.settings }),
    ...(parts.directoryFor === undefined ? {} : { directoryFor: parts.directoryFor }),
  });
}

/**
 * Stored settings taking effect without a restart (ADR-0016 §4, #113).
 *
 * The property under test is not "a value is read" but WHICH DIRECTORY A
 * PASSWORD REACHES. Getting this wrong sends credentials to a server the
 * operator has replaced, so each case asserts the client that was actually
 * used rather than the configuration that was resolved.
 */
describe('LdapAuthProvider with a settings reader', () => {
  it('uses its boot configuration when nothing is stored', async () => {
    const boot = directory();
    const rebuilt = jest.fn(() => directory());

    const result = await provider({
      directory: boot,
      settings: { resolve: async () => null },
      directoryFor: rebuilt,
    }).authenticate(CREDS);

    expect(result.ok).toBe(true);
    // Nothing stored means nothing to rebuild for — the boot client serves.
    expect(rebuilt).not.toHaveBeenCalled();
  });

  it('binds against the STORED directory once one is saved', async () => {
    const stored = { ...config(), url: 'ldaps://stored.example.test:636' };
    const seen: string[] = [];

    const result = await provider({
      settings: { resolve: async () => stored },
      directoryFor: (c) => {
        seen.push(c.url);
        return directory();
      },
    }).authenticate(CREDS);

    expect(result.ok).toBe(true);
    expect(seen).toEqual(['ldaps://stored.example.test:636']);
  });

  it('rebuilds the client only when the configuration actually changes', async () => {
    let stored = { ...config(), url: 'ldaps://one.example.test:636' };
    const built = jest.fn(() => directory());
    const p = provider({ settings: { resolve: async () => stored }, directoryFor: built });

    await p.authenticate(CREDS);
    await p.authenticate(CREDS);
    expect(built).toHaveBeenCalledTimes(1);

    stored = { ...stored, url: 'ldaps://two.example.test:636' };
    await p.authenticate(CREDS);
    expect(built).toHaveBeenCalledTimes(2);
  });

  /**
   * The failure that must NOT be a silent fallback. If the store cannot be
   * read, the previous configuration may be exactly what an operator replaced
   * — binding against it would send a password to the wrong server and report
   * success.
   */
  it('refuses the login when the settings cannot be read', async () => {
    const result = await provider({
      settings: {
        resolve: async () => {
          throw new Error('database is down');
        },
      },
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });

  it('refuses the login when the stored configuration is unusable', async () => {
    const result = await provider({
      settings: { resolve: async () => ({ url: 'not-a-url' }) },
    }).authenticate(CREDS);

    // Not INVALID_CREDENTIALS: the password was never tested, and reporting it
    // as wrong would send the operator hunting the user's account.
    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });

  /**
   * `caPath` names a file on the host, which a settings screen cannot set. The
   * verify path already inherits it for a candidate; a saved configuration
   * needs the same, or enabling TLS from the console would drop the CA.
   */
  it('inherits caPath from the boot configuration when the stored one has none', async () => {
    const seen: Array<string | undefined> = [];

    await provider({
      config: { ...config(), caPath: '/etc/nexuspuppet/certs/ad-ca.pem' },
      settings: { resolve: async () => ({ ...config(), url: 'ldaps://stored.example.test:636' }) },
      directoryFor: (c) => {
        seen.push(c.caPath);
        return directory();
      },
    }).authenticate(CREDS);

    expect(seen).toEqual(['/etc/nexuspuppet/certs/ad-ca.pem']);
  });
});

const CREDS = { email: 'Alice@Example.com', password: 'correct-horse' };

describe('LdapAuthProvider', () => {
  it('authenticates by binding as the user and maps their group to a role', async () => {
    const result = await provider().authenticate(CREDS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe(IDENTITY.userId);
    expect(result.principal.role).toBe('OPERATOR');
    expect(result.principal.authSource).toBe('ldap');
    // The directory is authoritative for the display name.
    expect(result.principal.displayName).toBe('Alice Ng');
  });

  /**
   * RFC 4513 §5.1.2: a bind with a DN and an empty password is an
   * "unauthenticated bind", which most directories ACCEPT. Passing it through
   * would authenticate anyone who submits a blank password.
   */
  it('rejects an empty password without attempting a bind', async () => {
    const verifyCredentials = jest.fn(async () => true);
    const result = await provider({ directory: directory({ verifyCredentials }) }).authenticate({
      email: 'alice@example.com',
      password: '',
    });

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('rejects a wrong password', async () => {
    const result = await provider({
      directory: directory({ verifyCredentials: async () => false }),
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  /**
   * An unknown directory account must be indistinguishable from a wrong
   * password, or login becomes a user-enumeration oracle against the corporate
   * directory — a richer target than this application's own user table.
   */
  it('gives an unknown account the same answer as a wrong password', async () => {
    const unknown = await provider({
      directory: directory({ findEntry: async () => null }),
    }).authenticate(CREDS);
    const wrongPassword = await provider({
      directory: directory({ verifyCredentials: async () => false }),
    }).authenticate(CREDS);

    expect(unknown).toEqual(wrongPassword);
  });

  it('refuses a user who belongs to no mapped group', async () => {
    const result = await provider({
      directory: directory({
        findEntry: async () => ({ ...ENTRY, groupDns: ['cn=interns,ou=groups,dc=example,dc=com'] }),
      }),
    }).authenticate(CREDS);

    // Not defaulted to VIEWER: read access to the estate inventory is a map of
    // every host, its OS and its patch state.
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('grants the highest role when a user is in several mapped groups', async () => {
    const result = await provider({
      directory: directory({
        findEntry: async () => ({
          ...ENTRY,
          groupDns: [
            'cn=ops,ou=groups,dc=example,dc=com',
            'cn=puppet-admins,ou=groups,dc=example,dc=com',
          ],
        }),
      }),
    }).authenticate(CREDS);

    expect(result.ok && result.principal.role).toBe('ADMIN');
  });

  it('matches group DNs regardless of case and spacing', async () => {
    const result = await provider({
      directory: directory({
        findEntry: async () => ({
          ...ENTRY,
          groupDns: ['CN=Puppet-Admins, OU=Groups, DC=example, DC=com'],
        }),
      }),
    }).authenticate(CREDS);

    expect(result.ok && result.principal.role).toBe('ADMIN');
  });

  it('refuses when the directory authenticates someone with no local account', async () => {
    const result = await provider({
      identities: identities({ findByEmail: async () => null }),
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('reports a deactivated account only after the password is verified', async () => {
    const result = await provider({
      identities: identities({ findByEmail: async () => ({ ...IDENTITY, isActive: false }) }),
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'ACCOUNT_DISABLED' });
  });

  /**
   * The most important failure mode. A directory outage must never look like a
   * wrong password, or an estate-wide outage reads as "everyone's password
   * changed" — and must never fall through to another provider.
   */
  it('fails closed with PROVIDER_ERROR when the directory is unreachable', async () => {
    const result = await provider({
      directory: directory({
        findEntry: async () => {
          throw new LdapUnavailableError('ECONNREFUSED');
        },
      }),
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });

  it('fails closed when the bind itself errors rather than rejecting', async () => {
    const result = await provider({
      directory: directory({
        verifyCredentials: async () => {
          throw new LdapUnavailableError('TLS handshake failed');
        },
      }),
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });

  it('caches the directory-derived role so refresh agrees with login', async () => {
    const recordLogin = jest.fn(async () => {});
    await provider({ identities: identities({ recordLogin }) }).authenticate(CREDS);

    expect(recordLogin).toHaveBeenCalledWith(IDENTITY.userId, {
      role: 'OPERATOR',
      displayName: 'Alice Ng',
    });
  });

  it('still authenticates when caching the login state fails', async () => {
    const result = await provider({
      identities: identities({
        recordLogin: async () => {
          throw new Error('database is read-only');
        },
      }),
    }).authenticate(CREDS);

    // They typed the right password and are in the right group; a cache write
    // failure is not their problem.
    expect(result.ok).toBe(true);
  });

  it('falls back to the stored display name when the directory omits it', async () => {
    const result = await provider({
      directory: directory({ findEntry: async () => ({ ...ENTRY, displayName: null }) }),
    }).authenticate(CREDS);

    expect(result.ok && result.principal.displayName).toBe('Alice (stale)');
  });

  it('falls back to the submitted address when the entry carries no mail attribute', async () => {
    const findByEmail = jest.fn(async () => IDENTITY);
    await provider({
      directory: directory({ findEntry: async () => ({ ...ENTRY, email: null }) }),
      identities: identities({ findByEmail }),
    }).authenticate(CREDS);

    // Normalised, so a differently-cased login still finds the account.
    expect(findByEmail).toHaveBeenCalledWith('alice@example.com');
  });

  it('treats an entry with an empty DN as no match rather than binding to the base', async () => {
    const verifyCredentials = jest.fn(async () => true);
    const result = await provider({
      directory: directory({ findEntry: async () => ({ ...ENTRY, dn: '' }), verifyCredentials }),
    }).authenticate(CREDS);

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('escapes the identifier before it reaches the directory', async () => {
    const findEntry = jest.fn(async () => null);
    await provider({ directory: directory({ findEntry }) }).authenticate({
      email: 'a*b@example.com',
      password: 'x',
    });

    expect(findEntry).toHaveBeenCalledWith(expect.stringContaining('a\\2ab@example.com'));
    expect(findEntry).not.toHaveBeenCalledWith(expect.stringContaining('a*b'));
  });

  it('survives a non-Error thrown while caching login state', async () => {
    const result = await provider({
      identities: identities({
        recordLogin: async () => {
          // Libraries do throw strings. The warning path must not itself throw.
          throw 'connection reset';
        },
      }),
    }).authenticate(CREDS);

    expect(result.ok).toBe(true);
  });

  it('defaults to the console logger when none is supplied', async () => {
    // A secure configuration emits no startup warnings, so this stays silent.
    const p = new LdapAuthProvider({
      config: config(),
      directory: directory(),
      identities: identities(),
    });
    expect((await p.authenticate(CREDS)).ok).toBe(true);
  });

  describe('resolve', () => {
    it('re-resolves a principal from the stored account', async () => {
      const principal = await provider().resolve(IDENTITY.userId);
      expect(principal?.role).toBe('VIEWER');
      expect(principal?.authSource).toBe('ldap');
    });

    it('returns null for a deactivated account, ending the session on refresh', async () => {
      const p = provider({
        identities: identities({ findById: async () => ({ ...IDENTITY, isActive: false }) }),
      });
      expect(await p.resolve(IDENTITY.userId)).toBeNull();
    });

    it('returns null for an unknown id', async () => {
      const p = provider({ identities: identities({ findById: async () => null }) });
      expect(await p.resolve('missing')).toBeNull();
    });
  });
});

/**
 * These warnings are the only signal an operator gets that they have
 * configured something dangerous. If they stop firing, an insecure deployment
 * becomes a silent one.
 */
describe('LdapAuthProvider startup warnings', () => {
  function warningsFor(overrides: Partial<LdapConfig>): string[] {
    const warnings: string[] = [];
    new LdapAuthProvider({
      config: config(overrides),
      directory: directory(),
      identities: identities(),
      logger: { ...silent, warn: (m: string) => warnings.push(m) },
    });
    return warnings;
  }

  it('warns when TLS certificate verification is disabled', () => {
    expect(warningsFor({ tlsRejectUnauthorized: false }).join(' ')).toMatch(
      /verification is DISABLED/,
    );
  });

  it('warns when the connection is unencrypted ldap://', () => {
    expect(warningsFor({ url: 'ldap://directory.example.com:389' }).join(' ')).toMatch(/cleartext/);
  });

  it('warns when no role mappings are configured, since every login will fail', () => {
    expect(warningsFor({ roleMappings: [] }).join(' ')).toMatch(/Every login will be refused/);
  });

  it('says nothing on a correctly secured configuration', () => {
    expect(warningsFor({})).toEqual([]);
  });
});

/**
 * describe() is rendered in a browser by an administrator. The tests that
 * matter are the ones asserting what must NOT be in it.
 */
describe('LdapAuthProvider.describe', () => {
  const configured = config({
    bindDn: 'cn=svc,dc=example,dc=com',
    bindPassword: 'the-service-account-secret',
  });

  it('never includes the bind password anywhere in the payload', () => {
    const description = provider({ config: configured }).describe();

    // Serialised, so a secret cannot hide in a nested field added later.
    expect(JSON.stringify(description)).not.toContain('the-service-account-secret');
  });

  it('names the bind account, because knowing which account searches is diagnostic', () => {
    const details = provider({ config: configured }).describe().details;
    expect(details).toContainEqual({ label: 'Bind account', value: 'cn=svc,dc=example,dc=com' });
  });

  it('reports anonymous search rather than leaving the field blank', () => {
    const details = provider().describe().details;
    expect(details).toContainEqual({ label: 'Bind account', value: 'anonymous' });
  });

  it('exposes the group-to-role mappings an administrator needs to audit', () => {
    expect(provider().describe().roleMappings).toEqual([
      { group: 'cn=puppet-admins,ou=groups,dc=example,dc=com', role: 'ADMIN' },
      { group: 'cn=ops,ou=groups,dc=example,dc=com', role: 'OPERATOR' },
    ]);
  });

  it('states that an unmapped user is refused, which is what makes the list complete', () => {
    // If this ever reported false, the mapping table would no longer describe
    // who has access — everyone in the directory would.
    expect(provider().describe().refusesUnmappedUsers).toBe(true);
  });

  it('flags disabled TLS verification in a way an administrator cannot miss', () => {
    const insecure = config({ url: 'ldaps://d.example.com:636', tlsRejectUnauthorized: false });
    expect(provider({ config: insecure }).describe().details).toContainEqual({
      label: 'TLS verification',
      value: 'DISABLED',
    });
  });

  it('does not claim TLS is enforced on a cleartext connection', () => {
    const cleartext = config({ url: 'ldap://d.example.com:389' });
    const tls = provider({ config: cleartext })
      .describe()
      .details.find((d) => d.label === 'TLS verification');
    expect(tls?.value).toMatch(/not applicable/);
  });
});

describe('LdapAuthProvider.describe — TLS trust', () => {
  function tlsOf(overrides: Partial<LdapConfig>): string | undefined {
    return provider({ config: config(overrides) })
      .describe()
      .details.find((d) => d.label === 'TLS verification')?.value;
  }

  it('names the system trust store when no CA bundle is configured', () => {
    // The usual on-prem failure: a directory signed by an internal CA nobody
    // mounted. "enforced" alone would not tell an administrator which store is
    // being consulted, or why it is about to fail.
    expect(tlsOf({ url: 'ldaps://d.example.com:636' })).toBe('enforced (system trust store)');
  });

  it('names the CA bundle in use when one is configured', () => {
    expect(tlsOf({ url: 'ldaps://d.example.com:636', caPath: '/etc/ssl/corp-ca.pem' })).toBe(
      'enforced (CA bundle /etc/ssl/corp-ca.pem)',
    );
  });
});

/**
 * Active Directory: nested group resolution via LDAP_MATCHING_RULE_IN_CHAIN.
 *
 * AD estates routinely grant access through a chain — a person is in
 * `platform-team`, which is a member of `puppet-admins`. Reading `memberOf`
 * alone sees only the first hop, so that person is refused despite being
 * entitled, and the reason is invisible from outside the directory.
 */
describe('LdapAuthProvider with AD nested groups', () => {
  const AD = (overrides: Partial<LdapConfig> = {}): LdapConfig =>
    ldapConfigSchema.parse({
      url: 'ldaps://dc.corp.example.com:636',
      searchBase: 'ou=people,dc=corp,dc=example,dc=com',
      dialect: 'ad',
      nestedGroups: true,
      roleMappings: [
        { groupDn: 'cn=puppet-admins,ou=groups,dc=corp,dc=example,dc=com', role: 'ADMIN' },
      ],
      ...overrides,
    });

  // Direct membership only — the chain is what grants the role.
  const NESTED_ENTRY: LdapEntry = {
    dn: 'cn=Jane Doe,ou=people,dc=corp,dc=example,dc=com',
    email: 'jdoe@corp.example.com',
    displayName: 'Jane Doe',
    groupDns: ['cn=platform-team,ou=groups,dc=corp,dc=example,dc=com'],
  };

  it('grants a role held only through a nested group', async () => {
    const result = await provider({
      config: AD(),
      directory: directory({
        findEntry: async () => NESTED_ENTRY,
        findGroupsContaining: async () => [
          'cn=platform-team,ou=groups,dc=corp,dc=example,dc=com',
          'cn=puppet-admins,ou=groups,dc=corp,dc=example,dc=com',
        ],
      }),
    }).authenticate({ email: 'jdoe', password: 'pw' });

    expect(result.ok && result.principal.role).toBe('ADMIN');
  });

  it('refuses the same user when nested resolution is off', async () => {
    // The direct membership alone maps to nothing.
    const result = await provider({
      config: AD({ nestedGroups: false }),
      directory: directory({ findEntry: async () => NESTED_ENTRY }),
    }).authenticate({ email: 'jdoe', password: 'pw' });

    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('resolves the chain only AFTER the password is verified', async () => {
    // Otherwise an unauthenticated caller could drive load against the group
    // subtree by submitting names.
    const findGroupsContaining = jest.fn(async () => []);
    await provider({
      config: AD(),
      directory: directory({
        findEntry: async () => NESTED_ENTRY,
        verifyCredentials: async () => false,
        findGroupsContaining,
      }),
    }).authenticate({ email: 'jdoe', password: 'wrong' });

    expect(findGroupsContaining).not.toHaveBeenCalled();
  });

  /**
   * An enrichment query failing must not deny a login: the direct memberships
   * are still a valid answer, and a slow group subtree would otherwise be an
   * outage.
   */
  it('falls back to direct membership when the chain query fails', async () => {
    const direct: LdapEntry = {
      ...NESTED_ENTRY,
      groupDns: ['cn=puppet-admins,ou=groups,dc=corp,dc=example,dc=com'],
    };
    const errors: string[] = [];

    const result = await new LdapAuthProvider({
      config: AD(),
      directory: directory({
        findEntry: async () => direct,
        findGroupsContaining: async () => {
          throw new Error('group subtree timed out');
        },
      }),
      identities: identities(),
      logger: { ...silent, error: (m: string) => errors.push(m) },
    }).authenticate({ email: 'jdoe', password: 'pw' });

    expect(result.ok && result.principal.role).toBe('ADMIN');
    expect(errors.join(' ')).toMatch(/Falling back to direct membership/);
  });

  it('unions direct and nested groups rather than replacing', async () => {
    // A memberOf entry from another domain may not be reachable by the chain
    // query; dropping it would silently remove a role.
    const result = await provider({
      config: AD({
        roleMappings: [
          { groupDn: 'cn=platform-team,ou=groups,dc=corp,dc=example,dc=com', role: 'OPERATOR' },
          { groupDn: 'cn=puppet-admins,ou=groups,dc=corp,dc=example,dc=com', role: 'ADMIN' },
        ],
      }),
      directory: directory({
        findEntry: async () => NESTED_ENTRY,
        findGroupsContaining: async () => ['cn=puppet-admins,ou=groups,dc=corp,dc=example,dc=com'],
      }),
    }).authenticate({ email: 'jdoe', password: 'pw' });

    // platform-team came from memberOf, puppet-admins from the chain; highest wins.
    expect(result.ok && result.principal.role).toBe('ADMIN');
  });
});

describe('AD dialect defaults', () => {
  it('accepts either a sAMAccountName or a userPrincipalName', () => {
    const filter = ldapConfigSchema.parse({
      url: 'ldaps://dc.corp:636',
      searchBase: 'dc=corp',
      dialect: 'ad',
    }).searchFilter;

    expect(filter).toContain('sAMAccountName={{input}}');
    expect(filter).toContain('userPrincipalName={{input}}');
  });

  /**
   * Computer accounts are objectClass=user in AD. Without objectCategory=person
   * a machine account could match the search and be bound against.
   */
  it('excludes computer accounts', () => {
    expect(
      ldapConfigSchema.parse({ url: 'ldaps://dc.corp:636', searchBase: 'dc=corp', dialect: 'ad' })
        .searchFilter,
    ).toContain('objectCategory=person');
  });

  it('labels the login field Username for AD and Email for OpenLDAP', () => {
    const base = { url: 'ldaps://dc.corp:636', searchBase: 'dc=corp' };
    expect(ldapConfigSchema.parse({ ...base, dialect: 'ad' }).identifierLabel).toBe('Username');
    expect(ldapConfigSchema.parse(base).identifierLabel).toBe('Email');
  });

  it('keeps an explicit search filter instead of the dialect default', () => {
    const custom = '(&(objectClass=user)(employeeID={{input}}))';
    expect(
      ldapConfigSchema.parse({
        url: 'ldaps://dc.corp:636',
        searchBase: 'dc=corp',
        dialect: 'ad',
        searchFilter: custom,
      }).searchFilter,
    ).toBe(custom);
  });

  it('defaults the group search base to the user search base', () => {
    const config = ldapConfigSchema.parse({
      url: 'ldaps://dc.corp:636',
      searchBase: 'ou=people,dc=corp',
      dialect: 'ad',
    });
    expect(config.groupSearchBase).toBe('ou=people,dc=corp');
  });
});

describe('LdapAuthProvider.currentConfiguration', () => {
  it('reports the configuration the provider is running with', () => {
    const reported = provider({
      config: config({
        url: 'ldaps://dc.corp.example:636',
        bindDn: 'cn=svc-puppet,ou=service,dc=corp,dc=example',
        searchBase: 'ou=staff,dc=corp,dc=example',
        dialect: 'ad',
      }),
    }).currentConfiguration();

    expect(reported).toMatchObject({
      url: 'ldaps://dc.corp.example:636',
      bindDn: 'cn=svc-puppet,ou=service,dc=corp,dc=example',
      searchBase: 'ou=staff,dc=corp,dc=example',
      dialect: 'ad',
    });
  });

  it('reports the role mappings in the settings shape, not the describe() shape', () => {
    // describe() renames groupDn to `group` for display. The settings form is
    // populated from this method and expects the schema's own field name.
    expect(provider().currentConfiguration()).toMatchObject({
      roleMappings: [
        { groupDn: 'cn=puppet-admins,ou=groups,dc=example,dc=com', role: 'ADMIN' },
        { groupDn: 'cn=ops,ou=groups,dc=example,dc=com', role: 'OPERATOR' },
      ],
    });
  });

  it('never reports the bind password', () => {
    // The result is rendered in a browser.
    const reported = provider({
      config: config({ bindDn: 'cn=svc,dc=example,dc=com', bindPassword: 'super-secret' }),
    }).currentConfiguration();

    expect(reported).not.toHaveProperty('bindPassword');
    expect(JSON.stringify(reported)).not.toContain('super-secret');
  });

  it('validates against the settings schema core will parse it with', async () => {
    // The real contract between the two packages. If core adds a required field
    // to ldapSettingsSchema, core silently discards this provider's report and
    // the settings form goes blank again. This is where that gets caught.
    const { ldapSettingsSchema } = await import('@nexuspuppet/contracts');

    const parsed = ldapSettingsSchema.safeParse(provider().currentConfiguration());

    expect(parsed.success).toBe(true);
  });

  it('survives core stripping the fields it has no home for', async () => {
    // caPath and attributes have no field in the settings schema. Reporting a
    // configuration that uses them must still yield a valid, useful result
    // rather than a validation failure that blanks the form.
    const { ldapSettingsSchema } = await import('@nexuspuppet/contracts');

    const parsed = ldapSettingsSchema.safeParse(
      provider({
        config: config({ caPath: '/etc/ssl/corp-ca.pem', nestedGroups: true }),
      }).currentConfiguration(),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.nestedGroups).toBe(true);
  });
});

describe('LdapAuthProvider.verifyConfiguration', () => {
  const candidate = {
    url: 'ldaps://candidate.example.com:636',
    bindDn: 'cn=svc,dc=example,dc=com',
    bindPassword: 'secret',
    searchBase: 'ou=people,dc=example,dc=com',
    roleMappings: [{ groupDn: 'cn=ops,dc=example,dc=com', role: 'OPERATOR' }],
  };

  it('never touches the live directory', async () => {
    // The contract's hardest requirement: an operator testing a typo must not
    // disturb the directory the deployment is currently authenticating against.
    let liveCalls = 0;
    const live = directory({
      findEntry: async () => {
        liveCalls += 1;
        return ENTRY;
      },
    });
    let candidateUrl: string | undefined;

    const p = new LdapAuthProvider({
      config: config(),
      directory: live,
      identities: identities(),
      logger: silent,
      directoryFor: (c) => {
        candidateUrl = c.url;
        return directory({ findEntry: async () => null });
      },
    });

    await p.verifyConfiguration(candidate);

    expect(liveCalls).toBe(0);
    expect(candidateUrl).toBe('ldaps://candidate.example.com:636');
  });

  /**
   * The gap that made Test Connection useless against a private CA.
   *
   * `caPath` is a mounted file and deliberately not a field the settings form
   * can send, so every candidate arrived with it undefined and was tested
   * against the system trust store. Against any directory with an internal CA —
   * essentially every on-premises Active Directory — the button reported
   * "unable to verify the first certificate" while real logins through that
   * same directory succeeded.
   *
   * Found on a live deployment: the account authenticated with HTTP 201 while
   * the console's own Test Connection called the configuration broken. An
   * operator following that advice would disable verification to make the test
   * pass, turning a correct deployment into an interceptable one.
   */
  it('tests the candidate with the CA this deployment actually has', async () => {
    let seen: string | undefined = 'not-called';
    const p = new LdapAuthProvider({
      config: config({ caPath: '/etc/nexuspuppet/certs/ad-ca.pem' }),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: (c) => {
        seen = c.caPath;
        return directory({ findEntry: async () => null });
      },
    });

    const result = await p.verifyConfiguration(candidate);

    expect(seen).toBe('/etc/nexuspuppet/certs/ad-ca.pem');
    // And it says so, rather than implying the submitted configuration carries
    // a CA it does not contain — the same configuration on a host without that
    // file must not be blessed by a test that passed here.
    expect(result.details).toEqual(
      expect.arrayContaining([
        {
          label: 'TLS verification',
          value: 'enforced (CA bundle /etc/nexuspuppet/certs/ad-ca.pem, from this deployment)',
        },
      ]),
    );
  });

  it('lets a candidate that names its own CA keep it', async () => {
    let seen: string | undefined;
    const p = new LdapAuthProvider({
      config: config({ caPath: '/etc/nexuspuppet/certs/ad-ca.pem' }),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: (c) => {
        seen = c.caPath;
        return directory({ findEntry: async () => null });
      },
    });

    const result = await p.verifyConfiguration({ ...candidate, caPath: '/tmp/other-ca.pem' });

    expect(seen).toBe('/tmp/other-ca.pem');
    expect(result.details).toEqual(
      expect.arrayContaining([
        { label: 'TLS verification', value: 'enforced (CA bundle /tmp/other-ca.pem)' },
      ]),
    );
  });

  it('does not invent a CA when the deployment has none', async () => {
    let seen: string | undefined = 'not-called';
    const p = new LdapAuthProvider({
      config: config(),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: (c) => {
        seen = c.caPath;
        return directory({ findEntry: async () => null });
      },
    });

    const result = await p.verifyConfiguration(candidate);

    expect(seen).toBeUndefined();
    expect(result.details).toEqual(
      expect.arrayContaining([
        { label: 'TLS verification', value: 'enforced (system trust store)' },
      ]),
    );
  });

  it('passes when the probe search completes and matches nothing', async () => {
    // Finding nobody is the EXPECTED result: the probe exists to complete a
    // bind and a search, not to read a real user.
    const p = provider({});
    const withFactory = new LdapAuthProvider({
      config: config(),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: () => directory({ findEntry: async () => null }),
    });
    void p;

    const result = await withFactory.verifyConfiguration(candidate);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('candidate.example.com');
    expect(result.details).toEqual(
      expect.arrayContaining([{ label: 'Bind account', value: 'cn=svc,dc=example,dc=com' }]),
    );
  });

  it("reports the directory's own words when it cannot connect", async () => {
    // A message invented here would describe a guess about the failure rather
    // than the failure. "certificate has expired" is actionable; "could not
    // connect" is not.
    const p = new LdapAuthProvider({
      config: config(),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: () => ({
        ...BASE_DIRECTORY,
        findEntry: async () => {
          throw new LdapUnavailableError('unable to verify the first certificate');
        },
      }),
    });

    const result = await p.verifyConfiguration(candidate);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('unable to verify the first certificate');
    // Details still carry what was attempted, so the operator can see which
    // URL and bind account produced that.
    expect(result.details).toEqual(
      expect.arrayContaining([{ label: 'Directory', value: 'ldaps://candidate.example.com:636' }]),
    );
  });

  it('refuses an unusable configuration without reaching for the network', async () => {
    let attempted = false;
    const p = new LdapAuthProvider({
      config: config(),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: () => {
        attempted = true;
        return directory();
      },
    });

    const result = await p.verifyConfiguration({ url: 'not-a-url', searchBase: '' });

    expect(result.ok).toBe(false);
    expect(attempted).toBe(false);
  });

  it('never throws, whatever the directory does', async () => {
    // "I could not reach that directory" is an ordinary answer to "does this
    // work" — the endpoint must not turn it into a 500.
    const p = new LdapAuthProvider({
      config: config(),
      directory: directory(),
      identities: identities(),
      logger: silent,
      directoryFor: () => ({
        ...BASE_DIRECTORY,
        findEntry: async () => {
          throw new Error('kaboom');
        },
      }),
    });

    await expect(p.verifyConfiguration(candidate)).resolves.toMatchObject({ ok: false });
  });
});
