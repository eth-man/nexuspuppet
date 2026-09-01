import {
  AUDIT_SINK,
  AUDIT_TRANSPORT,
  AUTH_PROVIDER,
  CAPABILITIES,
} from '@nexuspuppet/contracts';
import { register } from '../src/index';

/**
 * What `register()` hands core (ADR-0015).
 *
 * This was untested, and one of the untested behaviours was load-bearing: with
 * no directory configured it threw, and a throw from `register()` is fatal in
 * the loader. So an operator who enabled LDAP, locked themselves out, and tried
 * to back the change out by unsetting `LDAP_URL` found the API would not boot at
 * all — no way back short of writing to the database by hand.
 */

const LDAP_ENV = {
  LDAP_URL: 'ldaps://directory.example.test:636',
  LDAP_BIND_DN: 'cn=svc,dc=example,dc=test',
  LDAP_BIND_PASSWORD: 'secret',
  LDAP_SEARCH_BASE: 'ou=people,dc=example,dc=test',
};

describe('register()', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LDAP_') || key.startsWith('OIDC_') || key.startsWith('AUDIT_EXPORT_')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
  });

  const clearDirectoryEnv = (): void => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LDAP_') || key.startsWith('OIDC_') || key.startsWith('AUDIT_EXPORT_')) {
        delete process.env[key];
      }
    }
  };

  describe('with no directory configured', () => {
    it('starts, rather than refusing to boot', () => {
      // The behaviour that made a lockout unrecoverable. An enterprise layer
      // with no directory is a deployment where local accounts serve everybody,
      // which is a working product.
      clearDirectoryEnv();

      expect(() => register()).not.toThrow();
    });

    it('contributes no auth provider and claims no directory capability', () => {
      clearDirectoryEnv();

      const descriptor = register();

      expect(descriptor.authProviders ?? []).toEqual([]);
      expect(descriptor.capabilities).not.toContain('directory.ldap');
      expect(descriptor.capabilities).not.toContain('sso.oidc');
    });
  });

  describe('with LDAP configured', () => {
    beforeEach(() => {
      clearDirectoryEnv();
      Object.assign(process.env, LDAP_ENV);
    });

    it('contributes the provider ADDITIVELY, not as an override', () => {
      // The whole change. Registering AUTH_PROVIDER removed core's local
      // provider; core now refuses that, so a build still doing it would
      // authenticate nobody.
      const descriptor = register();

      expect(descriptor.authProviders).toHaveLength(1);
      expect(descriptor.registrations.map((r) => r.token)).not.toContain(AUTH_PROVIDER);
    });

    it('claims the directory capability', () => {
      expect(register().capabilities).toContain('directory.ldap');
    });
  });

  /**
   * Both at once (ADR-0023 §1).
   *
   * This used to assert a THROW, on the grounds that two directories are an
   * ambiguity core cannot resolve. Core resolved it two ADRs ago: ADR-0015
   * replaced the singular AUTH_PROVIDER token with a collection and dispatches
   * by the account's `authSource`. What core still refuses — two providers
   * claiming the SAME source — is untouched, and LDAP and OIDC claim different
   * ones.
   */
  describe('with LDAP and OIDC both configured', () => {
    const bothConfigured = (): void => {
      clearDirectoryEnv();
      Object.assign(process.env, LDAP_ENV, {
        OIDC_ISSUER: 'https://idp.example.test',
        OIDC_CLIENT_ID: 'nexuspuppet',
        OIDC_CLIENT_SECRET: 'secret',
        OIDC_REDIRECT_URI: 'https://console.example.test/auth/callback',
      });
    };

    it('boots instead of refusing', () => {
      bothConfigured();

      expect(() => register()).not.toThrow();
    });

    it('contributes both providers', () => {
      bothConfigured();

      expect(register().authProviders ?? []).toHaveLength(2);
    });

    /*
     * The either/or ternary is what made a LICENCE token stand in for a
     * CONFIGURATION choice: an LDAP deployment did not advertise `sso.oidc`, so
     * the console locked OIDC behind a padlock reading "Enterprise" — shown to
     * an operator already running Enterprise.
     */
    it('advertises both capabilities, not one or the other', () => {
      bothConfigured();

      const { capabilities } = register();

      expect(capabilities).toContain('directory.ldap');
      expect(capabilities).toContain('sso.oidc');
    });

    /*
     * The validation guard read `directoryConfigured && oidc === null`, which
     * was equivalent only while the two were mutually exclusive. With both set
     * it skipped LDAP validation entirely, so a malformed URL reached a login
     * instead of the boot that was supposed to catch it.
     */
    it('still validates the LDAP configuration when OIDC is also set', () => {
      bothConfigured();
      process.env['LDAP_URL'] = 'not a url';

      expect(() => register()).toThrow();
    });
  });

  it('claims neither directory capability when neither directory is configured', () => {
    clearDirectoryEnv();

    const { capabilities } = register();

    expect(capabilities).not.toContain('directory.ldap');
    expect(capabilities).not.toContain('sso.oidc');
  });

  /*
   * UNCONDITIONAL, now that there is no entitlement to gate on.
   *
   * These replace the entitlement suite that used to live here. The behaviour
   * they pin is the same behaviour that used to be the "fully licensed" case —
   * it is simply the only case there is.
   */
  it('registers the audit export pair, and both halves together', () => {
    const { registrations } = register();
    const tokens = registrations.map((r) => r.token);

    // Registering one without the other would either queue records with
    // nowhere to go, or leave nothing enqueuing them.
    expect(tokens).toContain(AUDIT_SINK);
    expect(tokens).toContain(AUDIT_TRANSPORT);
  });

  it('advertises audit export as a capability', () => {
    expect(register().capabilities).toContain(CAPABILITIES.AUDIT_EXPORT);
  });

  /*
   * Core's local provider is never overridden (ADR-0015 §3). This is what makes
   * a directory misconfiguration recoverable instead of a lockout, so it is
   * worth pinning even though nothing here is gated any more.
   */
  it('never registers an AUTH_PROVIDER override', () => {
    const { registrations } = register();

    expect(registrations.map((r) => r.token)).not.toContain(AUTH_PROVIDER);
  });
});
