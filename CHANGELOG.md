> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                      | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS                 | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                                         |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EXE:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Win-x64.exe) / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Win-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-x86_64.AppImage) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-arm64.AppImage) --> |
| <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>                     | **[Universal ZIP](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-MacOS-universal.zip)** | **DEB:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-amd64.deb) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-arm64.deb) -->                 |
|                                                                                                                                                                                                                    |                                                                                                                         | **RPM:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-x86_64.rpm) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-aarch64.rpm) -->              |
|                                                                                                                                                                                                                    |                                                                                                                         | **Flatpak:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-x86_64.flatpak) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.0-beta.6/IYERIS-Linux-aarch64.flatpak) -->  |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
>
> ⚠️ Arm64 Linux Binaries are NOT available at the moment. Its something I may get around to
> in the future but its not a priority. However, I do have the logic setup in the repo
> in-case people would like to build their own :)

### ℹ️ Enjoying IYERIS? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

### RC3 hardening pass

This build focuses on stale-state cleanup, file-operation cancellation, and more
headless regression coverage before stable.

## Changes in `v3.0.0-beta.6 (RC3):`

- **Codebase:** Hardened copy and move cancellation so queued cancels register before the file-operation lock is acquired, recursive directory copies can stop mid-flight, and partial copies clean up correctly on failure.
- **Codebase:** Tightened thumbnail caching and clipboard plumbing so modified files do not serve stale thumbnails and clipboard reads fail closed instead of blocking startup.
- **UI:** Cleared stale state across drag/drop, tabs, previews, command palette, bookmarks, batch rename, theme saving, and native integration status so failed actions recover cleanly instead of leaving the UI highlighted, disabled, or out of sync.
- **Testing:** Added regression coverage for the new cancellation, rollback, and stale-state paths, and expanded headless coverage to 2,875 tests across 110 files.

## Changes in `v3.0.0-beta.5 (RC2):`

- **Codebase:** Misc and general fixes in prep for STABLE v3.

## Changes in `v3.0.0-beta.4 (RC1):`

### Release Candidate 1

This is the first Release Candidate for IYERIS `v3.0.0`. The app is stable and feature-complete for `v3`. The main remaining item before stable is runtime validation of the new Windows Snap Layouts behavior below — everything else is signed off.

- **NEW - Windows 11 Snap Layouts:** Implemented native Snap Layouts support for the custom titlebar on Windows without any third-party plugin. A transparent native Win32 overlay sits over the maximize button and returns the correct OS hit-test code (`HTMAXBUTTON`), so hovering the maximize button now shows the Windows 11 Snap flyout. Click still toggles maximize/restore as expected.
- **Security:** Fixed an issue where the clipboard operation queue could recurse infinitely during rapid concurrent copy/paste cycles.
- **Security:** Added an extraction size limit to protect against zip-bomb archives consuming excessive disk space.
- **Security:** Hardened git status and branch checks to block malicious `core.fsmonitor` and `core.hooksPath` overrides in untrusted repositories from executing arbitrary code.
- **Security:** Added sensitive-path guards to content-search and file-checksum operations.
- **Codebase:** Added Zod-based IPC schema validation (`validateIpc()`) at all major frontend/backend boundaries — `FileItem`, `DriveInfo`, `ItemProperties`, `SearchResult`, `ArchiveEntry`, `FolderSize`, `DuplicateGroup`, and `GitStatus` — catching malformed data at the edge.
- **Codebase:** Added `src/i18n.ts`, an internationalization framework with `t()`, `{placeholder}` interpolation, and `singular|plural` pluralization for future localization support. Status bar, toast, and clipboard strings are migrated. Full string localization is deferred post-`v3.0.0`.
- **Codebase:** Refactored `renderer.ts` into focused controller modules (`rendererDualPane`, `rendererStatusBar`, `rendererRecentFiles`, `rendererSidebar`) to improve long-term maintainability.
- **Windows:** Moved file copy and move operations to a dedicated thread pool to prevent blocking the async runtime during large transfers.
- **UI:** Fixed an issue where file items did not reflect their selection state on initial render in grid and list view.
- **Testing:** Expanded test coverage to 2,813 tests across 97 files.
- **PKG:** Updated packages.

## Changes in `v3.0.0-beta.3:`

- **UI:** Fixed UI/UX to be more inline with native HIG (Human Interface Guidelines).

## Changes in `v3.0.0-beta.2:`

- **UI:** Fixed an issue with the resize area for the quick access panel.
- **Codebase:** Main new UI file has been renamed to `ui3.css`. Name pending.
- **Copy/Move:** Copy and move now accept frontend operation IDs can can be cancelled from file queue.
- **File actions:** Improvements to Paste, drag/drop, duplicate, select, and duplicated finder.
- **Queue:** Queue now shows ETA and cancel, retry, and fail state recovery.
- **Misc:** General fixes and improvements.

## Changes in `v3.0.0-beta.1:`

### Version 3 Its Here!!

