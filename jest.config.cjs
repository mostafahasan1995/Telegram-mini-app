/**
 * Unit / fast suite.  `npm test`
 *
 * Integration specs (`*.int.spec.ts`) are EXCLUDED here and run from jest-int.config.cjs. They need
 * Docker, take seconds each, and share a database — mixing them in means a developer's edit-test
 * loop pays for testcontainers on every save, and Jest's parallel workers fight over the same rows.
 *
 * `moduleNameMapper` mirrors tsconfig "paths" exactly. If the two ever disagree, `tsc` passes and
 * Jest cannot resolve a module — so treat this block and tsconfig.json as one edit.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],

  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '\\.int\\.spec\\.ts$', '\\.e2e-spec\\.ts$'],

  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        // Inline compiler options are MERGED over the project's tsconfig.json (paths, strictness
        // and decorators all still apply). `isolatedModules` is set here rather than as a ts-jest
        // option because the ts-jest option of that name is deprecated and warns on every run.
        // Type errors are `npm run typecheck`'s job; transpile-only keeps the suite fast and stops
        // an unrelated type error from failing an otherwise green test run.
        tsconfig: { isolatedModules: true },
      },
    ],
  },

  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },

  setupFiles: ['<rootDir>/test/setup/jest-setup.ts'],

  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/**/*.module.ts',
    '!src/main*.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',

  clearMocks: true,
};
