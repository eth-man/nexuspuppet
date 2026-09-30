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
    '^@nexuspuppet/tls-grant$': '<rootDir>/../../../packages/tls-grant/src/index.ts',
  },
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!main.ts',
    '!**/*.module.ts',
    // A thin translation layer over the `ldapts` client. Covering it means
    // asserting against a mock of someone else's library, which proves only
    // that the mock agrees with the assumptions in the same file. The port it
    // implements exists so the DECISION logic is testable without it; that
    // logic is covered here, and this file against a real directory in
    // test/ldap/.
    '!directory/ldap/ldap-client.ts',
  ],
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
    // Authentication and audit forwarding: a bug here is an authentication
    // bypass or a silently missing audit trail, not a rendering glitch. The
    // floor this code carried as packages/enterprise, kept when it moved in
    // (ADR-0027).
    //
    // Keyed from apps/api, NOT from rootDir: Jest resolves a path threshold
    // against the working directory, so './directory/' would name nothing and
    // be silently skipped. (Verified: './src/directory/' reports, the shorter
    // form does not. The './materialization/pure/' key above has the same
    // problem and is left as it was; see the ADR-0027 PR.)
    './src/directory/': { lines: 90, branches: 85 },
    './src/audit-forwarding/': { lines: 90, branches: 85 },
  },
};
