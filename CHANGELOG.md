<!-- > [!NOTE]
> 🅱️ This is a Beta build. -->

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                        | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS          | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux                                                                                                                           |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Win-x64.exe) / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Win-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-x86_64.AppImage) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-arm64.AppImage) --> |
| <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>       | **[Universal ZIP](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-MacOS-universal.zip)** | **DEB:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-amd64.deb) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-arm64.deb) -->                 |
|                                                                                                                                                                                                      |                                                                                                                  | **RPM:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-x86_64.rpm) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-aarch64.rpm) -->              |
|                                                                                                                                                                                                      |                                                                                                                  | **Flatpak:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-x86_64.flatpak) <!-- / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.3/IYERIS-Linux-aarch64.flatpak) -->  |

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

## Changes in `v3.0.3:`

- **Light mode:** Major fixes in readability have been done to the UI for light mode.
  - Previous issues like Invisible buttons, hard-to-ready areas, and inconsistent applications were happening to the lightmode ui. This has now been addressed with this release :)
- **PKG:** Updated packages.

## Changes in `v3.0.0:`

### Version 3 - Its Here!!

Hello everyone! From IYERIS V1 -> V2 we saw a dramatic back and front end change. From a basic skeleton UI, to a full working electron version of IYERIS in V1, to a much more lightweight Tauri V2 version in V2 with better UI/UX, to now an even better and professional UI in V3 using Lucide Icons instead of twemoji. These drastic UI changes and more new features (see below) have constituted a major version instead of the previous `v2.2.0` beta version number I was previously using.

- **Codebase:** Pending settings changes now flush on tab hide, `pagehide`, and unload so debounced toggles are less likely to be lost on abrupt exit.
- **Security:** Migrated 7z support from unmaintained `sevenz-rust` to `sevenz-rust2`, including updated third-party license credits.
- **UI:** Cleared stale state across drag/drop, tabs, previews, command palette, bookmarks, batch rename, theme saving, and native integration status so failed actions recover cleanly instead of leaving the UI highlighted, disabled, or out of sync.
- **Windows:** Moved file copy and move operations to a dedicated thread pool to prevent blocking the async runtime during large transfers.
- **UI:** Matched paste-in animations across app-internal copy/cut paste, paste-into-folder, and system clipboard paste flows.
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

## Click below for the full `v3` Changelog

<details>
  <summary>FULL V3 CHANGELOG</summary>

Nothing yet!

</details>

---

---

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are signed and notarized. Windows binaries are Authenticode-signed with Azure Artifact Signing. Linux release files include GPG signatures.
- **Windows Binaries:** Windows installers are published separately for x64 and arm64; choose the installer matching your system architecture.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
