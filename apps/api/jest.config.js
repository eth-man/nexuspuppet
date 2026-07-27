/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleNameMapper: {
    // Resolve the workspace sibling to source, so a contracts change is visible
    // to tests without a build step.
    '^@nexuspuppet/contracts$': '<rootDir>/../../../packages/contracts/src/index.ts',
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts', '!**/*.module.ts'],
  coverageThreshold: {
    global: { branches: 60, functions: 60, lines: 60, statements: 60 },
    // RuleEvaluator, ClassMerger, and EncYamlRenderer decide what a thousand
    // machines run. Bugs here are silent and expensive (ADR-0009).
    './materialization/pure/': {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
};