Hello everyone! From IYERIS V1 -> V2 we saw a dramatic back and front end change. From a basic skeleton UI, to a full working electron version of IYERIS in V1, to a much more lightweight Tauri V2 version in V2 with better UI/UX, to now an even better and professional UI in V3 using Lucide Icons instead of twemoji. These drastic UI changes and more new features (see below) have constituted a major version instead of the previous `v2.2.0` beta version number I was previously using. It may not be a complete feature list since it's a beta, but it's a good portion of what to expect in the final release!

- **NEW - Dual Pane Mode:**
  - Added an optional second file pane with pane switching, browse/sync/open controls, copy/move to the other pane, pane-aware search, secondary-pane selection, thumbnails, and drag/drop workflows.
  - Refined context-menu behavior for multi-selection, submenu focus, disabled items, recent copy/move destinations, empty-space actions, and keyboard navigation.
- **NEW - Native SwiftUI-Like Redesign:**
  - Completely redesigned the user interface to mimic a high-end native SwiftUI-like experience, with border spacing and color contrast fixes.
  - Fully replaced Twemoji with modern, professional **Lucide Icons** across the interface.
  - Refined explorer chrome, context menus, progress panel, toolbar groups, status bar, and active-pane indicators for a denser native-feeling layout.
  - Implemented visual and functional "Liquid Glass" styling, resolving various layout spacing and contrast issues.
  - Blended application container elements, ensuring paddings, margins, and borders dock seamlessly with native windows.
- **NEW - OS Shell Integration:**
  - Added installable _Open in IYERIS_ entries for Windows and Linux file managers (Explorer, KDE, Nautilus).
  - Supported opening paths passed from native shell integrations and single-instance launches.
  - Improved home drive detection and native file-manager integration entries.
  - Improved symlink error handling and messages on Windows (when Admin privileges or Developer Mode are required).
- **NEW - Operation Queue:**
  - Added a collapsible operation queue panel that tracks copy, move, compress, extract, and checksum progress, with cancellation support where the backend allows.
- **Security & Stability Audits:**
  - Completed a comprehensive pre-release security audit pass: tightened Tauri capability scoping, asset-scope deny lists for sensitive paths (e.g., SSH keys, Kubernetes/Docker configs, AWS configs, `.netrc`), and Content Security Policy (CSP) directives.
  - Hardened clipboard, paste, watcher, directory listing, Git status, search, thumbnail, archive, and file-operation paths to reduce hangs, stale state, duplicate paste attempts, and crashy edge cases.
  - Added cargo audit and npm audit checks to CI and release-gate workflows.
  - Implemented an ESLint `no-restricted-syntax` rule to prevent unsafe `innerHTML` usage with template literals; reviewed and annotated all 75 existing frontend sites.
  - Tightened archive extraction limits, thumbnail cache limits, and regex search bounds.
  - Fixed an issue where Office document thumbnails (`.docx`, `.xlsx`, `.pptx`) were never shown due to regex backreference incompatibility in Rust.
- **Testing & Infrastructure:**
  - Significantly expanded backend headless and frontend testing coverage, including tests for the operation queue, thumbnails, typeahead, context menus, event listeners, compression/extraction, and renderer flows.
  - Updated Tauri API and CLI packages to `v2.11.0`.
  - Upgraded packages and overall codebase dependencies.

## Changes in `v2.1.0:`

- **Thumbnails:** Added more thumbnail file support and fixed some issues where certain video files wouldn't preview.
- **... More actions button:** Fixed an issue where the more actions button was rendering its content out of view.
- **Licenses:** Added cargo licenses to the license credits in `Settings` > `About`.
- **Testing:** Added a lot more back-end headless testing for IYERIS.
- **Updater:** Added new information for beta users if they check for updates and the updater does not find the JSON Manifest for betas.
  - This is usually because when I release a new STABLE version of IYERIS, I will then release an accompanying beta for IYERIS so that the beta JSONS sync up with the repos `/releases/latest`.
  - **Typescript:** Updated to Typescript V6.
- **PKG:** Updated Packages.

## Click below for the full `v2` Changelog

<details>
  <summary>FULL V2 CHANGELOG</summary>

## Changes in `v2.1.2:`

- **PKG:** Updated packages.

## Changes in `v2.1.1:`

### MANUAL UPDATE REQUIRED FOR THIS VERSION.

Hi everyone sorry for the need to download the installer and run it instead of using the in-app updater for this release. The reason for this was that I accidentally comitted an encrypted private key to one of my other Tauri V2 projects on github. This app was NOT affected by the exposure of that key, IYERIS's updater signatures were not signed by that key ever.
As a precautionary measure and also due to my new protocols after this really dumb-on-my-part incident, I have also rotated IYERIS's keys as well, requiring a one-time manual update. Im sorry for this :(

- **PKG:** Updated packages.
- **Testing:** Added much more testing coverage to IYERIS.

</details>

---

---

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are fully signed. Windows releases are not signed by an org, but are signed by my GPG signature (same with Linux).
- **Legacy Binaries:** Separate x64/arm64 Windows binaries are deprecated in favor of the Universal installer. They are still listed in the downloads section, but the universal installer is recommended for simplicity.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
