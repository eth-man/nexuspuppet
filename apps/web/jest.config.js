/**
 * Unit tests for logic that is pure, and that a browser test would cover only
 * indirectly.
 *
 * NOT a substitute for the Playwright suite. Rendering, routing and anything
 * touching the API belong there; this is for the small pure functions the UI
 * leans on, where an end-to-end test would prove the same thing far more slowly
 * and name the cause far less precisely.
 *
 * `node`, not `jsdom`: nothing here renders. A component test needs a DOM
 * environment and a testing-library setup, which is a larger decision than this
 * config makes.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    // Source, not dist, so a contracts change is visible without a build step.
    '^@nexuspuppet/contracts$': '<rootDir>/../../../packages/contracts/src/index.ts',
    '^@/(.*)$': '<rootDir>/$1',
  },
};
