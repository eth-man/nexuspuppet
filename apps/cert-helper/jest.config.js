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
};
