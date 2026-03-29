import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/tests/**/*.test.ts',
        'src/renderer.ts',
        'src/tauri-api.ts',
        'src/types.d.ts',
        'src/rendererBootstrap.ts',
        'src/rendererControllerWiring.ts',
        'src/rendererDirectoryLoader.ts',
        'src/rendererElements.ts',
        'src/rendererPdfViewer.ts',
        'src/rendererThumbnails.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
