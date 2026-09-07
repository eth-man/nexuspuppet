import { join } from 'node:path';
import { ldapConfigSchema, type LdapConfig } from '../../src/ldap/config';
import {
  LdapAuthProvider,
  type LdapIdentityStore,
  type StoredIdentity,
} from '../../src/ldap/ldap-auth.provider';
import { LdaptsDirectory, LdapUnavailableError } from '../../src/ldap/ldap-client';

/**
 * The LDAP provider against a REAL OpenLDAP, over a real socket.
 *
 * Everything else in this package is tested against a fake directory, which
 * proves the decision logic but cannot prove the adapter: whether the search
 * filter is syntactically valid to slapd, whether `memberOf` comes back as a
 * string or an array, whether a rejected bind surfaces as LDAP result 49 or as
 * a thrown transport error. Those are exactly the assumptions a fake bakes in.
 *
 *   sudo ./test/ldap/up.sh
 *   npm run test:ldap
 *
 * Excluded from the default `npm test` because it needs Docker.
 */

const LDAP_URL = process.env['TEST_LDAP_URL'] ?? 'ldap://127.0.0.1:3890';
const BASE_DN = 'dc=nexuspuppet,dc=test';

jest.setTimeout(30_000);

function config(overrides: Partial<LdapConfig> = {}): LdapConfig {
  return ldapConfigSchema.parse({
    url: LDAP_URL,
    bindDn: `cn=svc-nexuspuppet,${BASE_DN}`,
    bindPassword: 'svc-password',
    searchBase: `ou=people,${BASE_DN}`,
    searchFilter: '(&(objectClass=inetOrgPerson)(mail={{input}}))',
    roleMappings: [
      { groupDn: `cn=ops,ou=groups,${BASE_DN}`, role: 'OPERATOR' },
      { groupDn: `cn=viewers,ou=groups,${BASE_DN}`, role: 'VIEWER' },
      { groupDn: `cn=puppet-admins,ou=groups,${BASE_DN}`, role: 'ADMIN' },
    ],
    ...overrides,
  });
}

/** In-memory stand-in for core's user directory. Persistence is core's job. */
function identityStore(seed: Record<string, StoredIdentity>): LdapIdentityStore & {
  recorded: Array<{ userId: string; role: string; displayName: string }>;
} {
  const recorded: Array<{ userId: string; role: string; displayName: string }> = [];
  return {
    recorded,
    findByEmail: async (email) => seed[email.toLowerCase()] ?? null,
    findById: async (id) => Object.values(seed).find((u) => u.userId === id) ?? null,
    recordLogin: async (userId, update) => {
      recorded.push({ userId, ...update });
    },
  };
}

const PEOPLE: Record<string, StoredIdentity> = {
  'alice@nexuspuppet.test': {
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'alice@nexuspuppet.test',
    displayName: 'Alice (stored)',
    role: 'VIEWER',
    isActive: true,
    authSource: 'ldap',
  },
  'bob@nexuspuppet.test': {
    userId: '22222222-2222-4222-8222-222222222222',
    email: 'bob@nexuspuppet.test',
    displayName: 'Bob (stored)',
    role: 'VIEWER',
    isActive: true,
    authSource: 'ldap',
  },
  'carol@nexuspuppet.test': {
    userId: '33333333-3333-4333-8333-333333333333',
    email: 'carol@nexuspuppet.test',
    displayName: 'Carol (stored)',
    role: 'VIEWER',
    isActive: true,
    authSource: 'ldap',
  },
  'dave@nexuspuppet.test': {
    userId: '44444444-4444-4444-8444-444444444444',
    email: 'dave@nexuspuppet.test',
    displayName: 'Dave (stored)',
    role: 'VIEWER',
    isActive: true,
    authSource: 'ldap',
  },
};

const silent = { log: (): void => {}, warn: (): void => {}, error: (): void => {} };

function provider(
  parts: { config?: LdapConfig; identities?: LdapIdentityStore } = {},
): LdapAuthProvider {
  const cfg = parts.config ?? config();
  return new LdapAuthProvider({
    config: cfg,
    directory: new LdaptsDirectory(cfg),
    identities: parts.identities ?? identityStore(PEOPLE),
    logger: silent,
  });
}

