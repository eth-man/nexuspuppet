import { ldapConfigSchema } from '../src/ldap/config';

/**
 * Referral handling — the security answer to LDAP_OPT_REFERRALS.
 *
 * Active Directory answers a search for an object in another domain of the
 * forest with a REFERRAL: "ask that server instead". Chasing one means opening
 * a connection to a host the directory nominated and binding there, with the
 * service account's credentials or the user's password. The target is chosen by
 * the server, not by configuration, so a compromised or merely misconfigured DC
 * can name a host of its choosing and be handed credentials.
 *
 * `ldapts` does not follow them. These tests pin that as a property of this
 * package rather than an accident of the library, and pin the logging — because
 * ignoring a referral SILENTLY is its own failure mode: a user in a referred
 * domain then looks simply absent.
 */

const config = ldapConfigSchema.parse({
  url: 'ldap://dc.corp.example.com:389',
  bindDn: 'cn=svc,dc=corp,dc=example,dc=com',
  bindPassword: 'service-secret',
  searchBase: 'ou=people,dc=corp,dc=example,dc=com',
  dialect: 'ad',
});

/** Records every host a client was constructed for, so we can prove none was chased. */
function mockLdapts(searchReferences: string[]): { urls: string[]; binds: string[] } {
  const urls: string[] = [];
  const binds: string[] = [];

  jest.doMock('ldapts', () => ({
    Client: class {
      constructor(options: { url: string }) {
        urls.push(options.url);
      }
      async bind(dn: string): Promise<void> {
        binds.push(dn);
      }
      async search(): Promise<{
        searchEntries: Array<Record<string, unknown>>;
        searchReferences: string[];
      }> {
        return { searchEntries: [], searchReferences };
      }
      async unbind(): Promise<void> {}
    },
  }));

  return { urls, binds };
}

describe('LDAP referrals', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('ldapts');
    jest.resetModules();
  });

  it('does not connect to a referred host', async () => {
    const referral = 'ldap://evil.attacker.example.com/dc=corp,dc=example,dc=com';
    const { urls } = mockLdapts([referral]);

    const { LdaptsDirectory } = await import('../src/ldap/ldap-client');
    await new LdaptsDirectory(config, { warn: () => {} }).findEntry('(sAMAccountName=jdoe)');

    // Only the configured directory. Never the host the referral named.
    expect(urls).toEqual([config.url]);
    expect(urls.some((u) => u.includes('attacker'))).toBe(false);
  });

  it('does not send the service account credentials anywhere but the configured host', async () => {
    const { urls, binds } = mockLdapts([
      'ldap://other-domain.example.com/dc=other,dc=example,dc=com',
    ]);

    const { LdaptsDirectory } = await import('../src/ldap/ldap-client');
    await new LdaptsDirectory(config, { warn: () => {} }).findEntry('(sAMAccountName=jdoe)');

    // One bind, against one host: the one in LDAP_URL.
    expect(binds).toEqual(['cn=svc,dc=corp,dc=example,dc=com']);
    expect(urls).toHaveLength(1);
  });

  /**
   * The other half. Refusing to chase is correct; doing it silently is not,
   * because the operator's symptom is "this user does not exist" for someone
   * who plainly does.
   */
  it('warns that results may be incomplete, naming the referral', async () => {
    const referral = 'ldap://emea.corp.example.com/dc=emea,dc=corp,dc=example,dc=com';
    mockLdapts([referral]);
    const warnings: string[] = [];

    const { LdaptsDirectory } = await import('../src/ldap/ldap-client');
    await new LdaptsDirectory(config, { warn: (m: string) => warnings.push(m) }).findEntry(
      '(sAMAccountName=jdoe)',
    );

    const message = warnings.join(' ');
    expect(message).toContain('NOT followed');
    expect(message).toContain(referral);
    // The actionable fix for a forest, not just a complaint.
    expect(message).toMatch(/Global Catalog/);
  });

  it('says nothing when the directory returns no referrals', async () => {
    mockLdapts([]);
    const warnings: string[] = [];

    const { LdaptsDirectory } = await import('../src/ldap/ldap-client');
    await new LdaptsDirectory(config, { warn: (m: string) => warnings.push(m) }).findEntry(
      '(sAMAccountName=jdoe)',
    );

    expect(warnings).toEqual([]);
  });

  it('reports referrals from the nested group search too', async () => {
    mockLdapts(['ldap://emea.corp.example.com/dc=emea']);
    const warnings: string[] = [];

    const { LdaptsDirectory } = await import('../src/ldap/ldap-client');
    await new LdaptsDirectory(config, { warn: (m: string) => warnings.push(m) })
      .findGroupsContaining('cn=Jane Doe,ou=people,dc=corp,dc=example,dc=com');

    expect(warnings.join(' ')).toContain('nested group search');
  });
});
