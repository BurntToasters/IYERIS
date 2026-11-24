# IYERIS 4 Progress Tracker

IYERIS 4 replaces the Tauri webview app with a native Rust application. The UI is built on
[Rune](https://github.com/anomalyco/rune). The 3.2.x line on `main` is the last IYERIS 3 release
series and receives fixes only. This file tracks progress on the `next-4.0.0` branch.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked.

## Decisions

| Decision           | Choice                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| UI framework       | Rune + `rune-kit`, pinned to one exact upstream `dev` revision                                                   |
| Fallback framework | GPUI + gpui-kit, used only if a Phase 0 gate fails with no workaround                                            |
| Scope of 4.0       | Full parity with 3.x before 4.0 stable, including native PDF, video and audio preview                            |
| Upgrade from 3.2.x | Direct update. 4.x publishes the manifest names 3.x already reads, signed with the same key. 3.x is not changed. |
| Code layout        | `iyeris-core` holds all logic and never depends on Rune. Only `iyeris-app` depends on Rune.                      |

## Layout

```
Cargo.toml            workspace root (members crates/*, excludes src-tauri)
Cargo.lock
crates/
  iyeris-core/        framework-free logic ported from src-tauri/src
  iyeris-e2e/         end-to-end harness; writes target/e2e/*.json (and PNGs later)
  iyeris-app/         Rune UI (Phase 0 spike, then the app)
src/, src-tauri/      3.x code, kept as reference until Phase 6
```

## Working with Rune

- Pin: one 40-character `rev` of Rune's `dev` branch for `rune` and for every entry of Rune's
  `[patch.crates-io]` table. The patches live in this repo's root `Cargo.toml`, because Cargo does
  not inherit patches from a dependency. Entries at the pinned rev: wgpu-hal, winit, sctk-adwaita,
  parley_engine, accesskit_windows, accesskit_macos. (Upstream `dev` later added naga and
  accesskit_atspi_common; add them when bumping past them.)
- Bump: read the patch table from Rune's root `Cargo.toml` at the new rev; it can change. winit and
  sctk-adwaita always come from the same rev. Check Rune's `CHANGELOG.md` for output changes. A bump
  must pass the headless golden suite (PNG and element-tree diffs).
- Pinned rev: `935d040ab509e16fa4d4396385ead51eb2d33d3d` (`dev`, 2026-11-21), depended on from
  upstream directly. Chosen as the newest `dev` commit at least 72 hours old, matching the crate
  age rule. Added through `scripts/cargo-safe-update.mjs --manifest-path Cargo.toml --workspace`
  with one `--allow-git <package>@<rev>` per Rune git package (18) and the reason "Rune UI
  framework for IYERIS 4 (pre-release, no crates.io releases); pinned to one dev rev per Rune
  README". No crates.io package needed an age override.
- Bump command: same tool and flags with the new rev; the tool now accepts a manifest that gained
  dependencies (it falls back to the existing `Cargo.lock` as the baseline).
- Toolchain: Rune pins Rust 1.99.1, edition 2024, resolver 3. This repo pins 1.99.1 as well.
- Docs to read at the pinned rev (in `~/.cargo/git/checkouts/rune-*`): `examples/hello`,
  `crates/rune/README.md` (`examples/README.md` does not exist at this rev),
  `crates/rune-kit/README.md`, `AGENTS.md`.
- Nearest examples: `drop-files`, `drag-out`, `video-player`, `launcher` (multiple windows),
  `frosted-bar` (blur over a long list), `kit-gallery` (rune-kit Table and Tree).
- Testing: Rune's in-process `Runtime` (`Runtime::new`, `find`, `pointer_down`, `pointer_up`,
  `frame`, `presented`) plus `--snap out.png` and `--tree tree.json` as the repeatable artifact.
  Debug builds always accept these flags. Release builds need `features = ["tooling"]`.
- Linux build dependencies: `libxkbcommon-dev libwayland-dev`; windowed runs also need
  `libxkbcommon-x11-0`. Software Vulkan: `mesa-vulkan-drivers` with `VK_ICD_FILENAMES`.
- Windows: use the MSVC toolchain.

## Phase 0: foundations and Rune validation

Milestone A (local, uses only crates already in `src-tauri/Cargo.lock`):

