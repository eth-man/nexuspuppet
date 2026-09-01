import { ldapConfigFromEnv } from '../src/ldap/config';
import { normalizeDn, resolveRoles } from '../src/ldap/role-mapping';
import { ldapConfigSchema } from '../src/ldap/config';

const BASE = {
  LDAP_URL: 'ldaps://directory.example.com:636',
  LDAP_SEARCH_BASE: 'ou=people,dc=example,dc=com',
};

describe('ldapConfigFromEnv', () => {
  it('reads a minimal configuration and applies defaults', () => {
    const config = ldapConfigFromEnv(BASE);
    expect(config.searchFilter).toContain('{{input}}');
    expect(config.tlsRejectUnauthorized).toBe(true);
    expect(config.attributes.email).toBe('mail');
  });

  it('rejects a non-LDAP scheme', () => {
    expect(() => ldapConfigFromEnv({ ...BASE, LDAP_URL: 'https://example.com' })).toThrow(
      /ldap:\/\/ or ldaps:\/\//,
    );
  });

  it('reports every configuration problem at once', () => {
    expect(() => ldapConfigFromEnv({})).toThrow(/url[\s\S]*searchBase|searchBase[\s\S]*url/);
  });

  /**
   * A bind DN with no password is an unauthenticated bind: many directories
   * accept it and grant nothing, so searches silently return no results and
   * every login fails with "no such user".
   */
  it('rejects a bind DN with no password', () => {
    expect(() =>
      ldapConfigFromEnv({ ...BASE, LDAP_BIND_DN: 'cn=svc,dc=example,dc=com' }),
    ).toThrow(/unauthenticated bind/i);
  });

  it('parses role mappings whose DNs contain equals signs', () => {
    const config = ldapConfigFromEnv({
      ...BASE,
      LDAP_ROLE_MAPPINGS:
        'cn=puppet-admins,ou=groups,dc=example,dc=com=ADMIN; cn=ops,ou=groups,dc=example,dc=com=OPERATOR',
    });

    expect(config.roleMappings).toEqual([
      { groupDn: 'cn=puppet-admins,ou=groups,dc=example,dc=com', role: 'ADMIN' },
      { groupDn: 'cn=ops,ou=groups,dc=example,dc=com', role: 'OPERATOR' },
    ]);
  });

  it('rejects a malformed role mapping rather than ignoring it', () => {
    expect(() => ldapConfigFromEnv({ ...BASE, LDAP_ROLE_MAPPINGS: 'cn=nope' })).toThrow();
  });

  it('accepts a role name this build does not know', () => {
    /*
     * CHANGED DELIBERATELY (ADR-0018 §5). A mapping may name a role the
     * deployment defined itself, so the parser can no longer decide that
     * "SUPERUSER" is wrong — it has no way to know what roles exist.
     *
     * A name with no matching role grants nothing at authorization time, which
     * is where the roles table can actually be consulted, and the settings
     * screen shows it as a broken mapping. Rejecting it here would make it
     * impossible to configure a custom role at all.
     */
    const config = ldapConfigFromEnv({ ...BASE, LDAP_ROLE_MAPPINGS: 'cn=x,dc=y=SUPERUSER' });

    expect(config.roleMappings).toEqual([{ groupDn: 'cn=x,dc=y', role: 'SUPERUSER' }]);
  });
});

describe('resolveRoles', () => {
  const config = ldapConfigSchema.parse({
    url: 'ldaps://d.example.com',
    searchBase: 'dc=example,dc=com',
    roleMappings: [
      { groupDn: 'cn=admins,dc=example,dc=com', role: 'ADMIN' },
      { groupDn: 'cn=ops,dc=example,dc=com', role: 'OPERATOR' },
      { groupDn: 'cn=all,dc=example,dc=com', role: 'VIEWER' },
    ],
  });

  it('returns null when no group matches, so the caller must refuse', () => {
    expect(resolveRoles(['cn=other,dc=example,dc=com'], config)).toBeNull();
  });

  it('returns null for a user with no groups at all', () => {
    expect(resolveRoles([], config)).toBeNull();
  });

  /** Order of memberOf is not specified by any RFC; the outcome must not depend on it. */
  it('is independent of the order the directory returns groups in', () => {
    const groups = ['cn=all,dc=example,dc=com', 'cn=admins,dc=example,dc=com'];
    expect(resolveRoles(groups, config)?.primary).toBe('ADMIN');
    expect(resolveRoles([...groups].reverse(), config)?.primary).toBe('ADMIN');
  });
});

