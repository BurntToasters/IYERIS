# Contributing to IYERIS

## Architecture Overview

IYERIS is an Electron-based cross-platform file explorer. The codebase is split across three process boundaries with strict separation enforced by TypeScript compilation and Electron's context isolation.

IYERIS aims to not use `any` types in all TS files that get compiled to be packaged into the `electron-builder` packages.

- `*.test.ts` files have an exception to this guideline.

### Directory Structure

```
src/
  main/             Main process modules (Node.js context)
  renderer.ts       Renderer entry point + composition root
  renderer*.ts      Renderer controller modules (browser context)
  rendererElements.ts  Cached DOM element references
  shared.ts         Process-agnostic utilities (used by both main & renderer)
  settings.ts       Settings defaults & sanitization (shared)
  shortcuts.ts      Shortcut definitions (shared)
  homeSettings.ts   Home screen settings sanitization (shared)
  types.d.ts        TypeScript type declarations (shared)
  fileTypes.ts      File extension classification (renderer-only)
  home.ts           Home view controller (renderer-only)
  tour.ts           Onboarding tour controller (renderer-only)
  folderDir.ts      Folder tree manager (renderer-only)
  preload.ts        Preload bridge (context bridge between main & renderer)
  index.html        Application HTML shell
  css/              Stylesheets (one file per component)
  workers/          Web Worker modules for background tasks
  tests/            Test files mirroring source structure
```

### Process Separation

**Main process** (`src/main/`): Node.js context with full filesystem/OS access. Contains IPC handlers, settings persistence, file operations, archive management, indexing, and window management.

**Renderer process** (`src/renderer*.ts`): Browser context with no direct Node.js access. All system operations go through `window.electronAPI` (the preload bridge). Contains UI controllers, DOM manipulation, and user interaction logic.

**Preload** (`src/main/preload.ts`): Bridges main and renderer via `contextBridge.exposeInMainWorld`. Exposes a fully-typed `electronAPI` object defined in `types.d.ts`.

**Workers** (`src/workers/`): Background threads for CPU-intensive tasks (directory listing, file indexing, search, checksums). Communicate with the main process via `worker_threads`.

### Key Patterns

#### Dependency Injection Controllers

All renderer modules follow the `createXxxController(deps)` factory pattern:

```typescript
type NavigationDeps = {
  getCurrentPath: () => string;
  navigateTo: (path: string) => void;
};

export function createNavigationController(deps: NavigationDeps) {
  // All external dependencies come through deps
  return {
    /* exported methods */
  };
}
```

This makes every module independently testable — tests create mock `deps` objects without any module-level mocking.

#### Main Process Handler Registration

Main process modules use `setup*Handlers()` functions to register IPC handlers:

```typescript
export function setupFileOperationHandlers() {
  ipcMain.handle('read-directory', async (event, dirPath) => {
    /* ... */
  });
}
```

#### Shared Modules

Files at `src/` root (outside `main/`) that are imported by both processes:

- `shared.ts` — `escapeHtml()`, `getErrorMessage()`, `ignoreError()`
- `types.d.ts` — All TypeScript interfaces (`Settings`, `FileItem`, `ElectronAPI`, etc.)
- `settings.ts` — `createDefaultSettings()`, `sanitizeSettings()`
- `shortcuts.ts` — Shortcut definitions and defaults
- `homeSettings.ts` — Home screen settings sanitization

### Build System

Two separate TypeScript compilations:

- **`tsconfig.main.json`** — CommonJS output to `dist/main/` (main process + preload)
- **`tsconfig.renderer.json`** — ES2020 module output to `dist/renderer/` (renderer entry point pulls in all renderer modules transitively)

Build pipeline: `npm run build` = clean → compile main → compile renderer → copy vendor assets

### Testing

- **Framework**: Vitest with jsdom environment available per-file
- **Convention**: `foo.test.ts` for base tests, `foo.extended.test.ts` for additional coverage, plus descriptive suffixes (e.g., `breadcrumbs`, `filters.scope`)
- **Pattern**: Tests mirror the DI pattern — create mock deps, instantiate controller, test methods

### Quality Checks

```bash
npm run test:all    # Build + lint + format + vitest + typecheck
npm run lint        # ESLint
npm run format      # Prettier
npm run typecheck   # tsc --noEmit (both configs)
npm test            # Vitest only
```

### CSS Architecture

- Pure CSS with custom properties (no preprocessor)
- Design tokens in `css/variables.css` (~85 properties)
- Platform-adaptive styling via `body.platform-*` classes
- Three UI density variants: compact, default, large
- One stylesheet per component, imported through `css/main.css`
