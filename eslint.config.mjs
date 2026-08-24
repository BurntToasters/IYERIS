import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Node runtime globals used by the build/release scripts. */
const NODE_GLOBALS = {
  __dirname: 'readonly',
  __filename: 'readonly',
  AbortController: 'readonly',
  Buffer: 'readonly',
  ClearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/',
      'release/',
      'node_modules/',
      'build/',
      '*.js',
      '!eslint.config.mjs',
      // Stale one-off that rewrites package.json scripts. It predates
      // release:session:start (re-running it would silently drop that gate from
      // release:prepare) and it calls require() inside an ESM package, so it
      // cannot execute at all. Left unlinted pending deletion rather than
      // patched up to look maintained.
      'scripts/update-iyeris-pkg.js',
    ],
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
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
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
        'error',
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
      // Tests compile under `strict` (see tsconfig.test.json), so *implicit* any is
      // already an error via noImplicitAny. What stays allowed is the explicit
      // `as any` used to hand-build dependency fakes, which is deliberate: the
      // controllers take wide dependency objects and spelling out every one in full
      // would obscure what each test is actually exercising. Turning this on flags
      // ~1400 such casts, so it is left off knowingly rather than by omission.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Build/release tooling. These were previously unlinted: they are plain Node
  // scripts, so without declared globals every `process`/`console` reference
  // tripped no-undef and nobody ran eslint over them at all.
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      // Release scripts report progress on stdout by design.
      'no-console': 'off',
      // Same convention as src/: a deliberately swallowed error is fine.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS, require: 'readonly', module: 'writable', exports: 'writable' },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