describe('normalizeDn', () => {
  it('ignores case and spacing around separators', () => {
    expect(normalizeDn('CN=Ops, OU=Groups, DC=Example')).toBe(normalizeDn('cn=ops,ou=groups,dc=example'));
  });
});

/**
 * An on-prem directory is usually signed by an internal CA that is not in the
 * system trust store. Without a way to supply it, the only route to ldaps://
 * is disabling verification — which makes every password readable by the
 * network. These tests guard the alternative.
 */
describe('LDAP_CA_PATH', () => {
  const LDAPS = { ...BASE, LDAP_URL: 'ldaps://directory.example.com:636' };

  it('accepts a CA bundle that exists', () => {
    const config = ldapConfigFromEnv({ ...LDAPS, LDAP_CA_PATH: __filename });
    expect(config.caPath).toBe(__filename);
    expect(config.tlsRejectUnauthorized).toBe(true);
  });

  it('is optional — the system trust store remains the default', () => {
    expect(ldapConfigFromEnv(LDAPS).caPath).toBeUndefined();
  });

  /**
   * A missing CA file fails at boot rather than at somebody's first login,
   * where it would surface as an opaque TLS error long after the deploy.
   */
  it('refuses a path that does not exist', () => {
    expect(() =>
      ldapConfigFromEnv({ ...LDAPS, LDAP_CA_PATH: '/nonexistent/ca.pem' }),
    ).toThrow(/does not exist/);
  });

  /**
   * Supplying a CA while verification is off means someone believed the CA was
   * doing something. It is not — rejectUnauthorized false ignores it and
   * accepts any certificate. Silently honouring that would leave a deployment
   * feeling secured while it is not.
   */
  it('refuses a CA supplied alongside disabled verification', () => {
    expect(() =>
      ldapConfigFromEnv({
        ...LDAPS,
        LDAP_CA_PATH: __filename,
        LDAP_TLS_REJECT_UNAUTHORIZED: 'false',
      }),
    ).toThrow(/would be ignored/);
  });
});

describe('LDAP_DIALECT and nested groups', () => {
  const AD = { ...BASE, LDAP_DIALECT: 'ad' };

  it('defaults to the openldap dialect', () => {
    expect(ldapConfigFromEnv(BASE).dialect).toBe('openldap');
  });

  it('reads the dialect from the environment', () => {
    expect(ldapConfigFromEnv(AD).dialect).toBe('ad');
  });

  it('rejects a dialect nobody implements', () => {
    expect(() => ldapConfigFromEnv({ ...BASE, LDAP_DIALECT: 'novell' })).toThrow();
  });

  it('enables nested groups on AD', () => {
    expect(ldapConfigFromEnv({ ...AD, LDAP_NESTED_GROUPS: 'true' }).nestedGroups).toBe(true);
  });

  /**
   * LDAP_MATCHING_RULE_IN_CHAIN is an AD extension. OpenLDAP answers a filter
   * using it with an error, so honouring the request would turn every login
   * into a PROVIDER_ERROR — and degrading silently to direct membership would
   * quietly grant the wrong roles.
   */
  it('refuses nested groups on a dialect that cannot do them', () => {
    expect(() =>
      ldapConfigFromEnv({ ...BASE, LDAP_NESTED_GROUPS: 'true' }),
    ).toThrow(/does not support LDAP_MATCHING_RULE_IN_CHAIN/);
  });

  it('takes a separate group search base, since groups rarely live under the people OU', () => {
    const config = ldapConfigFromEnv({
      ...AD,
      LDAP_GROUP_SEARCH_BASE: 'ou=groups,dc=corp,dc=example,dc=com',
    });
    expect(config.groupSearchBase).toBe('ou=groups,dc=corp,dc=example,dc=com');
  });
});

describe('role mapping case handling', () => {
  const BASE_ENV = {
    LDAP_URL: 'ldaps://d.example.com',
    LDAP_SEARCH_BASE: 'dc=example,dc=com',
  };

  it('still folds a lowercase built-in, so existing configurations keep working', () => {
    // Dropping the fold outright would silently stop `=admin` matching ADMIN —
    // a role change nobody made.
    const config = ldapConfigFromEnv({
      ...BASE_ENV,
      LDAP_ROLE_MAPPINGS: 'cn=a,dc=x=admin;cn=b,dc=x=Operator',
    });

    expect(config.roleMappings.map((m) => m.role)).toEqual(['ADMIN', 'OPERATOR']);
  });

  it('preserves the case of a custom role name', () => {
    // Folding this would look up AUDITOR and match no row.
    const config = ldapConfigFromEnv({ ...BASE_ENV, LDAP_ROLE_MAPPINGS: 'cn=c,dc=x=auditor' });

    expect(config.roleMappings[0]?.role).toBe('auditor');
  });

  it('refuses a mapping whose group is not a DN', () => {
    // "cn=nope" is somebody forgetting the role. The enum used to catch it.
    expect(() => ldapConfigFromEnv({ ...BASE_ENV, LDAP_ROLE_MAPPINGS: 'cn=nope' })).toThrow(
      /expected <groupDn>=<ROLE>/,
    );
  });
});

