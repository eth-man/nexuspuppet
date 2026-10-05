import type { ClientOptions, SearchOptions, SearchResult } from 'ldapts';
import type { ConnectionOptions } from 'node:tls';
import { ldapConfigSchema, type LdapConfig } from './config';
import { AD_CAPABILITY_OID } from './dialect';
import {
  LdapUnavailableError,
  LdaptsDirectory,
  ANONYMOUS_REFUSED,
  explainError,
  isAnonymousRefusal,
  type LdapClientFactory,
} from './ldap-client';

/**
 * The ORDER of what goes on the wire, against a client that records it.
 *
 * The property under test is the one STARTTLS exists for: nothing that carries
 * a credential — a service-account bind, a user bind — may precede the
 * upgrade, on any connection, and a failed upgrade must end the operation
 * rather than continue in clear text. A fake client is the right tool: it sees
 * every call in order, which a real server cannot report.
 *
 * test/ldap/ldap-integration.spec.ts runs the same paths against a real
 * OpenLDAP over LDAPS and STARTTLS.
 */

interface Script {
  startTLS?: (options: ConnectionOptions) => Promise<void>;
  bind?: (dn: string, password?: string) => Promise<void>;
  search?: (base: string, options?: SearchOptions) => Promise<SearchResult>;
}

/** A client factory that records every operation, across every client it makes. */
function recording(script: Script = {}): {
  calls: string[];
  options: ClientOptions[];
  tls: ConnectionOptions[];
  factory: LdapClientFactory;
} {
  const calls: string[] = [];
  const options: ClientOptions[] = [];
  const tls: ConnectionOptions[] = [];
  const factory: LdapClientFactory = (clientOptions) => {
    options.push(clientOptions);
    const id = options.length;
    return {
      startTLS: async (tlsOptions) => {
        calls.push(`${id}:startTLS`);
        tls.push(tlsOptions ?? {});
        await script.startTLS?.(tlsOptions ?? {});
      },
      bind: async (dn, password) => {
        calls.push(`${id}:bind ${dn}`);
        await script.bind?.(dn, password);
      },
      search: async (base, searchOptions) => {
        calls.push(`${id}:search ${base === '' ? '(RootDSE)' : base}`);
        return (await script.search?.(base, searchOptions)) ?? EMPTY;
      },
      unbind: async () => {
        calls.push(`${id}:unbind`);
      },
    };
  };
  return { calls, options, tls, factory };
}

const EMPTY: SearchResult = { searchEntries: [], searchReferences: [] };

function config(overrides: Record<string, unknown> = {}): LdapConfig {
  return ldapConfigSchema.parse({
    host: 'dc01.corp.example',
    protocol: 'starttls',
    bindType: 'regular',
    bindDn: 'cn=svc,dc=corp,dc=example',
    bindPassword: 'svc-secret',
    searchBase: 'ou=people,dc=corp,dc=example',
    timeoutMs: 2000,
    ...overrides,
  });
}

/** An LDAP result error as ldapts throws it: a NUMERIC code. */
function ldapResult(code: number, message = 'refused'): Error {
  return Object.assign(new Error(message), { code });
}

/** A Node TLS error: a STRING code. */
function tlsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const silent = { warn: (): void => {} };

