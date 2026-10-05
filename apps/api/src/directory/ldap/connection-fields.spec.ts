import {
  LDAP_DEFAULT_PORTS,
  ldapHostProblem,
  ldapSettingsSchema,
  ldapStoredSettingsSchema,
  ldapUrlOf,
  parseLegacyLdapUrl,
  upgradeLegacyLdapSettings,
} from '@nexuspuppet/contracts';
import { ldapConfigFromEnv, ldapConfigSchema } from './config';

/**
 * The connection fields an operator recognises (ADR-0030): host, port,
 * protocol and bind type in place of one URL — and every configuration saved
 * or set before them still meaning exactly what it meant.
 */

const BASE = { searchBase: 'ou=people,dc=example,dc=com' };

describe('host, port and protocol ⇄ URL', () => {
  it.each([
    ['ldaps://dc01.example.com:636', { host: 'dc01.example.com', port: 636, protocol: 'ldaps' }],
    ['ldaps://dc01.example.com', { host: 'dc01.example.com', port: 636, protocol: 'ldaps' }],
    ['ldaps://dc01.example.com:3269', { host: 'dc01.example.com', port: 3269, protocol: 'ldaps' }],
    ['ldap://dc01.example.com', { host: 'dc01.example.com', port: 389, protocol: 'ldap' }],
    ['ldap://127.0.0.1:3890', { host: '127.0.0.1', port: 3890, protocol: 'ldap' }],
    ['LDAPS://DC01.example.com:636/', { host: 'DC01.example.com', port: 636, protocol: 'ldaps' }],
    ['ldaps://[2001:db8::10]:636', { host: '2001:db8::10', port: 636, protocol: 'ldaps' }],
  ])('reads %s', (url, expected) => {
    expect(parseLegacyLdapUrl(url)).toEqual(expected);
  });

  it.each([
    'https://dc01.example.com',
    'ldaps://',
    'ldaps://user@dc01.example.com',
    'ldaps://dc01.example.com/dc=example,dc=com',
    'ldaps://dc01.example.com:0',
    'ldaps://dc01.example.com:70000',
    'ldaps://dc01.example.com:63x',
    'dc01.example.com',
  ])('refuses %s rather than half-reading it', (url) => {
    expect(parseLegacyLdapUrl(url)).toBeNull();
  });

  it.each([
    [
      { host: 'dc01.example.com', port: 636, protocol: 'ldaps' as const },
      'ldaps://dc01.example.com:636',
    ],
    // STARTTLS starts unencrypted, on ldap://, and upgrades before anything else.
    [
      { host: 'dc01.example.com', port: 389, protocol: 'starttls' as const },
      'ldap://dc01.example.com:389',
    ],
    [
      { host: 'dc01.example.com', port: 389, protocol: 'ldap' as const },
      'ldap://dc01.example.com:389',
    ],
    [{ host: '2001:db8::10', port: 636, protocol: 'ldaps' as const }, 'ldaps://[2001:db8::10]:636'],
  ])('writes %j as %s', (target, url) => {
    expect(ldapUrlOf(target)).toBe(url);
  });

  it('round-trips', () => {
    for (const url of [
      'ldaps://dc01.example.com:636',
      'ldap://10.0.0.5:389',
      'ldaps://[::1]:6360',
    ]) {
      expect(ldapUrlOf(parseLegacyLdapUrl(url)!)).toBe(url);
    }
  });

  it('defaults the port per protocol', () => {
    expect(LDAP_DEFAULT_PORTS).toEqual({ ldaps: 636, starttls: 389, ldap: 389 });
  });
});

describe('the Server name or IP field', () => {
  it.each(['dc01.corp.example', 'dc01', '10.0.0.5', '2001:db8::10', 'DC01.CORP.EXAMPLE.'])(
    'accepts %s',
    (host) => {
      expect(ldapHostProblem(host)).toBeNull();
    },
  );

  it('says where the pasted scheme belongs', () => {
    expect(ldapHostProblem('ldaps://dc01.example.com')).toMatch(/Protocol/);
  });

  it('says where the pasted port belongs', () => {
    expect(ldapHostProblem('dc01.example.com:636')).toMatch(/Port field/);
  });

  it.each(['dc01 example', 'dc01/x', 'user@dc01', '[::1]', '-dc01', 'dc_01.example'])(
    'refuses %s',
    (host) => {
      expect(ldapHostProblem(host)).not.toBeNull();
    },
  );
});

