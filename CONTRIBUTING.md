# Contributing to IYERIS

## Architecture Overview

IYERIS is a Tauri v2 cross-platform file explorer. The codebase is split between a Rust backend (`src-tauri/`) and a TypeScript frontend (`src/`), communicating via Tauri's `invoke` IPC mechanism.

### Directory Structure

```
src/
  renderer.ts       Renderer entry point + composition root
  renderer*.ts      Renderer controller modules (browser context)
  rendererElements.ts  Cached DOM element references
  tauri-api.ts      Tauri API bridge (wraps invoke calls into typed TauriAPI)
  shared.ts         Process-agnostic utilities
  settings.ts       Settings defaults & sanitization (shared)
  shortcuts.ts      Shortcut definitions (shared)
  homeSettings.ts   Home screen settings sanitization (shared)
  types.d.ts        TypeScript type declarations (shared)
  fileTypes.ts      File extension classification (renderer-only)
  home.ts           Home view controller (renderer-only)
  tour.ts           Onboarding tour controller (renderer-only)
  folderDir.ts      Folder tree manager (renderer-only)
  index.html        Application HTML shell
  css/              Stylesheets (one file per component)
  tests/            Test files mirroring source structure

src-tauri/
  src/main.rs       Tauri app builder, plugin init, invoke handler registration
  src/*.rs          Backend modules (file ops, archive, search, indexer, etc.)
  Cargo.toml        Rust dependencies
  tauri.conf.json   Tauri application configuration
  capabilities/     Tauri v2 security permissions
  entitlements.plist macOS sandbox entitlements
  icons/            Application icons for all platforms
```

### Process Separation

**Rust backend** (`src-tauri/src/`): Full filesystem/OS access. Handles file operations, archive management, indexing, search, settings persistence, system tray, and window management via Tauri commands.

**Frontend** (`src/renderer*.ts`): Browser context with no direct filesystem access. All system operations go through `window.tauriAPI` (the typed bridge in `tauri-api.ts`). Contains UI controllers, DOM manipulation, and user interaction logic.

**Tauri API bridge** (`src/tauri-api.ts`): Wraps `@tauri-apps/api/core.invoke()` calls into a fully-typed `TauriAPI` object defined in `types.d.ts`.

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

#### Rust Command Registration

Backend modules expose Tauri commands via `#[tauri::command]`:

```rust
#[tauri::command]
async fn get_directory_contents(dir_path: String) -> Result<Vec<FileEntry>, String> {
    // ...
}
```

Commands are registered in `main.rs` via `tauri::Builder::invoke_handler`.

### Build System

Single TypeScript compilation via Vite (frontend only). Rust backend is compiled by `tauri build`.

Build pipeline: `npm run build` = copy vendor assets → Vite build to `dist/`

### Testing

- **Framework**: Vitest with jsdom environment available per-file
- **Convention**: `foo.test.ts` for base tests, `foo.extended.test.ts` for additional coverage, plus descriptive suffixes (e.g., `breadcrumbs`, `filters.scope`)
- **Pattern**: Tests mirror the DI pattern — create mock deps, instantiate controller, test methods

### Quality Checks

```bash
npm run test:all    # Lint + format + vitest + typecheck
npm run lint        # ESLint
npm run format      # Prettier
npm run typecheck   # tsc --noEmit
npm test            # Vitest only
```

### CSS Architecture

- Pure CSS with custom properties (no preprocessor)
- Design tokens in `css/variables.css` (~85 properties)
- Platform-adaptive styling via `body.platform-*` classes
- Three UI density variants: compact, default, large
- One stylesheet per component, imported through `css/main.css`