describe('LdaptsDirectory over STARTTLS', () => {
  it('upgrades before the service-account bind, on the search connection', async () => {
    const wire = recording();
    await new LdaptsDirectory(config(), silent, wire.factory).findEntry('(uid=alice)');

    expect(wire.calls).toEqual([
      '1:startTLS',
      '1:bind cn=svc,dc=corp,dc=example',
      '1:search ou=people,dc=corp,dc=example',
      '1:unbind',
    ]);
  });

  it('upgrades before an anonymous search, which then binds as nobody', async () => {
    const wire = recording();
    await new LdaptsDirectory(config({ bindType: 'anonymous' }), silent, wire.factory).findEntry(
      '(uid=alice)',
    );

    expect(wire.calls).toEqual(['1:startTLS', '1:search ou=people,dc=corp,dc=example', '1:unbind']);
  });

  it('upgrades before the USER bind, on its own connection', async () => {
    const wire = recording();
    await new LdaptsDirectory(config(), silent, wire.factory).verifyCredentials(
      'uid=alice,ou=people,dc=corp,dc=example',
      'alice-password',
    );

    expect(wire.calls).toEqual([
      '1:startTLS',
      '1:bind uid=alice,ou=people,dc=corp,dc=example',
      '1:unbind',
    ]);
  });

  it('upgrades before the nested-group search binds', async () => {
    const wire = recording();
    await new LdaptsDirectory(config(), silent, wire.factory).findGroupsContaining('uid=alice');

    expect(wire.calls.slice(0, 2)).toEqual(['1:startTLS', '1:bind cn=svc,dc=corp,dc=example']);
  });

  it('upgrades before a Simple bind, and reads the entry on that same connection', async () => {
    const wire = recording({
      search: async (base) =>
        base === 'uid=alice,ou=people,dc=corp,dc=example'
          ? { searchEntries: [{ dn: base, mail: 'alice@corp.example' }], searchReferences: [] }
          : EMPTY,
    });
    const result = await new LdaptsDirectory(
      config({ bindType: 'simple', userDnPattern: 'uid={username},ou=people,dc=corp,dc=example' }),
      silent,
      wire.factory,
    ).bindAndRead(
      'uid=alice,ou=people,dc=corp,dc=example',
      'alice-password',
      { dn: 'uid=alice,ou=people,dc=corp,dc=example' },
      { nestedGroups: true },
    );

    expect(result).toMatchObject({ bound: true, entry: { email: 'alice@corp.example' } });
    expect(wire.calls).toEqual([
      '1:startTLS',
      '1:bind uid=alice,ou=people,dc=corp,dc=example',
      '1:search uid=alice,ou=people,dc=corp,dc=example',
      // Nested groups as the user, on the same connection: there is no
      // service account to ask.
      '1:search ou=people,dc=corp,dc=example',
      '1:unbind',
    ]);
  });

  it('upgrades before reading the RootDSE', async () => {
    const wire = recording();
    await new LdaptsDirectory(config(), silent, wire.factory).detectDialect();

    expect(wire.calls[0]).toBe('1:startTLS');
  });

  it('upgrades EVERY connection it opens, not only the first', async () => {
    const wire = recording({
      search: async () => ({
        searchEntries: [{ dn: 'uid=alice,ou=people,dc=corp,dc=example' }],
        searchReferences: [],
      }),
    });
    const directory = new LdaptsDirectory(config(), silent, wire.factory);

    await directory.findEntry('(uid=alice)');
    await directory.verifyCredentials('uid=alice,ou=people,dc=corp,dc=example', 'pw');

    const opened = wire.options.length;
    const upgraded = wire.calls.filter((call) => call.endsWith(':startTLS')).length;
    expect(opened).toBe(2);
    expect(upgraded).toBe(opened);
  });

  describe('fails closed', () => {
    it('never binds when the server refuses STARTTLS, and says so', async () => {
      const wire = recording({
        startTLS: async () => {
          throw ldapResult(2, 'unsupported extended operation');
        },
      });

      const attempt = new LdaptsDirectory(config(), silent, wire.factory).findEntry('(uid=a)');

      await expect(attempt).rejects.toBeInstanceOf(LdapUnavailableError);
      await expect(attempt).rejects.toThrow(/refused STARTTLS[\s\S]*No credentials were sent/);
      expect(wire.calls.some((call) => call.includes(':bind'))).toBe(false);
      expect(wire.calls.some((call) => call.includes(':search'))).toBe(false);
    });

    it('never sends the USER password when the upgrade fails', async () => {
      const wire = recording({
        startTLS: async () => {
          throw ldapResult(52, 'unavailable');
        },
      });

      await expect(
        new LdaptsDirectory(config(), silent, wire.factory).verifyCredentials('uid=a', 'pw'),
      ).rejects.toBeInstanceOf(LdapUnavailableError);
      expect(wire.calls).toEqual(['1:startTLS', '1:unbind']);
    });

    it('names an untrusted certificate as such', async () => {
      const wire = recording({
        startTLS: async () => {
          throw tlsError(
            'SELF_SIGNED_CERT_IN_CHAIN',
            'self-signed certificate in certificate chain',
          );
        },
      });

      await expect(
        new LdaptsDirectory(config(), silent, wire.factory).findEntry('(uid=a)'),
      ).rejects.toThrow(/certificate is not trusted[\s\S]*CA certificate \(PEM\)/);
      expect(wire.calls.some((call) => call.includes(':bind'))).toBe(false);
    });

    it('names a certificate issued for another name, and says which name to use', async () => {
      const wire = recording({
        startTLS: async () => {
          throw tlsError(
            'ERR_TLS_CERT_ALTNAME_INVALID',
            "Hostname/IP does not match certificate's altnames",
          );
        },
      });

      await expect(
        new LdaptsDirectory(config(), silent, wire.factory).findEntry('(uid=a)'),
      ).rejects.toThrow(/not valid for the name "dc01\.corp\.example"[\s\S]*on its certificate/);
    });

    it('gives up on a handshake that never finishes, without binding', async () => {
      const wire = recording({ startTLS: () => new Promise<void>(() => {}) });

      await expect(
        new LdaptsDirectory(config({ timeoutMs: 50 }), silent, wire.factory).findEntry('(uid=a)'),
      ).rejects.toThrow(/STARTTLS failed[\s\S]*No credentials were sent/);
      expect(wire.calls.some((call) => call.includes(':bind'))).toBe(false);
    });

    /**
     * ldapts reconnects a dropped connection transparently, and its reconnect
     * is plain TCP. A bind after a lost STARTTLS session would go out in clear
     * text on the new socket — so the client may open exactly one.
     */
    it('refuses to open a second, unencrypted socket after the first', async () => {
      const wire = recording();
      await new LdaptsDirectory(config(), silent, wire.factory).findEntry('(uid=a)');

      const createConnection = wire.options[0]?.createConnection;
      expect(createConnection).toBeDefined();

      // The first connection is the real one; point it somewhere closed.
      const first = createConnection!(1, '127.0.0.1');
      first.on('error', () => {});
      first.destroy();

      expect(() => createConnection!(1, '127.0.0.1')).toThrow(
        /reconnecting would not be encrypted/,
      );
    });
  });

  it('verifies the certificate against the configured name, and sends it as SNI', async () => {
    const wire = recording();
    await new LdaptsDirectory(
      config({ caPem: undefined, tlsRejectUnauthorized: true }),
      silent,
      wire.factory,
    ).findEntry('(uid=a)');

    expect(wire.tls[0]).toMatchObject({
      host: 'dc01.corp.example',
      servername: 'dc01.corp.example',
      rejectUnauthorized: true,
    });
  });

  it('never sends an IP address as SNI (RFC 6066), but still verifies against it', async () => {
    const wire = recording();
    await new LdaptsDirectory(config({ host: '192.0.2.10' }), silent, wire.factory).findEntry(
      '(uid=a)',
    );

    expect(wire.tls[0]).toMatchObject({ host: '192.0.2.10' });
    expect(wire.tls[0]).not.toHaveProperty('servername');
  });

  it('starts on ldap:// and the configured port', async () => {
    const wire = recording();
    await new LdaptsDirectory(config({ port: 3890 }), silent, wire.factory).findEntry('(uid=a)');

    expect(wire.options[0]?.url).toBe('ldap://dc01.corp.example:3890');
  });
});