describe('the console schema (PUT and Test)', () => {
  const body = {
    host: 'dc01.example.com',
    protocol: 'ldaps',
    bindType: 'regular',
    bindDn: 'cn=svc,dc=example,dc=com',
    bindPassword: 'secret',
    ...BASE,
  };

  it('accepts the new fields and fills the port from the protocol', () => {
    expect(ldapSettingsSchema.parse(body)).toMatchObject({ port: 636, protocol: 'ldaps' });
    expect(ldapSettingsSchema.parse({ ...body, protocol: 'starttls' })).toMatchObject({
      port: 389,
    });
  });

  it('keeps a port the operator typed', () => {
    expect(ldapSettingsSchema.parse({ ...body, port: 3269 })).toMatchObject({ port: 3269 });
  });

  it('refuses unencrypted LDAP, and says what to choose instead', () => {
    const result = ldapSettingsSchema.safeParse({ ...body, protocol: 'ldap' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/LDAPS \(port 636\) or STARTTLS/);
  });

  it('refuses an old ldap:// URL for the same reason', () => {
    const result = ldapSettingsSchema.safeParse({ url: 'ldap://dc01.example.com', ...BASE });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['protocol']);
  });

  it('still accepts an old ldaps:// URL from an API client, as host, port and protocol', () => {
    expect(
      ldapSettingsSchema.parse({ url: 'ldaps://dc01.example.com:3269', ...BASE }),
    ).toMatchObject({
      host: 'dc01.example.com',
      port: 3269,
      protocol: 'ldaps',
      bindType: 'anonymous',
    });
  });

  it('needs a User DN for Regular', () => {
    const { bindDn: _drop, ...noDn } = body;
    void _drop;
    expect(ldapSettingsSchema.safeParse(noDn).error?.issues[0]?.path).toEqual(['bindDn']);
  });

  it('needs a pattern for Simple, and drops the service account it does not use', () => {
    expect(
      ldapSettingsSchema.safeParse({ ...body, bindType: 'simple' }).error?.issues[0]?.path,
    ).toEqual(['userDnPattern']);

    const simple = ldapSettingsSchema.parse({
      ...body,
      bindType: 'simple',
      userDnPattern: '{username}@corp.example',
    });
    expect(simple).not.toHaveProperty('bindDn');
    expect(simple).not.toHaveProperty('bindPassword');
  });

  it('drops the service account and the pattern for Anonymous', () => {
    const anonymous = ldapSettingsSchema.parse({
      ...body,
      bindType: 'anonymous',
      userDnPattern: '{username}@corp.example',
    });
    expect(anonymous).not.toHaveProperty('bindDn');
    expect(anonymous).not.toHaveProperty('bindPassword');
    expect(anonymous).not.toHaveProperty('userDnPattern');
  });

  it('refuses a bad pattern with a message that shows a good one', () => {
    const result = ldapSettingsSchema.safeParse({
      ...body,
      bindType: 'simple',
      userDnPattern: 'CORP\\{username}',
    });
    expect(JSON.stringify(result.error?.issues)).toMatch(/\{username\}@corp\.example/);
  });
});

/**
 * Rows saved by v1.11/v1.12 hold `url`, `dialect` and an optional `bindDn`.
 * They are read for ever, without being saved again.
 */
