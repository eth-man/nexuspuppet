import { loadEnv } from './env';

const minimal = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  JWT_SECRET: 'x'.repeat(48),
  PUPPETDB_URL: 'https://puppetdb.example.com:8081',
  PUPPETDB_CERT_PATH: '/certs/client.pem',
  PUPPETDB_KEY_PATH: '/certs/client.key',
  PUPPETDB_CA_PATH: '/certs/ca.pem',
  ENC_OUTPUT_DIR: '/srv/enc',
};

describe('loadEnv', () => {
  it('accepts a minimal valid configuration and applies defaults', () => {
    const env = loadEnv({ ...minimal });
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
    expect(env.ENC_MAX_JOB_ATTEMPTS).toBe(5);
  });

  // A .env file routinely carries `SOME_VAR=` for values not yet filled in.
  // Treating that as present-but-invalid would block boot on a fresh setup.
  describe('empty values are treated as absent', () => {
    it('does not fail on an empty optional', () => {
      expect(() => loadEnv({ ...minimal, BOOTSTRAP_ADMIN_PASSWORD: '' })).not.toThrow();
    });

    it('falls back to the default rather than rejecting an empty value', () => {
      expect(loadEnv({ ...minimal, LOG_LEVEL: '' }).LOG_LEVEL).toBe('info');
      expect(loadEnv({ ...minimal, API_PORT: '' }).API_PORT).toBe(3001);
    });

    it('still rejects an empty REQUIRED value', () => {
      expect(() => loadEnv({ ...minimal, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
    });
  });

  describe('secrets have no defaults', () => {
    // A development fallback secret is exactly the kind of thing that reaches
    // production (ADR-0006).
    it('refuses to boot without JWT_SECRET', () => {
      const { JWT_SECRET: _omitted, ...without } = minimal;
      expect(() => loadEnv(without)).toThrow(/JWT_SECRET/);
    });

    it('rejects a short JWT_SECRET', () => {
      expect(() => loadEnv({ ...minimal, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
    });

    it('refuses to boot without DATABASE_URL', () => {
      const { DATABASE_URL: _omitted, ...without } = minimal;
      expect(() => loadEnv(without)).toThrow(/DATABASE_URL/);
    });
  });

  // An operator fixing a misconfigured deployment should see every problem at
  // once, not discover the next missing variable on each restart.
  it('reports all problems in a single message', () => {
    let message = '';
    try {
      loadEnv({ DATABASE_URL: minimal.DATABASE_URL });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('PUPPETDB_URL');
    expect(message).toContain('ENC_OUTPUT_DIR');
  });

  describe('PUPPETDB_PROJECTED_FACTS', () => {
    it('parses a comma-separated allow-list', () => {
      const env = loadEnv({ ...minimal, PUPPETDB_PROJECTED_FACTS: 'os, networking ,kernel' });
      expect(env.PUPPETDB_PROJECTED_FACTS).toEqual(['os', 'networking', 'kernel']);
    });

    it('drops empty segments from a trailing comma', () => {
      const env = loadEnv({ ...minimal, PUPPETDB_PROJECTED_FACTS: 'os,,kernel,' });
      expect(env.PUPPETDB_PROJECTED_FACTS).toEqual(['os', 'kernel']);
    });
  });

  // The service treats a non-positive interval as "disabled"; rejecting 0 here
  // would make that path unreachable.
  it('accepts 0 for PUPPETDB_PROJECTION_INTERVAL_MS, meaning disabled', () => {
    expect(
      loadEnv({ ...minimal, PUPPETDB_PROJECTION_INTERVAL_MS: '0' }).PUPPETDB_PROJECTION_INTERVAL_MS,
    ).toBe(0);
  });

  it('still rejects a negative projection interval', () => {
    expect(() => loadEnv({ ...minimal, PUPPETDB_PROJECTION_INTERVAL_MS: '-1' })).toThrow();
  });

  it('rejects a malformed PUPPETDB_URL', () => {
    expect(() => loadEnv({ ...minimal, PUPPETDB_URL: 'not-a-url' })).toThrow(/PUPPETDB_URL/);
  });

  it('coerces numeric strings and rejects nonsense', () => {
    expect(loadEnv({ ...minimal, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => loadEnv({ ...minimal, API_PORT: 'abc' })).toThrow(/API_PORT/);
    expect(() => loadEnv({ ...minimal, API_PORT: '70000' })).toThrow(/API_PORT/);
  });
});