describe('LdaptsDirectory over LDAPS', () => {
  it('connects with TLS from the first byte and never issues STARTTLS', async () => {
    const wire = recording();
    await new LdaptsDirectory(config({ protocol: 'ldaps' }), silent, wire.factory).findEntry(
      '(uid=a)',
    );

    expect(wire.options[0]?.url).toBe('ldaps://dc01.corp.example:636');
    expect(wire.options[0]?.tlsOptions).toMatchObject({
      host: 'dc01.corp.example',
      servername: 'dc01.corp.example',
    });
    expect(wire.calls).not.toContain('1:startTLS');
  });
});

describe('LdaptsDirectory over legacy unencrypted ldap://', () => {
  it('behaves exactly as before ADR-0030: no TLS options, no upgrade', async () => {
    const wire = recording();
    await new LdaptsDirectory(config({ protocol: 'ldap' }), silent, wire.factory).findEntry(
      '(uid=a)',
    );

    expect(wire.options[0]?.url).toBe('ldap://dc01.corp.example:389');
    expect(wire.options[0]?.tlsOptions).toBeUndefined();
    expect(wire.options[0]?.createConnection).toBeUndefined();
    expect(wire.calls[0]).toBe('1:bind cn=svc,dc=corp,dc=example');
  });
});

/**
 * An EMPTY password is an unauthenticated bind (RFC 4513 §5.1.2) — many
 * servers answer it with success. The provider refuses it first; the client
 * refuses it again, without opening a connection, for every bind type.
 */