describe('a stored row from before ADR-0030', () => {
  const legacy = {
    url: 'ldaps://dc01.example.com:636',
    dialect: 'ad',
    bindDn: 'cn=svc,dc=example,dc=com',
    searchBase: 'ou=people,dc=example,dc=com',
    nestedGroups: false,
    roleMappings: [{ groupDn: 'cn=ops,dc=example,dc=com', role: 'OPERATOR' }],
    timeoutMs: 10_000,
    tlsRejectUnauthorized: true,
  };

  it('opens in the form as host, port, protocol, Regular, and the dialect it chose', () => {
    const upgraded = upgradeLegacyLdapSettings(legacy, { passwordHeld: true });
    expect(ldapStoredSettingsSchema.parse(upgraded)).toMatchObject({
      host: 'dc01.example.com',
      port: 636,
      protocol: 'ldaps',
      bindType: 'regular',
      bindDn: 'cn=svc,dc=example,dc=com',
      detectedDialect: 'ad',
    });
  });

  it('runs with the same directory, account and dialect it always did', () => {
    const config = ldapConfigSchema.parse({ ...legacy, bindPassword: 'svc-secret' });
    expect(config).toMatchObject({
      url: 'ldaps://dc01.example.com:636',
      protocol: 'ldaps',
      bindType: 'regular',
      bindDn: 'cn=svc,dc=example,dc=com',
      bindPassword: 'svc-secret',
      dialect: 'ad',
      identifierLabel: 'Username',
    });
    // The AD filter it always had, because the dialect is what it chose.
    expect(config.searchFilter).toContain('sAMAccountName');
  });

  /**
   * The old client bound only when it had BOTH a DN and a password, so a row
   * with a DN and no password searched anonymously. It still does.
   */
  it('reads a bind DN with no stored password as the anonymous search it always was', () => {
    const config = ldapConfigSchema.parse(legacy);
    expect(config.bindType).toBe('anonymous');
    expect(config).not.toHaveProperty('bindDn');

    const view = ldapStoredSettingsSchema.parse(
      upgradeLegacyLdapSettings(legacy, { passwordHeld: false }),
    );
    expect(view.bindType).toBe('anonymous');
  });

  it('keeps an unencrypted ldap:// row working exactly as before', () => {
    const config = ldapConfigSchema.parse({
      ...legacy,
      url: 'ldap://dc01.example.com',
      bindPassword: 'svc-secret',
    });
    expect(config).toMatchObject({
      url: 'ldap://dc01.example.com:389',
      protocol: 'ldap',
      port: 389,
    });
  });

  it('shows an unencrypted row as legacy, and will not save it unchanged', () => {
    const upgraded = upgradeLegacyLdapSettings({ ...legacy, url: 'ldap://dc01.example.com' });
    expect(ldapStoredSettingsSchema.parse(upgraded)).toMatchObject({ protocol: 'ldap' });
    expect(ldapSettingsSchema.safeParse(upgraded).success).toBe(false);
  });

  it('defaults a row with no dialect to OpenLDAP, as it always did', () => {
    const { dialect: _drop, ...noDialect } = legacy;
    void _drop;
    expect(ldapConfigSchema.parse(noDialect).dialect).toBe('openldap');
  });

  it('lets host, port and protocol win over a stale url when both are present', () => {
    expect(
      ldapConfigSchema.parse({
        ...legacy,
        host: 'new.example.com',
        port: 389,
        protocol: 'starttls',
        bindPassword: 'x',
      }).url,
    ).toBe('ldap://new.example.com:389');
  });
});

