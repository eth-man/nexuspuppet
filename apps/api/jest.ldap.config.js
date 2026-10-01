/**
 * Integration suite: the LDAP provider against a real OpenLDAP container.
 *
 *   npm run ldap:up --workspace @nexuspuppet/api     # container + test tree
 *   npm run test:ldap --workspace @nexuspuppet/api
 *   npm run ldap:down --workspace @nexuspuppet/api
 *
 * Separate from jest.config.js so the default `npm test` needs no Docker, and
 * from jest.int.config.js so the Postgres suite needs no directory. Runs in
 * band: the tests share one directory server and one bind-heavy connection
 * path, and parallel workers make failures order-dependent.
 *
 * See test/ldap/README.md.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/ldap'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^@nexuspuppet/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
  },
  maxWorkers: 1,
};
