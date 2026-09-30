import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * ESLint flat config.
 *
 * The blocks that matter architecturally are the CONTRACTS and WEB TIER
 * boundaries. They are not style rules — they are the mechanical enforcement
 * of ADR-0001 and the C4 L2 trust boundaries. Weakening either requires a
 * superseding ADR, not a PR comment.
 *
 * There was an ENTERPRISE BOUNDARY block here, forbidding any static import
 * of packages/enterprise (ADR-0002). ADR-0027 moved that code into apps/api
 * and superseded ADR-0002, so there is no boundary left for it to enforce.
 */

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.mjs',
      '**/.prisma/**',
      'apps/api/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // contracts must stay dependency-free apart from zod (ADR-0001).
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'next', 'next/*', 'react', '@prisma/client', 'undici'],
              message:
                'ADR-0001: @nexuspuppet/contracts has zero runtime dependencies beyond zod. It declares interfaces, not implementations.',
            },
            {
              group: ['@nexuspuppet/api', '@nexuspuppet/web'],
              message: 'ADR-0001: contracts may not depend on its consumers.',
            },
          ],
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // WEB TIER BOUNDARY (C4 L2, ADR-0008)
  //
  // apps/web is a rendering tier. It holds no database credentials and no
  // PuppetDB certificate. Next.js server components make direct DB access
  // technically easy; doing it would split authorization across two apps and
  // fracture the audit trail.
  // -------------------------------------------------------------------------
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '.prisma/*', 'prisma', 'undici'],
              message:
                'C4 L2 / ADR-0008: the web tier has no data-layer credentials. Fetch through the API.',
            },
          ],
        },
      ],
    },
  },

  // The materializer's pure core must stay pure — it is the highest-blast-radius
  // code in the product (ADR-0009). No I/O, no clock, no randomness.
  {
    files: ['apps/api/src/materialization/pure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:fs', 'node:fs/*', 'fs', 'node:child_process', '@prisma/client'],
              message:
                'ADR-0009: RuleEvaluator, ClassMerger, and EncYamlRenderer are pure functions. Determinism here is what makes content-hash change detection correct.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'ADR-0009: pure merge/render code must be deterministic. Pass timestamps in.',
        },
      ],
    },
  },

  // Build and tooling scripts run in Node with no TypeScript.
  {
    files: ['scripts/**/*.mjs', '**/*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  prettier,
);