describe('a configuration saved after ADR-0030', () => {
  const saved = {
    host: 'dc01.example.com',
    port: 389,
    protocol: 'starttls',
    bindType: 'simple',
    userDnPattern: '{username}@corp.example',
    detectedDialect: 'ad',
    ...BASE,
  };

  it('uses the detected dialect', () => {
    const config = ldapConfigSchema.parse(saved);
    expect(config.dialect).toBe('ad');
    expect(config.url).toBe('ldap://dc01.example.com:389');
  });

  it('labels the login field Email for Simple bind, whatever the directory', () => {
    // People type the account's address; the pattern takes {email} or the
    // {username} before its @ from it.
    for (const [dialect, pattern] of [
      ['openldap', 'uid={username},dc=x'],
      ['ad', '{email}'],
    ]) {
      expect(
        ldapConfigSchema.parse({ ...saved, detectedDialect: dialect, userDnPattern: pattern })
          .identifierLabel,
      ).toBe('Email');
    }
  });

  it('accepts {email}, the pattern AD needs, which a bare {username} used to be refused for', () => {
    expect(ldapSettingsSchema.parse({ ...saved, userDnPattern: '{email}' })).toMatchObject({
      userDnPattern: '{email}',
    });
    expect(ldapSettingsSchema.safeParse({ ...saved, userDnPattern: '{username}' }).success).toBe(
      false,
    );
  });

  it('treats an undetected directory as OpenLDAP', () => {
    const { detectedDialect: _drop, ...undetected } = saved;
    void _drop;
    expect(ldapConfigSchema.parse(undetected).dialect).toBe('openldap');
  });

  it('refuses a Regular bind with no password, instead of searching anonymously', () => {
    const result = ldapConfigSchema.safeParse({
      ...saved,
      bindType: 'regular',
      bindDn: 'cn=svc,dc=example,dc=com',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('bindPassword');
  });
});

/** The environment keeps LDAP_URL, and gains parity with the console's fields. */
describe('ldapConfigFromEnv with the ADR-0030 variables', () => {
  const ENV = { LDAP_URL: 'ldaps://dc01.example.com:636', LDAP_SEARCH_BASE: BASE.searchBase };

  it('reads LDAP_URL exactly as before', () => {
    expect(ldapConfigFromEnv(ENV)).toMatchObject({
      host: 'dc01.example.com',
      port: 636,
      protocol: 'ldaps',
      bindType: 'anonymous',
      url: 'ldaps://dc01.example.com:636',
    });
  });

  it('upgrades an ldap:// URL with LDAP_STARTTLS=true', () => {
    expect(
      ldapConfigFromEnv({ ...ENV, LDAP_URL: 'ldap://dc01.example.com', LDAP_STARTTLS: 'true' }),
    ).toMatchObject({ protocol: 'starttls', port: 389, url: 'ldap://dc01.example.com:389' });
  });

  it('keeps an ldap:// URL without LDAP_STARTTLS unencrypted, as it always was', () => {
    expect(ldapConfigFromEnv({ ...ENV, LDAP_URL: 'ldap://dc01.example.com' }).protocol).toBe(
      'ldap',
    );
    expect(
      ldapConfigFromEnv({ ...ENV, LDAP_URL: 'ldap://dc01.example.com', LDAP_STARTTLS: 'false' })
        .protocol,
    ).toBe('ldap');
  });

  it('infers Regular from a bind DN, exactly as before', () => {
    expect(
      ldapConfigFromEnv({
        ...ENV,
        LDAP_BIND_DN: 'cn=svc,dc=example,dc=com',
        LDAP_BIND_PASSWORD: 'secret',
      }).bindType,
    ).toBe('regular');
  });

  it('reads Simple bind with its pattern', () => {
    expect(
      ldapConfigFromEnv({
        ...ENV,
        LDAP_BIND_TYPE: 'simple',
        LDAP_USER_DN_PATTERN: '{username}@corp.example',
      }),
    ).toMatchObject({ bindType: 'simple', userDnPattern: '{username}@corp.example' });
  });

  /** Malformed environment still refuses boot (IntegrationConfigError upstream). */
  it.each([
    ['STARTTLS over ldaps://', { LDAP_STARTTLS: 'true' }, /already TLS/],
    ['a non-boolean LDAP_STARTTLS', { LDAP_STARTTLS: 'yes' }, /true or false/],
    ['an unknown bind type', { LDAP_BIND_TYPE: 'kerberos' }, /regular, simple, anonymous/],
    ['Simple with no pattern', { LDAP_BIND_TYPE: 'simple' }, /userDnPattern/],
    [
      'Simple with a service account',
      {
        LDAP_BIND_TYPE: 'simple',
        LDAP_USER_DN_PATTERN: '{username}@corp.example',
        LDAP_BIND_DN: 'cn=svc',
        LDAP_BIND_PASSWORD: 'x',
      },
      /no service account/,
    ],
    [
      'Anonymous with a service account',
      { LDAP_BIND_TYPE: 'anonymous', LDAP_BIND_DN: 'cn=svc', LDAP_BIND_PASSWORD: 'x' },
      /ignore it/,
    ],
    ['Regular with no bind DN', { LDAP_BIND_TYPE: 'regular' }, /User DN/],
    [
      'a pattern without Simple',
      { LDAP_USER_DN_PATTERN: '{username}@corp.example' },
      /only used with/,
    ],
    ['a bad pattern', { LDAP_BIND_TYPE: 'simple', LDAP_USER_DN_PATTERN: '{username}' }, /UPN/],
    ['a URL with a path', { LDAP_URL: 'ldaps://dc01.example.com/dc=example' }, /LDAP_URL must be/],
  ])('refuses %s', (_why, extra, message) => {
    expect(() => ldapConfigFromEnv({ ...ENV, ...extra })).toThrow(message);
  });

  it('never reads inline PEM from the environment', () => {
    expect(ldapConfigFromEnv({ ...ENV, LDAP_CA_PEM: 'x' } as NodeJS.ProcessEnv)).not.toHaveProperty(
      'caPem',
    );
  });
});