describe('LdaptsDirectory never sends an empty password', () => {
  for (const bindType of ['regular', 'anonymous', 'simple'] as const) {
    it(`refuses it without connecting (${bindType})`, async () => {
      const wire = recording();
      const directory = new LdaptsDirectory(
        config({
          bindType,
          ...(bindType === 'simple'
            ? { userDnPattern: 'uid={username},ou=people,dc=corp,dc=example' }
            : {}),
        }),
        silent,
        wire.factory,
      );

      await expect(directory.verifyCredentials('uid=alice', '')).resolves.toBe(false);
      await expect(
        directory.bindAndRead('uid=alice', '', { dn: 'uid=alice' }, { nestedGroups: false }),
      ).resolves.toEqual({ bound: false });
      expect(wire.options).toHaveLength(0);
    });
  }
});

describe('LdaptsDirectory Simple bind', () => {
  const simple = config({
    bindType: 'simple',
    userDnPattern: '{username}@corp.example',
  });

  it('reports a rejected password as not bound, not as an outage', async () => {
    const wire = recording({
      bind: async () => {
        throw ldapResult(49, 'invalidCredentials');
      },
    });

    await expect(
      new LdaptsDirectory(simple, silent, wire.factory).bindAndRead(
        'alice@corp.example',
        'wrong',
        { filter: '(userPrincipalName=alice@corp.example)' },
        { nestedGroups: false },
      ),
    ).resolves.toEqual({ bound: false });
  });

  it('refuses to pick between two entries carrying the same UPN', async () => {
    const wire = recording({
      search: async () => ({
        searchEntries: [{ dn: 'cn=a,dc=corp' }, { dn: 'cn=b,dc=corp' }],
        searchReferences: [],
      }),
    });

    await expect(
      new LdaptsDirectory(simple, silent, wire.factory).bindAndRead(
        'alice@corp.example',
        'pw',
        { filter: '(userPrincipalName=alice@corp.example)' },
        { nestedGroups: false },
      ),
    ).rejects.toThrow(/More than one directory entry/);
  });

  it('asks for at most two entries, so a third cannot hide behind the first', async () => {
    const seen: Array<SearchOptions | undefined> = [];
    const wire = recording({
      search: async (_base, options) => {
        seen.push(options);
        return EMPTY;
      },
    });

    await new LdaptsDirectory(simple, silent, wire.factory).bindAndRead(
      'alice@corp.example',
      'pw',
      { filter: '(userPrincipalName=alice@corp.example)' },
      { nestedGroups: false },
    );
    expect(seen[0]).toMatchObject({
      sizeLimit: 2,
      filter: '(userPrincipalName=alice@corp.example)',
    });
  });

  it('treats an entry the person may not read as unreadable, not as an outage', async () => {
    const wire = recording({
      search: async () => {
        throw ldapResult(32, 'noSuchObject');
      },
    });

    await expect(
      new LdaptsDirectory(simple, silent, wire.factory).bindAndRead(
        'uid=alice,dc=corp',
        'pw',
        { dn: 'uid=alice,dc=corp' },
        { nestedGroups: false },
      ),
    ).resolves.toEqual({ bound: true, entry: null, nestedGroups: null });
  });

  it('keeps the login when only the nested-group query fails, and says why', async () => {
    const wire = recording({
      search: async (base) => {
        if (base === 'uid=alice,dc=corp') {
          return {
            searchEntries: [{ dn: base, memberOf: 'cn=ops,dc=corp' }],
            searchReferences: [],
          };
        }
        throw ldapResult(1, 'operationsError');
      },
    });

    const result = await new LdaptsDirectory(simple, silent, wire.factory).bindAndRead(
      'uid=alice,dc=corp',
      'pw',
      { dn: 'uid=alice,dc=corp' },
      { nestedGroups: true },
    );
    expect(result).toMatchObject({
      bound: true,
      entry: { groupDns: ['cn=ops,dc=corp'] },
      nestedGroups: null,
      nestedError: expect.stringContaining('operationsError'),
    });
  });
});

