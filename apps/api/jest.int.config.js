/**
 * Integration tests. Require a real PostgreSQL — the transactional outbox and
 * the advisory lock cannot be verified against a mock (a mock confirms whatever
 * the code already believes).
 *
 *   docker compose -f docker-compose.dev.yml up -d
 *   npm run test:int --workspace @nexuspuppet/api
 *
 * Run separately from unit tests so the core-isolation CI job, which has no
 * database, stays fast and dependency-free.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.int-spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^@nexuspuppet/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
  },
  // Advisory-lock tests hold real connections; keep them serial.
  maxWorkers: 1,
};
