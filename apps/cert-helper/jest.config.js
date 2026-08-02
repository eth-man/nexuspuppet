/**
 * The helper has no framework and no database. Its tests are pure functions and
 * a temp directory, which is the point: this is the one component that writes
 * the console's private key, so it should be small enough to read in full.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '(test|src)/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  moduleNameMapper: {
    // Source, so a grant-format change is visible here without a build step —
    // and so this suite does not depend on dist/ existing.
    '^@nexuspuppet/tls-grant$': '<rootDir>/../../packages/tls-grant/src/index.ts',
  },
};
