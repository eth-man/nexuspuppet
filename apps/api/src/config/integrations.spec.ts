import { IntegrationConfigError, integrationsFromEnv } from './integrations';

const LDAP = {
  LDAP_URL: 'ldaps://directory.example.test:636',
  LDAP_BIND_DN: 'cn=svc,dc=example,dc=test',
  LDAP_BIND_PASSWORD: 'secret',
  LDAP_SEARCH_BASE: 'ou=people,dc=example,dc=test',
};

const OIDC = {
  OIDC_ISSUER: 'https://idp.example.test',
  OIDC_CLIENT_ID: 'nexuspuppet',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_REDIRECT_URI: 'https://console.example.test/auth/callback',
};

describe('integrationsFromEnv', () => {
  it('reads nothing configured as nothing configured — a complete product', () => {
    expect(integrationsFromEnv({})).toEqual({ ldap: null, oidc: null, auditExport: null });
  });

  it('treats a blank LDAP_URL as unset, not as a malformed URL', () => {
    // Compose passes `LDAP_URL=` through from .env; that is someone clearing
    // it, and must not stop the API from booting.
    expect(integrationsFromEnv({ LDAP_URL: '  ' }).ldap).toBeNull();
  });

  it('parses each configured integration independently', () => {
    const result = integrationsFromEnv({
      ...LDAP,
      ...OIDC,
      AUDIT_EXPORT_URL: 'https://collector.example.test/audit',
    });

    expect(result.ldap?.url).toBe(LDAP.LDAP_URL);
    expect(result.oidc?.issuer).toBe(OIDC.OIDC_ISSUER);
    expect(result.auditExport?.url).toBe('https://collector.example.test/audit');
  });

  it.each([
    ['LDAP', { ...LDAP, LDAP_URL: 'http://not-ldap.example.test' }],
    ['OIDC', { OIDC_ISSUER: 'https://idp.example.test' }],
    ['Audit export', { AUDIT_EXPORT_URL: 'http://collector.example.test/audit' }],
  ])('refuses a malformed %s configuration, naming it', (name, env) => {
    const read = (): unknown => integrationsFromEnv(env);

    expect(read).toThrow(IntegrationConfigError);
    expect(read).toThrow(new RegExp(`^${name} is configured but its settings are invalid`));
  });

  it('keeps the underlying reason in the message', () => {
    expect(() => integrationsFromEnv({ ...LDAP, LDAP_URL: 'http://x.example.test' })).toThrow(
      /ldap:\/\/ or ldaps:\/\//,
    );
  });
});
