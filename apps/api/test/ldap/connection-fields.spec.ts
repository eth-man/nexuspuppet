import { readFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { Client } from 'ldapts';
import { ldapConfigSchema, type LdapConfig } from '../../src/directory/ldap/config';
import {
  LdapAuthProvider,
  type LdapIdentityStore,
  type StoredIdentity,
} from '../../src/directory/ldap/ldap-auth.provider';
import { LdapUnavailableError, LdaptsDirectory } from '../../src/directory/ldap/ldap-client';

/**
 * ADR-0030 against a REAL OpenLDAP: LDAPS and STARTTLS, each bind type, a
 * pasted CA, the directory type read from a real RootDSE — and STARTTLS
 * failing CLOSED, proven by recording every byte the client sends.
 *
 *   npm run ldap:up --workspace @nexuspuppet/api
 *   npm run test:ldap --workspace @nexuspuppet/api
 *
 * The fixture serves, on loopback only:
 *   :3890  plain LDAP that offers STARTTLS
 *   :6360  LDAPS
 *   :3892  a second directory with NO TLS, which refuses STARTTLS
 */

jest.setTimeout(30_000);

const BASE_DN = 'dc=nexuspuppet,dc=test';
const HOST = process.env['TEST_LDAP_HOST'] ?? 'localhost';

/**
 * The fixture's CA, as an operator would PASTE it — read at runtime, never
 * written into this file.
 */
const CA_PEM = readFileSync(join(__dirname, 'certs', 'ca.crt'), 'utf8');

const MAPPINGS = [
  { groupDn: `cn=ops,ou=groups,${BASE_DN}`, role: 'OPERATOR' },
  { groupDn: `cn=viewers,ou=groups,${BASE_DN}`, role: 'VIEWER' },
  { groupDn: `cn=puppet-admins,ou=groups,${BASE_DN}`, role: 'ADMIN' },
];

const REGULAR = {
  bindType: 'regular',
  bindDn: `cn=svc-nexuspuppet,${BASE_DN}`,
  bindPassword: 'svc-password',
};
const ANONYMOUS = { bindType: 'anonymous' };
const SIMPLE = { bindType: 'simple', userDnPattern: `uid={username},ou=people,${BASE_DN}` };

const STARTTLS = { host: HOST, port: 3890, protocol: 'starttls' };
const LDAPS = { host: HOST, port: 6360, protocol: 'ldaps' };

function config(...parts: Array<Record<string, unknown>>): LdapConfig {
  return ldapConfigSchema.parse(
    Object.assign(
      {
        searchBase: `ou=people,${BASE_DN}`,
        searchFilter: '(&(objectClass=inetOrgPerson)(mail={{input}}))',
        roleMappings: MAPPINGS,
        caPem: CA_PEM,
        timeoutMs: 5000,
      },
      ...parts,
    ),
  );
}

function person(id: string, email: string): StoredIdentity {
  return {
    userId: id,
    email,
    displayName: email,
    role: 'VIEWER',
    isActive: true,
    authSource: 'ldap',
  };
}

const PEOPLE: Record<string, StoredIdentity> = {
  'alice@nexuspuppet.test': person(
    '11111111-1111-4111-8111-111111111111',
    'alice@nexuspuppet.test',
  ),
  'bob@nexuspuppet.test': person('22222222-2222-4222-8222-222222222222', 'bob@nexuspuppet.test'),
  'dave@nexuspuppet.test': person('44444444-4444-4444-8444-444444444444', 'dave@nexuspuppet.test'),
};

const identities: LdapIdentityStore = {
  findByEmail: async (email) => PEOPLE[email.toLowerCase()] ?? null,
  findById: async (id) => Object.values(PEOPLE).find((p) => p.userId === id) ?? null,
  recordLogin: async () => {},
};

const silent = { log: (): void => {}, warn: (): void => {}, error: (): void => {} };

function provider(cfg: LdapConfig): LdapAuthProvider {
  return new LdapAuthProvider({
    config: cfg,
    directory: new LdaptsDirectory(cfg, silent),
    identities,
    logger: silent,
  });
}

describe.each([
  ['STARTTLS', STARTTLS],
  ['LDAPS', LDAPS],
])('over %s, trusting a pasted CA', (_name, transport) => {
  it('Regular: the service account finds alice, alice binds, OPERATOR', async () => {
    const result = await provider(config(transport, REGULAR)).authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });
    expect(result).toMatchObject({ ok: true, principal: { role: 'OPERATOR' } });
  });

  it('Anonymous: bob is found without a service account, binds, VIEWER', async () => {
    const result = await provider(config(transport, ANONYMOUS)).authenticate({
      email: 'bob@nexuspuppet.test',
      password: 'bob-password',
    });
    expect(result).toMatchObject({ ok: true, principal: { role: 'VIEWER' } });
  });

  it('Simple: dave binds directly with the pattern and reads his own groups, ADMIN', async () => {
    const p = provider(config(transport, SIMPLE));
    expect(p.identifierLabel).toBe('Email');

    // What a person types is their account's address; {username} is the part
    // before the @. (resolver-login.spec.ts runs this through the resolver.)
    const result = await p.authenticate({
      email: 'dave@nexuspuppet.test',
      password: 'dave-password',
    });
    expect(result).toMatchObject({
      ok: true,
      principal: { role: 'ADMIN', email: 'dave@nexuspuppet.test', displayName: 'Dave Okafor' },
    });
  });

  it('Simple: a wrong password is a wrong password', async () => {
    await expect(
      provider(config(transport, SIMPLE)).authenticate({
        email: 'dave@nexuspuppet.test',
        password: 'nope',
      }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  /**
   * Unescaped, `alice,ou=people` would build `uid=alice,ou=people,ou=people,…`
   * — a different DN. Escaped, it is one uid value no entry has, and the
   * server refuses the bind like any wrong password.
   */
  it.each(['alice,ou=people', 'alice+cn=Alice Ng', 'uid=alice', 'alice\\', '#alice'])(
    'Simple: the username %j cannot change which DN is bound',
    async (username) => {
      await expect(
        provider(config(transport, SIMPLE)).authenticate({
          email: `${username}@nexuspuppet.test`,
          password: 'alice-password',
        }),
      ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
    },
  );

  it('reads the RootDSE and calls it OpenLDAP', async () => {
    await expect(
      new LdaptsDirectory(config(transport, ANONYMOUS), silent).detectDialect(),
    ).resolves.toEqual({ dialect: 'openldap', readAs: 'anonymous' });
  });

  it('Test connection passes, and reports what it detected', async () => {
    const candidate = {
      ...transport,
      ...REGULAR,
      searchBase: `ou=people,${BASE_DN}`,
      caPem: CA_PEM,
      roleMappings: MAPPINGS,
    };
    const result = await provider(config(transport, REGULAR)).verifyConfiguration(candidate);

    expect(result).toMatchObject({ ok: true, detectedDialect: 'openldap' });
    expect(result.message).toContain(`over ${_name}`);
    expect(JSON.stringify(result)).not.toContain('svc-password');
  });

  it('refuses the same server when the CA is not supplied, naming the certificate', async () => {
    const { caPem: _drop, ...noCa } = {
      ...transport,
      ...REGULAR,
      searchBase: `ou=people,${BASE_DN}`,
      caPem: CA_PEM,
    };
    void _drop;
    const result = await provider(config(transport, REGULAR)).verifyConfiguration(noCa);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/certificate is not trusted/);
  });
});

/**
 * An empty password is an unauthenticated bind. This fixture is configured to
 * ACCEPT one (bind_anon_dn) — so these prove the refusal is ours, in every
 * bind type, not the server's.
 */
describe('an empty password, against a server that would accept it', () => {
  it('is accepted by the server itself (the premise)', async () => {
    const raw = new Client({ url: 'ldap://127.0.0.1:3890', timeout: 5000 });
    try {
      await expect(raw.bind(`uid=alice,ou=people,${BASE_DN}`, '')).resolves.toBeUndefined();
    } finally {
      await raw.unbind().catch(() => {});
    }
  });

  it.each([
    ['Regular', REGULAR],
    ['Anonymous', ANONYMOUS],
    ['Simple', SIMPLE],
  ])('is refused by the console (%s)', async (_name, bind) => {
    const email = 'alice@nexuspuppet.test';
    await expect(
      provider(config(STARTTLS, bind)).authenticate({ email, password: '' }),
    ).resolves.toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });
});

/**
 * STARTTLS FAILS CLOSED.
 *
 * A proxy between the client and the directory records every byte the CLIENT
 * sends. Whatever goes wrong with the upgrade, that record must hold no
 * BindRequest, no search, and neither the service account's password nor the
 * user's — only the request to upgrade, and the close.
 */
describe('STARTTLS fails closed', () => {
  interface Recorder {
    port: number;
    sent: () => Buffer;
    close: () => Promise<void>;
  }

  /** Forward to `target` and record what the client sends. */
  async function recordingProxy(
    target: number,
    intercept?: (chunk: Buffer, client: Socket) => boolean,
  ): Promise<Recorder> {
    const chunks: Buffer[] = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer((client) => {
      sockets.add(client);
      const upstream = intercept === undefined ? connect(target, '127.0.0.1') : null;
      if (upstream !== null) {
        sockets.add(upstream);
        upstream.on('data', (data) => client.write(data));
        upstream.on('error', () => client.destroy());
        upstream.on('close', () => client.destroy());
      }
      client.on('data', (data: Buffer) => {
        chunks.push(Buffer.from(data));
        if (intercept !== undefined) {
          intercept(data, client);
          return;
        }
        upstream?.write(data);
      });
      client.on('error', () => upstream?.destroy());
      client.on('close', () => upstream?.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return {
      port: address.port,
      sent: () => Buffer.concat(chunks),
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /**
   * The protocol operations in a stream of LDAP messages, by tag. Stops at the
   * first byte that does not start an LDAPMessage — which, after a STARTTLS
   * request, is a TLS ClientHello (0x16): encrypted from there on.
   */
  function operations(bytes: Buffer): number[] {
    const ops: number[] = [];
    let offset = 0;
    const length = (at: number): [number, number] => {
      const first = bytes[at]!;
      if (first < 0x80) return [first, 1];
      const count = first & 0x7f;
      let value = 0;
      for (let i = 1; i <= count; i += 1) value = value * 256 + bytes[at + i]!;
      return [value, 1 + count];
    };
    while (offset < bytes.length && bytes[offset] === 0x30) {
      const [messageLength, lengthBytes] = length(offset + 1);
      const body = offset + 1 + lengthBytes;
      // messageID: INTEGER (0x02), then the operation's tag.
      const [idLength, idLengthBytes] = length(body + 1);
      ops.push(bytes[body + 1 + idLengthBytes + idLength]!);
      offset = body + messageLength;
    }
    return ops;
  }

  const BIND_REQUEST = 0x60;
  const SEARCH_REQUEST = 0x63;
  const EXTENDED_REQUEST = 0x77;
  const STARTTLS_OID = '1.3.6.1.4.1.1466.20037';

  function assertNothingSecretSent(sent: Buffer): void {
    const ops = operations(sent);
    expect(ops[0]).toBe(EXTENDED_REQUEST);
    expect(sent.includes(Buffer.from(STARTTLS_OID))).toBe(true);
    expect(ops).not.toContain(BIND_REQUEST);
    expect(ops).not.toContain(SEARCH_REQUEST);
    for (const secret of ['svc-password', 'alice-password', 'svc-nexuspuppet', 'uid=alice']) {
      expect(sent.includes(Buffer.from(secret))).toBe(false);
    }
  }

  /** A real directory with no TLS, which answers STARTTLS with protocolError. */
  describe('against a directory that refuses STARTTLS', () => {
    let proxy: Recorder;
    beforeEach(async () => {
      proxy = await recordingProxy(3892);
    });
    afterEach(async () => {
      await proxy.close();
    });

    const refusing = (bind: Record<string, unknown>) =>
      config({ host: '127.0.0.1', port: proxy.port, protocol: 'starttls' }, bind);

    it('sends no service-account bind, and says why', async () => {
      const attempt = new LdaptsDirectory(refusing(REGULAR), silent).findEntry(
        '(mail=alice@nexuspuppet.test)',
      );

      await expect(attempt).rejects.toBeInstanceOf(LdapUnavailableError);
      await expect(attempt).rejects.toThrow(/refused STARTTLS[\s\S]*No credentials were sent/);
      assertNothingSecretSent(proxy.sent());
    });

    it('sends no user password', async () => {
      await expect(
        new LdaptsDirectory(refusing(ANONYMOUS), silent).verifyCredentials(
          `uid=alice,ou=people,${BASE_DN}`,
          'alice-password',
        ),
      ).rejects.toBeInstanceOf(LdapUnavailableError);
      assertNothingSecretSent(proxy.sent());
    });

    it('sends no Simple bind', async () => {
      await expect(
        provider(refusing(SIMPLE)).authenticate({
          email: 'alice@nexuspuppet.test',
          password: 'alice-password',
        }),
      ).resolves.toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
      assertNothingSecretSent(proxy.sent());
    });

    it('is reported by Test connection in those words', async () => {
      const result = await provider(refusing(REGULAR)).verifyConfiguration({
        host: '127.0.0.1',
        port: proxy.port,
        protocol: 'starttls',
        ...REGULAR,
        searchBase: `ou=people,${BASE_DN}`,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^The server refused STARTTLS/);
      expect(result.message).toMatch(/No credentials were sent/);
      assertNothingSecretSent(proxy.sent());
    });
  });

  /**
   * STRIPPING: something on the path answers "yes, go ahead" to STARTTLS and
   * then does not speak TLS. A client that took the "yes" as security would
   * bind next, in clear text, to whoever said it. This one starts a handshake,
   * gets nothing back, and gives up.
   */
  it('sends nothing but a ClientHello to a man in the middle that fakes "STARTTLS accepted"', async () => {
    const proxy = await recordingProxy(0, (chunk, client) => {
      // The first message is the extended request; answer it with success,
      // echoing its messageID, as a stripping attacker would.
      if (chunk[0] !== 0x30) return true;
      const messageId = chunk[4]!;
      client.write(
        Buffer.from([
          0x30,
          0x0c,
          0x02,
          0x01,
          messageId,
          0x78,
          0x07,
          0x0a,
          0x01,
          0x00,
          0x04,
          0x00,
          0x04,
          0x00,
        ]),
      );
      return true;
    });
    try {
      const cfg = config(
        { host: '127.0.0.1', port: proxy.port, protocol: 'starttls', timeoutMs: 1500 },
        REGULAR,
      );
      await expect(
        new LdaptsDirectory(cfg, silent).findEntry('(mail=alice@nexuspuppet.test)'),
      ).rejects.toThrow(/STARTTLS failed[\s\S]*No credentials were sent/);

      const sent = proxy.sent();
      assertNothingSecretSent(sent);
      // Right after the one LDAP message comes a TLS handshake record (0x16,
      // version 0x03xx) — and nothing after the request is an LDAP message.
      const afterRequest = sent.subarray(2 + sent[1]!);
      expect(afterRequest[0]).toBe(0x16);
      expect(afterRequest[1]).toBe(0x03);
      expect(operations(sent)).toEqual([EXTENDED_REQUEST]);
    } finally {
      await proxy.close();
    }
  });
});
