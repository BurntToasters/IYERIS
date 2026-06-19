import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'release/', 'node_modules/', 'build/', '*.js', '!eslint.config.mjs'],
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
        'error',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-require-imports': 'error',

      // Console log
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Code quality
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-useless-escape': 'warn',

      'no-empty': ['error', { allowEmptyCatch: true }],

      // innerHTML with template literals is a XSS-prone pattern. All user data
      // must go through escapeHtml(). Reviewed, safe sites carry a disable
      // comment so future unreviewed uses are caught here.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            'AssignmentExpression[left.property.name=/^(inner|outer)HTML$/][right.type="TemplateLiteral"]',
          message:
            'innerHTML/outerHTML with template literals risks XSS. Ensure all user data uses escapeHtml(), then add an eslint-disable-next-line comment documenting the review.',
        },
        {
          selector: 'CallExpression[callee.property.name="insertAdjacentHTML"] > TemplateLiteral',
          message:
            'insertAdjacentHTML with template literals risks XSS. Ensure all user data uses escapeHtml(), then add an eslint-disable-next-line comment documenting the review.',
        },
      ],
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
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