- [x] Workspace scaffold: root `Cargo.toml`, root `Cargo.lock` seeded from `src-tauri/Cargo.lock`
- [x] `iyeris-core`: portable helpers from `src-tauri/src/main.rs` (`paths.rs`, `launch.rs`)
- [x] `iyeris-core`: seams `PathProvider`, `EventSink`, typed `CoreError`
- [x] `iyeris-core`: `cancellation`, `copy_metadata`, `fs_utils`, `native_macos`, `native_windows`
- [x] `iyeris-core`: `file_operations` (needed by `fs_utils`, `undo` and `elevated`)
- [x] `iyeris-core`: `recovery`, `undo`, `elevated`
- [x] `iyeris-core`: `code_signature`, `platform`
- [x] `iyeris-e2e`: fixture tree, real core operations, `target/e2e/core-artifact.json`
- [x] Wiring: `scripts/test-all.js`, CI, `scripts/check-native-process-policy.js`
- [ ] `cfg(windows)` code in `iyeris-core` compiled on the Windows CI runner (a local
      cross-check stops in blake3's C build)

Known issues carried over from 3.x:

- [ ] Undo of a copy fails with "Recovery record was not found" once a later operation has
      started. `begin_operation` in `recovery.rs` prunes completed records with no retained paths,
      including the copy's record that undo still references. Repro: copy, move, undo move, undo copy.
      The E2E harness currently undoes the copy before the move to stay green. Fix in 3.2.x and here.

Milestone B (Rune spike; CI runs only on `main` and `beta`, so the first build was local):

- [x] Pinned rev recorded as the approved git revision, with a written reason (see above)
- [x] `scripts/cargo-safe-update.mjs` accepts newly added dependencies
- [x] `iyeris-app` spike: 100k synthetic entries in virtualized list and grid, selection, arrow
      keys, view toggle; scenes `list`, `grid`, `list-scrolled`, `grid-selected`
- [x] Headless check `scripts/check-app-headless.mjs` (PNG and element tree per scene) writes
      `target/e2e/app-artifact.json`; part of `test:all`
- [x] Headless input scripts (`crates/iyeris-app/scripts/*.json`) for click, arrow keys and the
      view toggle, asserted in `check-app-headless.mjs`
- [x] Release-build frame timing at 100k entries: `node scripts/measure-app-frames.mjs` writes
      `target/perf/app-frames.json` (measurement, not part of `test:all`). macOS, Apple silicon,
      headless CPU frame time while scrolling 40,000 pt: list p50 0.29 to 0.30 ms, p95 0.41 to 0.58 ms,
      max 0.72 to 1.11 ms; grid p50 0.29 to 0.30 ms, p95 0.44 to 0.46 ms, max 0.58 to 0.65 ms
      (two runs). Presented-frame timing in a window is still open.
- [ ] Windows and Linux runs of the spike (first CI run on `beta`)
- [ ] Mirror fork or `cargo vendor` snapshot of Rune before the first public 4.0 pre-release

Gates (each must pass on Windows, macOS and Linux and leave an artifact):

| Gate             | Must show                                                                                                         | Status |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| G1 scale         | 100k-entry folder in grid and list, p95 frame under 8 ms                                                          | [~]    |
| G2 text          | inline rename with Japanese and Chinese IME                                                                       | [ ]    |
| G3 accessibility | Narrator or NVDA, VoiceOver and Orca read and activate list rows                                                  | [ ]    |
| G4 drag and drop | OS file drop in and drag out (drag out unconfirmed off macOS)                                                     | [ ]    |
| G5 look          | backdrop-blur sidebar and all 8 built-in themes from one token set                                                | [ ]    |
| G6 headless      | `--snap`, `--tree`, `--script` run in CI without a GPU and upload PNG and JSON                                    | [ ]    |
| G7 supply chain  | pinned rev and patches pass `cargo audit` and the update policy; build time, binary size and idle memory recorded | [ ]    |
| G8 windowing     | multiple windows, native menu, tray, custom title bar with Windows 11 snap                                        | [ ]    |
| G9 no GPU        | starts over RDP (WARP) and in a Linux VM (llvmpipe)                                                               | [ ]    |
| G10 media        | a PDF page and a Linux video frame drawn into a Rune image element                                                | [ ]    |

## Phase 1: core

- [x] All 19 backend modules ported to `iyeris-core` (207 tests). Tauri-only glue left for the
      app layer to rebuild on Rune: `open_new_window`, `set_zoom_level`/`get_zoom_level` (the
      0.5 to 2.0 range check lives there), `minimize_window`/`maximize_window`/`close_window`,
      `relaunch_app`, `has_other_visible_windows`, `set_autostart`/`get_autostart` (was
      tauri-plugin-autostart), `setup_tray`, and the save dialog in `export_diagnostics` (its
      content helpers are ported).
- [ ] Release tooling (`scripts/release-session.js` fingerprint and allowed paths) covers the
      root `Cargo.toml` and `Cargo.lock`
- [x] `PathProvider` and `EventSink` replace `AppHandle` paths and `emit`
- [ ] `EventSink` carries a target window: v3 sent directory listing, folder size, watcher and
      archive progress events to the calling window only; the sink is app-wide today
- [ ] `PathProvider` gains a log directory (v3 used Tauri's `app_log_dir`)
- [ ] Linux and Windows cross-checks of `iyeris-core` (need C cross compilers for bzip2-sys,
      lzma-sys, zstd-sys and blake3; or CI on `beta`)
- [ ] Typed errors replace `Result<_, String>`
- [ ] Typed settings with `schemaVersion` (spec: `src/rendererSchemas.ts`, `src/settings.ts`)
- [ ] Importer for 3.x `settings.json` and `home-settings.json`
- [ ] Move `iyeris-core` to edition 2024

## Phase 2: app shell

- [ ] Window and custom title bar
- [ ] Theme tokens from `src/css/variables.css` and `src/css/themes.css`; 8 built-in themes
- [ ] Address bar and navigation history
- [ ] Sidebar and folder tree
- [ ] Grid and list views
- [ ] Tabs
- [ ] Status bar
- [ ] Selection and type-to-select
- [ ] Context menus
- [ ] Shortcut engine (32 actions from `src/shortcuts.ts`)
- [ ] Toasts and modals

## Phase 3: file-management parity

- [ ] Operation queue with progress and cancel
- [ ] Clipboard (cut, copy, paste)
- [ ] Drag and drop (in, out, internal)
- [ ] Undo and redo
- [ ] Elevated operations
- [ ] Archives (create, extract, list)
- [ ] Batch rename
- [ ] Duplicate finder
- [ ] Properties: permissions, checksums, code signatures
- [ ] Search and indexer
- [ ] Git status
- [ ] Bookmarks and recent files
- [ ] Column view and dual pane
- [ ] Home view
- [ ] Command palette
- [ ] Utility drawer
- [ ] Settings UI
- [ ] Theme editor and shortcut editor
- [ ] Folder icons
- [ ] Tour
- [ ] Zoom
- [ ] Multiple windows, tray, native menu

## Phase 4: preview parity

- [ ] Images, including HEIC, AVIF and JXL
- [ ] Text with syntax highlighting
- [ ] Markdown
- [ ] PDF viewer with text layer
- [ ] Video and audio playback on Windows, macOS and Linux
- [ ] Quick Look
- [ ] Hover card
- [ ] Archive listing
- [ ] Thumbnails generated in Rust (OS thumbnail providers where available)

## Phase 5: platform and distribution

- [ ] Installers: NSIS, MSI, MSIX, universal dmg, zip, app.tar.gz, AppImage, deb, rpm, Flatpak
- [ ] Code signing on every channel
- [ ] In-app updater
- [ ] Shell integration and autostart registration
- [ ] Single instance
- [ ] Accessibility audit
- [ ] Internationalization
- [ ] Release tooling pointed at the workspace

## Phase 6: upgrade rehearsal and 4.0

- [ ] 3.x to 4.x update rehearsed on each OS and channel
- [ ] Alpha, then beta, then stable
- [ ] Remove `src/`, `src-tauri/` and the npm toolchain

## Upgrade contract (3.2.x to 4.x, no 3.x changes)

4.x keeps these identical so the 3.x updater and the stores accept it:

- Bundle identifier `run.rosie.iyeris`, product name, NSIS per-user install location and uninstall
  key, MSIX identity, Flatpak app id, macOS signing team.
- Updater manifests named `latest-<os>[-beta]-<arch>.json` with the current platform keys, as
  `scripts/gpg-sign.js` generates them, signed with the existing minisign key (`FC764C3FA4D05D63`).
- Artifact formats the 3.x updater installs: NSIS `.exe` that accepts the updater's silent flags,
  `.app.tar.gz`, AppImage, deb, rpm, MSI.
- No self-update in Flatpak, Microsoft Store, Mac App Store and MSI builds.
- The `--iyeris-elevated-transfer` re-exec entry point and the `--minimized` autostart argument.

On first run, 4.x:

- Imports `settings.json` and `home-settings.json` into 4.x files with a `schemaVersion`. The 3.x
  files stay untouched, so reinstalling 3.2.x still works.
- Reads and drains `transfer-recovery/journal.json` (version 1).
- Discards and rebuilds `file-index.json` and the thumbnail cache.
- Re-registers shell integration (Windows HKCU verbs, macOS Services workflow, KDE and Nautilus
  entries) and autostart, because they store the old executable path.
- Removes leftover WebView data directories.

Every 3.x install is offered 4.x as soon as a 4.x release carries the legacy manifest names.
4.x pre-releases therefore publish only the `-beta` manifest names until 4.0 stable.
