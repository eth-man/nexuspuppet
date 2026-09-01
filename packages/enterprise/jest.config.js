/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  // The LDAP integration suite needs a Docker container and a network socket.
  // Keeping it out of the default run means `npm test` stays hermetic and can
  // be trusted in CI without provisioning a directory server.
  testPathIgnorePatterns: ['/node_modules/', '/test/ldap/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/index.ts',
    // A thin translation layer over the `ldapts` client. Covering it means
    // asserting against a mock of someone else's library, which proves only
    // that the mock agrees with the assumptions in the same file. The port it
    // implements exists so the DECISION logic is testable without it; that
    // logic is covered. Verified against a real directory at commissioning.
    '!src/ldap/ldap-client.ts',
  ],
  // The auth path is the highest-consequence code in this package: a bug here
  // is an authentication bypass, not a rendering glitch.
  coverageThreshold: {
    global: { lines: 90, branches: 85 },
  },
};