/** The directory type, read from the RootDSE (ADR-0030 §4). */
describe('LdaptsDirectory.detectDialect', () => {
  const rootDse = (attributes: Record<string, string | string[]>): SearchResult => ({
    searchEntries: [{ dn: '', ...attributes }],
    searchReferences: [],
  });

  it('says Active Directory when the RootDSE advertises LDAP_CAP_ACTIVE_DIRECTORY_OID', async () => {
    const wire = recording({
      search: async () =>
        rootDse({
          supportedCapabilities: [AD_CAPABILITY_OID, '1.2.840.113556.1.4.1670'],
          supportedLDAPVersion: ['3', '2'],
        }),
    });

    await expect(
      new LdaptsDirectory(config(), silent, wire.factory).detectDialect(),
    ).resolves.toEqual({ dialect: 'ad', readAs: 'anonymous' });
    // Anonymously: no bind was needed to read it.
    expect(wire.calls.some((call) => call.includes(':bind'))).toBe(false);
  });

  it('says OpenLDAP for a readable RootDSE without that capability', async () => {
    const wire = recording({
      search: async () =>
        rootDse({ supportedLDAPVersion: '3', namingContexts: 'dc=example,dc=com' }),
    });

    await expect(
      new LdaptsDirectory(config(), silent, wire.factory).detectDialect(),
    ).resolves.toEqual({ dialect: 'openldap', readAs: 'anonymous' });
  });

  it('binds as the service account and retries when the RootDSE is hidden from anonymous', async () => {
    let bound = false;
    const wire = recording({
      bind: async () => {
        bound = true;
      },
      search: async () => {
        if (!bound) throw ldapResult(50, 'insufficientAccessRights');
        return rootDse({ supportedCapabilities: AD_CAPABILITY_OID });
      },
    });

    await expect(
      new LdaptsDirectory(config(), silent, wire.factory).detectDialect(),
    ).resolves.toEqual({ dialect: 'ad', readAs: 'service account' });
    expect(wire.calls).toEqual([
      '1:startTLS',
      '1:search (RootDSE)',
      '1:bind cn=svc,dc=corp,dc=example',
      '1:search (RootDSE)',
      '1:unbind',
    ]);
  });

  it('answers "unknown" when nobody can read it, without inventing a bind', async () => {
    const wire = recording({
      search: async () => {
        throw ldapResult(50, 'insufficientAccessRights');
      },
    });

    await expect(
      new LdaptsDirectory(config({ bindType: 'anonymous' }), silent, wire.factory).detectDialect(),
    ).resolves.toEqual({ dialect: null, readAs: null });
    expect(wire.calls.some((call) => call.includes(':bind'))).toBe(false);
  });

  it('treats an empty RootDSE as unknown, not as OpenLDAP', async () => {
    const wire = recording({ search: async () => rootDse({}) });

    await expect(
      new LdaptsDirectory(config({ bindType: 'anonymous' }), silent, wire.factory).detectDialect(),
    ).resolves.toEqual({ dialect: null, readAs: null });
  });

  it('reports a transport failure as an outage, not as "unknown"', async () => {
    const wire = recording({
      search: async () => {
        throw tlsError('ECONNRESET', 'socket hang up');
      },
    });

    await expect(
      new LdaptsDirectory(config({ bindType: 'anonymous' }), silent, wire.factory).detectDialect(),
    ).rejects.toBeInstanceOf(LdapUnavailableError);
  });

  it('reports a service account the directory refuses, by name', async () => {
    const wire = recording({
      bind: async () => {
        throw ldapResult(49, 'invalidCredentials');
      },
      search: async () => {
        throw ldapResult(50, 'insufficientAccessRights');
      },
    });

    await expect(
      new LdaptsDirectory(config(), silent, wire.factory).detectDialect(),
    ).rejects.toThrow(/refused the User DN and password \(cn=svc,dc=corp,dc=example\)/);
  });
});

