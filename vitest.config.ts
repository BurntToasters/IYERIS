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
        'src/rendererActivityState.ts',
        'src/rendererControllerWiring.ts',
        'src/rendererDirectoryLoader.ts',
        'src/rendererElements.ts',
        'src/rendererPdfViewer.ts',
        'src/rendererThumbnails.ts',
        // Renderer DOM-wiring controllers extracted verbatim from renderer.ts
        // (same composition layer as the excludes above; integration-tested in-app).
        'src/rendererDualPane.ts',
        'src/rendererStatusBar.ts',
        'src/rendererRecentFiles.ts',
        'src/rendererSidebar.ts',
        // Windows-only native Snap Layouts wiring (DOM + IPC; untestable in jsdom).
        'src/rendererSnapLayout.ts',
      ],
      thresholds: {
        lines: 92,
        functions: 91,
        branches: 78,
        statements: 90,
      },
    },
  },
});
