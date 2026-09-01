/**
 * Integration suite: the LDAP provider against a real OpenLDAP container.
 *
 *   sudo ./test/ldap/up.sh
 *   npm run test:ldap
 *
 * Separate from jest.config.js so the default `npm test` needs no Docker. Runs
 * in band: the tests share one directory server and one bind-heavy connection
 * path, and parallel workers make failures order-dependent.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/ldap'],
  testMatch: ['**/*.spec.ts'],
  maxWorkers: 1,
};