describe('explainError', () => {
  const target = {
    host: 'dc01.corp.example',
    port: 636,
    protocol: 'ldaps' as const,
    timeoutMs: 1000,
  };

  it('points an LDAPS handshake failure at STARTTLS', () => {
    expect(explainError(tlsError('EPROTO', 'wrong version number'), target)).toMatch(
      /choose STARTTLS/,
    );
  });

  it('names a refused port', () => {
    expect(explainError(tlsError('ECONNREFUSED', 'connect ECONNREFUSED'), target)).toMatch(
      /Nothing is accepting connections on dc01\.corp\.example:636/,
    );
  });

  it('names a name that does not resolve', () => {
    expect(explainError(tlsError('ENOTFOUND', 'getaddrinfo ENOTFOUND'), target)).toMatch(
      /"dc01\.corp\.example" does not resolve/,
    );
  });

  it('keeps the library’s own words for anything else', () => {
    expect(explainError(new Error('something odd'), target)).toBe('Error: something odd');
  });
});

/**
 * An anonymous search the directory will not serve. Each says so differently
 * and none plainly; the operator is told plainly, with the original beneath.
 */
describe('a directory that refuses anonymous searches', () => {
  /** AD's answer to an unbound search, as a Windows Server 2025 DC words it. */
  const AD_000004DC = Object.assign(
    new Error(
      '000004DC: LdapErr: DSID-0C090CA2, comment: In order to perform this operation a ' +
        'successful bind must be completed on the connection., data 0, v4f7c Code: 0x1',
    ),
    { name: 'OperationsError', code: 1 },
  );

  it.each([
    ['Active Directory (000004DC)', AD_000004DC],
    ['OpenLDAP requiring authentication', ldapResult(53, 'authentication required Code: 0x35')],
    ['insufficientAccessRights', ldapResult(50, 'insufficient access')],
    ['inappropriateAuthentication', ldapResult(48, 'anonymous bind disallowed')],
  ])('recognises %s', (_name, error) => {
    expect(isAnonymousRefusal(error)).toBe(true);
  });

  it.each([
    ['an ordinary operations error', ldapResult(1, 'something else')],
    ['a busy server', ldapResult(51, 'busy')],
    ['a transport failure', tlsError('ECONNRESET', 'socket hang up')],
  ])('does not mistake %s for one', (_name, error) => {
    expect(isAnonymousRefusal(error)).toBe(false);
  });

  it('says so plainly for an Anonymous configuration, keeping the raw text as detail', async () => {
    const wire = recording({
      search: async () => {
        throw AD_000004DC;
      },
    });

    const failure = await new LdaptsDirectory(
      config({ bindType: 'anonymous' }),
      silent,
      wire.factory,
    )
      .findEntry('(mail=a)')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LdapUnavailableError);
    expect((failure as LdapUnavailableError).message).toBe(ANONYMOUS_REFUSED);
    expect((failure as LdapUnavailableError).detail).toMatch(
      /^LDAP search failed: OperationsError: 000004DC/,
    );
  });

  it('names a hidden search base on OpenLDAP without blaming it on anonymity alone', async () => {
    const wire = recording({
      search: async () => {
        throw ldapResult(32, 'No Such Object Code: 0x20');
      },
    });

    await expect(
      new LdaptsDirectory(config({ bindType: 'anonymous' }), silent, wire.factory).findEntry(
        '(a=b)',
      ),
    ).rejects.toThrow(/search base was not found — or this directory hides it from anonymous/);
  });

  it('leaves a Regular configuration’s errors as they were', async () => {
    const wire = recording({
      search: async () => {
        throw AD_000004DC;
      },
    });

    await expect(
      new LdaptsDirectory(config(), silent, wire.factory).findEntry('(mail=a)'),
    ).rejects.toThrow(/^LDAP search failed: OperationsError: 000004DC/);
  });
});
