// WHY: the layering here is not a style preference — it is what keeps the money path auditable.
// `common` is pure (no framework, no IO), `core` owns infrastructure (prisma, redis, ichancy http,
// config), `modules` own use-cases. A modules/A -> modules/B import would let a Telegram handler
// reach into deposit internals without going through a service that owns a transaction boundary,
// so eslint-plugin-boundaries makes that a build failure rather than a code-review opinion.
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      // Dev-only build output for `npm run dev:worker` — see tsconfig.worker.json for why the
      // worker needs an outDir of its own.
      'dist-worker/**',
      'coverage/**',
      'node_modules/**',
      '*.config.mjs',
      // jest.config.cjs / jest-int.config.cjs. Same reason as the .mjs line above: build tooling
      // sits outside tsconfig's `include`, so typescript-eslint's project service cannot resolve a
      // program for it and errors with "was not found by the project service".
      '*.config.cjs',
      'eslint.config.mjs',
      'prisma/sql/**',
    ],
  },

  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { boundaries },
    settings: {
      // WITHOUT THIS the whole layering check silently passes: boundaries resolves imports through
      // eslint-module-utils, whose default node resolver cannot follow @common/@core/@modules, so
      // every aliased import is classified "external" and no rule ever fires.
      'import/resolver': {
        typescript: { project: './tsconfig.json', alwaysTryTypes: true },
      },
      'boundaries/include': ['src/**/*.ts'],
      'boundaries/elements': [
        { type: 'common', pattern: 'src/common/*', mode: 'folder', capture: ['area'] },
        { type: 'core', pattern: 'src/core/*', mode: 'folder', capture: ['area'] },
        { type: 'module', pattern: 'src/modules/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'root', pattern: 'src/*.ts', mode: 'file' },
      ],
    },
    rules: {
      // ---- layering -----------------------------------------------------------------
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message: '${file.type} is not allowed to import ${dependency.type} (layering violation)',
          rules: [
            // root (main.ts / main.worker.ts / app.module.ts) wires everything together
            { from: ['root'], allow: ['root', 'module', 'core', 'common'] },
            // a module may use infrastructure and pure helpers, and only its own folder
            {
              from: ['module'],
              allow: ['core', 'common', ['module', { moduleName: '${from.moduleName}' }]],
            },
            // core is infrastructure: it may compose with other core pieces and use common
            { from: ['core'], allow: ['core', 'common'] },
            // common is pure and self-contained
            { from: ['common'], allow: ['common'] },
          ],
        },
      ],
      'boundaries/no-unknown': 'off',
      'boundaries/no-unknown-files': 'off',

      // ---- money safety -------------------------------------------------------------
      // Floats must never touch the money path. The single sanctioned place that decodes the
      // Ichancy wire format (Float/string) is core/ichancy/money-codec.ts, re-enabled below.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is bigint minor units. Use @common/helpers/money.util.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is bigint minor units. Use @common/helpers/money.util.',
        },
        {
          object: 'Math',
          property: 'round',
          message:
            'Rounding money with Math.round is a bug. Use the bigint helpers in @common/helpers/money.util.',
        },
      ],

      // ---- general ------------------------------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // The one file allowed to look at a float, because it exists to convert them away.
  {
    files: ['src/core/ichancy/money-codec.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },

  // Config + bootstrap need to read process.env and print before the logger exists.
  // scripts/ are operator-facing CLIs whose entire output IS console — there is no Nest logger there.
  {
    files: [
      'src/core/config/**/*.ts',
      'src/main.ts',
      'src/main.worker.ts',
      'src/main.cli.ts',
      'scripts/**/*.ts',
    ],
    rules: { 'no-console': 'off' },
  },

  // Tests may be loose about unsafe assignments from fixtures.
  {
    files: ['**/*.spec.ts', '**/*.int.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'boundaries/element-types': 'off',
    },
  },
);
