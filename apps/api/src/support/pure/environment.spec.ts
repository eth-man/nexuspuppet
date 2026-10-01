import { envSchema } from '../../config/env';
import { ENVIRONMENT_TREATMENT, environmentReport, looksSecret, urlOrigin } from './environment';

describe('support bundle environment allow-list', () => {
  /*
   * THE ENFORCEMENT. A variable added to the API without a decision here would
   * be withheld (safe) — but silently, so the next bundle would lack exactly
   * the setting somebody just introduced. This makes the decision mandatory.
   */
  it('classifies every variable in envSchema', () => {
    const unclassified = Object.keys(envSchema.shape).filter(
      (key) => !(key in ENVIRONMENT_TREATMENT),
    );
    expect(unclassified).toEqual([]);
  });

  it('never shows the value of anything whose name looks like a credential', () => {
    const exposed = Object.entries(ENVIRONMENT_TREATMENT)
      .filter(([name, treatment]) => treatment !== 'presence' && looksSecret(name))
      .map(([name]) => name);
    expect(exposed).toEqual([]);
  });

  it.each([
    'JWT_SECRET',
    'CONFIG_ENCRYPTION_KEY',
    'CERT_HELPER_SECRET',
    'BOOTSTRAP_ADMIN_PASSWORD',
    'POSTGRES_PASSWORD',
    'LDAP_BIND_PASSWORD',
    'OIDC_CLIENT_SECRET',
    'AUDIT_EXPORT_TOKEN',
    'DATABASE_URL',
    'SHADOW_DATABASE_URL',
  ])('treats %s as a secret', (name) => {
    expect(ENVIRONMENT_TREATMENT[name]).toBe('presence');
    expect(looksSecret(name)).toBe(true);
  });

  it('does not mistake certificate PATHS for keys', () => {
    for (const name of ['PUPPETDB_KEY_PATH', 'ENC_REPLICATION_KEY_PATH', 'PUPPETDB_CERT_DIR']) {
      expect(looksSecret(name)).toBe(false);
    }
    expect(looksSecret('SOME_API_KEY')).toBe(true);
    expect(looksSecret('STRIPE_KEY')).toBe(true);
    expect(looksSecret('SMTP_PASS')).toBe(true);
    expect(looksSecret('KEYBOARD_LAYOUT')).toBe(false);
  });

  describe('environmentReport', () => {
    const env = {
      LOG_LEVEL: 'debug',
      PUPPETDB_URL: 'https://puppetdb.example.com:8081',
      JWT_SECRET: 'j'.repeat(48),
      DATABASE_URL: 'postgresql://nexus:db-p%40ss@db:5432/np',
      AUDIT_EXPORT_URL: 'https://hooks.example.com/services/T000/B000/XXXXSECRET',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      CUSTOM_WEBHOOK_TOKEN: 'tok-abcdef',
      PATH: '/usr/bin',
      EMPTY_ONE: '',
      CONFIG_ENCRYPTION_KEY: undefined,
    };
    const { report, secrets } = environmentReport(env);

    it('shows allow-listed values', () => {
      expect(report.values).toEqual({
        LOG_LEVEL: 'debug',
        PUPPETDB_URL: 'https://puppetdb.example.com:8081',
        AUDIT_EXPORT_URL: 'https://hooks.example.com',
      });
    });

    it('reports every secret as set or unset, never its value', () => {
      expect(report.secrets['JWT_SECRET']).toBe('set');
      expect(report.secrets['DATABASE_URL']).toBe('set');
      expect(report.secrets['BOOTSTRAP_ADMIN_EMAIL']).toBe('set');
      expect(report.secrets['CONFIG_ENCRYPTION_KEY']).toBe('unset');
      expect(JSON.stringify(report)).not.toContain('jjjjjj');
      expect(JSON.stringify(report)).not.toContain('db-p');
      expect(JSON.stringify(report)).not.toContain('admin@example.com');
    });

    it('lists unclassified variables by name only', () => {
      expect(report.unclassified).toEqual(['CUSTOM_WEBHOOK_TOKEN', 'PATH']);
      expect(JSON.stringify(report)).not.toContain('tok-abcdef');
      expect(JSON.stringify(report)).not.toContain('/usr/bin');
    });

    it('hands every secret value, and URL passwords decoded and not, to the redactor', () => {
      const byName = (name: string) => secrets.filter((s) => s.name === name).map((s) => s.value);

      expect(byName('JWT_SECRET')).toEqual(['j'.repeat(48)]);
      expect(byName('DATABASE_URL')).toEqual(['postgresql://nexus:db-p%40ss@db:5432/np']);
      expect(byName('DATABASE_URL.password').sort()).toEqual(['db-p%40ss', 'db-p@ss']);
      // Unclassified, but its NAME says it is a credential.
      expect(byName('CUSTOM_WEBHOOK_TOKEN')).toEqual(['tok-abcdef']);
      // Unclassified and not credential-shaped: not a redaction target.
      expect(byName('PATH')).toEqual([]);
    });
  });

  /*
   * With personal data requested, an identity stops being a redaction target —
   * masking the admin's address in the very user list that was asked for would
   * defeat the request. A SECRET is a target either way.
   */
  it('stops redacting identities, and only identities, when personal data is requested', () => {
    const env = {
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      JWT_SECRET: 'j'.repeat(48),
    };
    const names = (personal: boolean) =>
      environmentReport(env, { includePersonalData: personal }).secrets.map((s) => s.name);

    expect(names(false)).toEqual(['BOOTSTRAP_ADMIN_EMAIL', 'JWT_SECRET']);
    expect(names(true)).toEqual(['JWT_SECRET']);
    // The configuration report shows set/unset in both.
    expect(
      environmentReport(env, { includePersonalData: true }).report.secrets['BOOTSTRAP_ADMIN_EMAIL'],
    ).toBe('set');
  });

  it('reduces a URL to its origin, and withholds one it cannot parse', () => {
    expect(urlOrigin('https://u:p@hooks.example.com:8443/a/b?token=x')).toBe(
      'https://hooks.example.com:8443',
    );
    expect(urlOrigin('not a url')).toBe('[unparseable URL withheld]');
  });
});
