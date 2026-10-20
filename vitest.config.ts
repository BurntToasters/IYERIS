import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage-headless',
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**/*.test.ts', 'src/types.d.ts'],
      thresholds: {
        statements: 15,
        branches: 10,
        functions: 12,
        lines: 15,
      },
    },
  },
});
