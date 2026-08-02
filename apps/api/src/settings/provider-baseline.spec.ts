import { Logger } from '@nestjs/common';
import type { IAuthProvider } from '@nexuspuppet/contracts';
import type { AuthProviderResolver } from '../auth/auth-provider.resolver';
import { ldapEnvBaseline } from './provider-baseline';

/** The smallest configuration the settings schema accepts. */
const MINIMAL = { url: 'ldaps://dc.example.test:636', searchBase: 'dc=example,dc=test' };

function resolverWith(provider: Partial<IAuthProvider> | null): AuthProviderResolver {
  return {
    forSource: (source: string) => (source === 'ldap' ? provider : null),
  } as unknown as AuthProviderResolver;
}

function reporting(configuration: unknown): AuthProviderResolver {
  return resolverWith({ source: 'ldap', currentConfiguration: () => configuration });
}

describe('ldapEnvBaseline', () => {
  beforeEach(() => {
    // The warnings are deliberate behaviour, but they are not what is under test
    // and an operator reading a test run should not think something broke.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the configuration the provider reports', () => {
    const baseline = ldapEnvBaseline(
      reporting({ ...MINIMAL, bindDn: 'cn=svc,dc=example,dc=test', dialect: 'ad' }),
    );

    expect(baseline).toMatchObject({
      url: 'ldaps://dc.example.test:636',
      searchBase: 'dc=example,dc=test',
      bindDn: 'cn=svc,dc=example,dc=test',
      dialect: 'ad',
    });
  });

  it('applies the schema defaults, so the form opens on the values actually in force', () => {
    // A provider reporting only what it was told still runs with defaults for
    // the rest. Showing those blank would invite an operator to save a form that
    // silently changes them.
    expect(ldapEnvBaseline(reporting(MINIMAL))).toMatchObject({
      dialect: 'openldap',
      nestedGroups: false,
      timeoutMs: 10_000,
      tlsRejectUnauthorized: true,
      roleMappings: [],
    });
  });

  it('strips a bind password even though the contract forbids reporting one', () => {
    // The result is rendered in a browser. A provider that ignores the contract
    // must not be the reason a secret reaches it.
    const baseline = ldapEnvBaseline(reporting({ ...MINIMAL, bindPassword: 'hunter2' }));

    expect(baseline).not.toBeNull();
    expect(baseline).not.toHaveProperty('bindPassword');
    expect(JSON.stringify(baseline)).not.toContain('hunter2');
  });

  it('is null when no LDAP provider is registered', () => {
    expect(ldapEnvBaseline(resolverWith(null))).toBeNull();
  });

  it('is null when the provider does not implement the seam', () => {
    // Every provider written before this method existed.
    expect(ldapEnvBaseline(resolverWith({ source: 'ldap' }))).toBeNull();
  });

  it('is null when the provider reports nothing', () => {
    expect(ldapEnvBaseline(reporting(null))).toBeNull();
    expect(ldapEnvBaseline(reporting(undefined))).toBeNull();
  });

  it('is null, not a throw, when the provider reports a configuration that cannot be valid', () => {
    // 'ldap.example.test' has no scheme; the schema rejects it. The settings
    // page must still render.
    expect(ldapEnvBaseline(reporting({ url: 'ldap.example.test' }))).toBeNull();
    expect(ldapEnvBaseline(reporting({ ...MINIMAL, timeoutMs: -1 }))).toBeNull();
    expect(ldapEnvBaseline(reporting('not an object'))).toBeNull();
  });

  it('is null, not a throw, when the provider itself throws', () => {
    const resolver = resolverWith({
      source: 'ldap',
      currentConfiguration: () => {
        throw new Error('directory client not initialised');
      },
    });

    expect(() => ldapEnvBaseline(resolver)).not.toThrow();
    expect(ldapEnvBaseline(resolver)).toBeNull();
  });

  it('warns when it discards something, so a misbehaving provider is diagnosable', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    ldapEnvBaseline(reporting({ url: 'nonsense' }));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not match the settings schema'),
    );
  });
});
