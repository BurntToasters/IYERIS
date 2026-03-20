import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'release/', 'node_modules/', 'build/', 'src/main/**', 'src/workers/**', '*.js', '!eslint.config.mjs'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
      },
    },
    rules: {
      // Type safety
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-require-imports': 'warn',

      // Console log
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Code quality
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-async-promise-executor': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',

      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.test.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