/**
 * ADR-0018 §5. Two rules, chosen by what the matched mappings actually name.
 */
describe('resolveRoles: ordering for built-ins, union for custom', () => {
  const configWith = (mappings: Array<{ groupDn: string; role: string }>) =>
    ldapConfigSchema.parse({
      url: 'ldaps://d.example.com',
      searchBase: 'dc=example,dc=com',
      roleMappings: mappings,
    });

  const ADMINS = 'cn=admins,dc=x';
  const OPS = 'cn=ops,dc=x';
  const VIEWERS = 'cn=viewers,dc=x';
  const AUDITOR = 'cn=auditors,dc=x';
  const DEPLOYER = 'cn=deployers,dc=x';

  it('keeps highest-wins when every matched mapping names a built-in', () => {
    // THE compatibility guarantee. Somebody in both ops and viewers gets
    // OPERATOR today; an upgrade must not quietly make that OPERATOR ∪ VIEWER.
    // Nobody edited anything, so nothing may change.
    const config = configWith([
      { groupDn: OPS, role: 'OPERATOR' },
      { groupDn: VIEWERS, role: 'VIEWER' },
    ]);

    const resolved = resolveRoles([OPS, VIEWERS], config);

    expect(resolved).toEqual({ primary: 'OPERATOR', all: ['OPERATOR'] });
  });

  it('unions as soon as any matched mapping names a custom role', () => {
    // Ordering stops meaning anything once roles are not ranked: there is no
    // answer to "is auditor above or below deployer" that is not invented.
    const config = configWith([
      { groupDn: AUDITOR, role: 'auditor' },
      { groupDn: DEPLOYER, role: 'deployer' },
    ]);

    const resolved = resolveRoles([AUDITOR, DEPLOYER], config);

    expect(resolved?.all).toEqual(['auditor', 'deployer']);
  });

  it('prefers the highest built-in as primary when custom roles are also matched', () => {
    // Primary is display and storage only, so a wrong guess costs a label
    // rather than a permission — but it should still be the least surprising
    // one, and `all` carries everything regardless.
    // The CUSTOM role is listed first deliberately. With it second, "first
    // matched" and "highest built-in" give the same answer and the test proves
    // nothing — which is exactly what a mutation run showed.
    const config = configWith([
      { groupDn: AUDITOR, role: 'auditor' },
      { groupDn: ADMINS, role: 'ADMIN' },
    ]);

    const resolved = resolveRoles([ADMINS, AUDITOR], config);

    expect(resolved?.primary).toBe('ADMIN');
    expect(resolved?.all).toEqual(expect.arrayContaining(['ADMIN', 'auditor']));
  });

  it('falls back to mapping order for primary when only custom roles match', () => {
    const config = configWith([
      { groupDn: DEPLOYER, role: 'deployer' },
      { groupDn: AUDITOR, role: 'auditor' },
    ]);

    expect(resolveRoles([AUDITOR, DEPLOYER], config)?.primary).toBe('deployer');
  });

  it('is independent of the order the directory returns groups in', () => {
    const config = configWith([
      { groupDn: AUDITOR, role: 'auditor' },
      { groupDn: DEPLOYER, role: 'deployer' },
    ]);

    const forward = resolveRoles([AUDITOR, DEPLOYER], config);
    const reverse = resolveRoles([DEPLOYER, AUDITOR], config);

    expect(forward).toEqual(reverse);
  });

  it('collapses a single matched role to no union at all', () => {
    // The common case must carry nothing extra, so a principal reads exactly
    // as it did before this change.
    const config = configWith([{ groupDn: OPS, role: 'OPERATOR' }]);

    expect(resolveRoles([OPS], config)).toEqual({ primary: 'OPERATOR', all: ['OPERATOR'] });
  });

  it('still refuses somebody in no mapped group', () => {
    const config = configWith([{ groupDn: OPS, role: 'OPERATOR' }]);

    expect(resolveRoles(['cn=nobody,dc=x'], config)).toBeNull();
  });
});