describe('LdapAuthProvider against a real OpenLDAP', () => {
  it('authenticates a real user by binding as them', async () => {
    const result = await provider().authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe(PEOPLE['alice@nexuspuppet.test']!.userId);
    expect(result.principal.authSource).toBe('ldap');
  });

  /**
   * The assumption a fake cannot test: memberOf arrives from slapd as a bare
   * string for one group and an array for several. If the adapter mishandled
   * either, roles would silently resolve to null and every login would be
   * refused.
   */
  it('maps a single group to a role', async () => {
    const result = await provider().authenticate({
      email: 'bob@nexuspuppet.test',
      password: 'bob-password',
    });
    expect(result.ok && result.principal.role).toBe('VIEWER');
  });

  it('maps multiple groups to the HIGHEST role', async () => {
    // dave is in both ops (OPERATOR) and puppet-admins (ADMIN).
    const result = await provider().authenticate({
      email: 'dave@nexuspuppet.test',
      password: 'dave-password',
    });
    expect(result.ok && result.principal.role).toBe('ADMIN');
  });

  it('takes the display name from the directory, not the stored row', async () => {
    const result = await provider().authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });
    expect(result.ok && result.principal.displayName).toBe('Alice Ng');
  });

  it('falls back to the stored name when the entry has no displayName', async () => {
    // carol has no displayName attribute, but is in no mapped group, so use a
    // config that maps her group to prove the fallback rather than the refusal.
    const withContractors = config({
      roleMappings: [{ groupDn: `cn=contractors,ou=groups,${BASE_DN}`, role: 'VIEWER' }],
    });
    const result = await provider({ config: withContractors }).authenticate({
      email: 'carol@nexuspuppet.test',
      password: 'carol-password',
    });

    expect(result.ok && result.principal.displayName).toBe('Carol (stored)');
  });

  it('rejects a wrong password', async () => {
    const result = await provider().authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'not-alices-password',
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('gives an unknown account the same answer as a wrong password', async () => {
    const unknown = await provider().authenticate({
      email: 'nobody@nexuspuppet.test',
      password: 'whatever',
    });
    expect(unknown).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  /**
   * The bypass this module exists to prevent, proven against a directory that
   * really does accept an unauthenticated bind. Without the guard in
   * authenticate(), slapd would answer this bind with success.
   */
  it('rejects an empty password that the directory itself would accept', async () => {
    const result = await provider().authenticate({
      email: 'alice@nexuspuppet.test',
      password: '',
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });

    // Prove the premise: binding as alice with an empty password really does
    // succeed at the protocol level, so the guard is load-bearing.
    const raw = new LdaptsDirectory(config());
    await expect(
      raw.verifyCredentials(`uid=alice,ou=people,${BASE_DN}`, ''),
    ).resolves.toBe(true);
  });

  it('refuses a user who is in no mapped group', async () => {
    // carol is only in cn=contractors, which the default config does not map.
    const result = await provider().authenticate({
      email: 'carol@nexuspuppet.test',
      password: 'carol-password',
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('refuses someone the directory knows but the application does not', async () => {
    const result = await provider({ identities: identityStore({}) }).authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('reports a deactivated account after verifying the password', async () => {
    const disabled = identityStore({
      'alice@nexuspuppet.test': { ...PEOPLE['alice@nexuspuppet.test']!, isActive: false },
    });
    const result = await provider({ identities: disabled }).authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });
    expect(result).toEqual({ ok: false, reason: 'ACCOUNT_DISABLED' });
  });

  it('caches the directory-derived role for token refresh', async () => {
    const store = identityStore(PEOPLE);
    await provider({ identities: store }).authenticate({
      email: 'dave@nexuspuppet.test',
      password: 'dave-password',
    });

    expect(store.recorded).toEqual([
      {
        userId: PEOPLE['dave@nexuspuppet.test']!.userId,
        role: 'ADMIN',
        displayName: 'Dave Okafor',
      },
    ]);
  });

  /**
   * Filter injection, against a server that would really execute the filter.
   * Unescaped, `*` makes the filter match every person in the subtree and the
   * first entry returned would be bound against.
   */
  it('treats a wildcard in the identifier as literal text', async () => {
    const result = await provider().authenticate({
      email: '*@nexuspuppet.test',
      password: 'alice-password',
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('survives an identifier containing filter syntax', async () => {
    // Unescaped this is a syntactically invalid filter, which slapd rejects
    // with a protocol error — surfacing as PROVIDER_ERROR rather than a clean
    // refusal, and telling an attacker their input reached the parser.
    const result = await provider().authenticate({
      email: 'alice@nexuspuppet.test)(uid=*',
      password: 'alice-password',
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  describe('failure modes', () => {
    it('reports an unreachable directory as PROVIDER_ERROR, never as bad credentials', async () => {
      const offline = config({ url: 'ldap://127.0.0.1:3891', timeoutMs: 2000 });
      const result = await provider({ config: offline }).authenticate({
        email: 'alice@nexuspuppet.test',
        password: 'alice-password',
      });
      expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    });

    it('reports a wrong service-account password as PROVIDER_ERROR', async () => {
      // The search bind fails. This is a deployment fault, not an end-user one,
      // and must not read to every user as "your password is wrong".
      const badSvc = config({ bindPassword: 'wrong-service-password' });
      const result = await provider({ config: badSvc }).authenticate({
        email: 'alice@nexuspuppet.test',
        password: 'alice-password',
      });
      expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    });

    it('surfaces transport failure as LdapUnavailableError from the adapter', async () => {
      const offline = new LdaptsDirectory(config({ url: 'ldap://127.0.0.1:3891', timeoutMs: 2000 }));
      await expect(offline.findEntry('(mail=alice@nexuspuppet.test)')).rejects.toBeInstanceOf(
        LdapUnavailableError,
      );
    });
  });

  describe('resolve', () => {
    it('re-resolves a principal without touching the directory', async () => {
      const principal = await provider().resolve(PEOPLE['alice@nexuspuppet.test']!.userId);
      expect(principal?.email).toBe('alice@nexuspuppet.test');
      expect(principal?.authSource).toBe('ldap');
    });

    it('ends the session for a deactivated account', async () => {
      const disabled = identityStore({
        'alice@nexuspuppet.test': { ...PEOPLE['alice@nexuspuppet.test']!, isActive: false },
      });
      const p = provider({ identities: disabled });
      expect(await p.resolve(PEOPLE['alice@nexuspuppet.test']!.userId)).toBeNull();
    });
  });
});

/**
 * ldaps:// against a certificate signed by an internal CA — the case that
 * matters on-prem, and the one that previously had no answer but "disable
 * verification".
 *
 * The container generates its own CA, so its certificate is not in any system
 * trust store. That makes it a faithful stand-in for a corporate directory.
 */
describe('LdapAuthProvider over ldaps:// with an internal CA', () => {
  const CA_PATH = join(__dirname, 'certs', 'ca.crt');
  const LDAPS_URL = process.env['TEST_LDAPS_URL'] ?? 'ldaps://localhost:6360';

  // `localhost`, not 127.0.0.1: the container's certificate carries a hostname,
  // and verifying against an IP would fail on the subject name rather than on
  // the trust chain — proving nothing about the CA.
  const verified = (): LdapConfig =>
    config({ url: LDAPS_URL, caPath: CA_PATH, tlsRejectUnauthorized: true });

  it('authenticates with certificate verification ENFORCED', async () => {
    const result = await provider({ config: verified() }).authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.principal.role).toBe('OPERATOR');
  });

  /**
   * The test that gives the one above its meaning. Without the CA the same
   * connection must FAIL — otherwise verification is not actually happening and
   * the passing test above would prove nothing.
   */
  it('refuses the same connection when the CA is not supplied', async () => {
    const withoutCa = config({ url: LDAPS_URL, tlsRejectUnauthorized: true });
    const result = await provider({ config: withoutCa }).authenticate({
      email: 'alice@nexuspuppet.test',
      password: 'alice-password',
    });

    // A TLS failure is a provider error, never a credential error: the password
    // was never in question.
    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
  });

  it('reports the CA bundle it is trusting', () => {
    const details = provider({ config: verified() }).describe().details;
    expect(details).toContainEqual({
      label: 'TLS verification',
      value: `enforced (CA bundle ${CA_PATH})`,
    });
  });
});
