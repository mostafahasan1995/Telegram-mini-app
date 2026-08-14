/**
 * Integration / e2e suite.  `npm run test:int`   (requires Docker)
 *
 * Everything here is the unit config plus the three things a suite that touches a real database
 * needs:
 *
 *  - `maxWorkers: 1`. Each worker would otherwise start its OWN Postgres and Redis container, and
 *    on a laptop that is several gigabytes and a minute of startup before the first assertion. It
 *    also removes the whole class of "passes alone, fails in CI" caused by two workers truncating
 *    the same database. Speed here comes from `truncateAll()` between tests, not from parallelism.
 *
 *  - `testTimeout: 120s`. Pulling postgres:17-alpine on a cold machine, running `prisma db push`
 *    and applying prisma/sql/001..005 comfortably exceeds Jest's 5s default; every test in the file
 *    that starts the container pays for it once.
 *
 *  - `forceExit: false` with `detectOpenHandles`. A leaked pg pool or ioredis connection is a real
 *    bug in a service that must drain cleanly on SIGTERM — `forceExit: true` would hide exactly the
 *    defect this project cares about. If the suite hangs, the open handle it prints IS the finding.
 */
const unitConfig = require('./jest.config.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...unitConfig,

  testMatch: ['<rootDir>/src/**/*.int.spec.ts', '<rootDir>/test/**/*.int.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],

  maxWorkers: 1,
  testTimeout: 120_000,

  forceExit: false,
  detectOpenHandles: true,

  collectCoverageFrom: undefined,
};
