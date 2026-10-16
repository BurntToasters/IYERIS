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
  return {/* exported methods */};
}
```

Dependency injection keeps renderer behavior explicit and lets the browser smoke exercise the real controllers with a small native-IPC boundary stub.

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

### Verification and Regression Coverage

Prefer end-to-end coverage for behavior users see. `npm run test:e2e` runs the renderer controllers in an installed Chromium browser and records suite results in `coverage-headless/browser-smoke-artifact.json`; bounded browser diagnostics go to `coverage-headless/browser-smoke-diagnostics.log`. The browser page stubs Tauri IPC, so these checks cover renderer behavior and do not replace native Rust regression coverage.

The smoke runner discovers an installed Chrome, Chromium, Edge, or Helium executable. Set `IYERIS_SMOKE_BROWSER` to an existing Chromium-compatible executable to select one explicitly; an invalid explicit path fails with an actionable error instead of falling back. The runner does not download or install a browser, and it uses a disposable profile under the system temporary directory.

Use deterministic fixtures in a unique temporary directory and clean them up. Keep fixture reads and writes away from user files, application settings, browser profiles, and other persistent local state. Browser smoke artifacts contain test outputs and bounded browser diagnostics, not user configuration or application data.

Keep native regression coverage for Rust behavior such as filesystem traversal, archive encryption, and cache persistence. Use real temporary filesystem fixtures where practical, and retain failure-mode coverage when updating native contracts. `npm run test:all` runs the project quality gate, including the headless checks, renderer browser smoke, and Rust checks; `npm run test:e2e` runs the browser smoke directly.

Follow the repository's E2E-first testing policy. Do not add unit tests after writing production code. If a behavior must be tested in isolation, list its plausible failure modes first and author all required isolated regression tests before changing production code. Do not add agents as co-authors to commits or pull requests.

### Quality Checks

```bash
npm run test:all       # Complete quality gate, including browser and Rust checks
npm run test:e2e       # Renderer browser E2E and repeatable JSON artifact
npm run lint:prod      # Production TypeScript lint
npm run format:check   # Formatting check
npm run typecheck      # TypeScript check
```

### CSS Architecture

- Pure CSS with custom properties (no preprocessor)
- Design tokens in `css/variables.css` (~85 properties)
- Platform-adaptive styling via `body.platform-*` classes
- Three UI density variants: compact, default, large
- One stylesheet per component, imported through `css/main.css`
