> [!NOTE]
> 🅱️ This is a Beta build.

---

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                  | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS         | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                                 |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Win-x64.exe) / [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Win-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-x86_64.AppImage) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-arm64.AppImage)--> |
| <div align="center"><a href="https://apps.microsoft.com/detail/9pkgd6lkcl5j?referrer=appbadge&mode=full"><img src="https://get.microsoft.com/images/en-us%20light.svg" width="150"/></a></div>                     | **[Universal ZIP](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-MacOS-universal.zip)** | **DEB:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-amd64.deb) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-arm64.deb)-->                 |
| _See MSI note below_                                                                                                                                                                                               |                                                                                                                         | **RPM:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-x86_64.rpm) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-aarch64.rpm)-->              |
|                                                                                                                                                                                                                    |                                                                                                                         | **Flatpak:** [x64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-x86_64.flatpak) <!--/ [arm64](https://github.com/BurntToasters/IYERIS/releases/download/v2.2.0-beta.5/IYERIS-Linux-aarch64.flatpak)-->  |

### ℹ️ Enjoying IYERIS? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

### Please checkout the readme for more info on IYERIS!

## Changes in `v2.2.0-beta.6 [RC2]:`

- **NEW - Lucide Icons:** Twemoji has been fully replaced for a much more professonal looking icon sceme: Lucide Icons.

## Changes in `v2.2.0-beta.5 [RC]:`

- **UI: Multiple Fixes**
  - Fixed issues with color contrast with WebView2 (Windows).
  - Fixed an issue where the main sidebar and the settings sidebar did not have rounded padding.
  - Removed dead UI code.
  - More improvements to the UI including more "Liquid Glass" fixes.
- **Codebase:** More stabilization to the codebase.
- **Open In IYERIS:** Fixed multiple stability issues with the opt-in open in IYERIS setting.
- **PKG:** Updated packages.

## Changes in `v2.2.0-beta.4:`

- **Security:** Completed a full pre-release security audit pass. Tightened Tauri capability scoping, asset-scope deny lists for sensitive paths, and CSP directives.
  - Added an ESLint `no-restricted-syntax` rule to catch future unreviewed `innerHTML` + template-literal patterns; reviewed and annotated all 75 existing sites across the frontend.
- **Thumbnails:** Fixed an issue where Office document thumbnails (`.docx`, `.xlsx`, `.pptx`) were never shown. The XML attribute regex used a backreference that Rust's `regex` crate does not support, causing extraction to silently always return nothing.
- **Testing:** Added `cargo audit` and `npm audit --production` checks to both the CI workflow (runs on every PR and push) and the release-gate workflow.
- **Codebase:** Added `audit.toml` documenting 18 transitive advisories from Tauri, gtk-rs, and notify that cannot be resolved without upstream changes. Applied Clippy idiom improvements to the Rust backend.
- **PKG:** Updated packages.
- **UI:** Fixed a UI regression from beta 3 where the background colors were washed out.

## Changes in `v2.2.0-beta.3:`

- **UI:** NEW UI! IYERIS's UI has been improved once again to more closely mimic a "SWIFTUI-Like" UI.
- **PKG:** Updated packages.

## Changes in `v2.2.0-beta.2:`

- **NEW - Dual Pane Mode:** Added an optional second file pane with pane switching, browse/sync/open controls, copy and move to the other pane, pane-aware search, secondary-pane selection, thumbnails, and drag/drop workflows.
- **NEW - Native Integration:** Added installable Open in IYERIS entries for Windows and Linux file managers, plus support for opening paths passed from native shell integrations and single-instance launches.
- **NEW - Operation Queue:** Added a collapsible operation queue panel that tracks copy, move, compress, extract, and checksum progress, with cancellation where the backend supports it.
- **UI:** Refined the explorer chrome, context menus, progress panel, toolbar groups, status bar, and active-pane indicators for a denser native-feeling layout.
- **UI:** Improved context-menu behavior for multi-selection, submenu focus, disabled items, recent copy/move destinations, empty-space actions, and keyboard navigation.
- **Stability:** Hardened clipboard, paste, watcher, directory listing, Git status, search, thumbnail, archive, and file-operation paths to reduce hangs, stale state, duplicate paste attempts, and crashy edge cases.
- **Security:** Tightened archive extraction limits, thumbnail cache limits, regex search bounds, and Tauri asset-scope exclusions for sensitive paths such as SSH keys, Docker/Kubernetes config, AWS config, and `.netrc`.
- **Windows:** Improved symlink error messages when Administrator privileges or Developer Mode are required.
- **Linux:** Improved home drive detection and native file-manager integration entries for KDE and Nautilus.
- **Testing:** Added and updated coverage for the operation queue, thumbnails, typeahead, context menus, event listeners, compression/extraction, and renderer flows.
- **Codebase:** Added GitHub issue and pull-request templates, refreshed build documentation, and added a production audit script.
- **Tauri:** Updated Tauri API and CLI packages to `v2.11.0`.
- **PKG:** Updated packages.

## Changes in `v2.2.0-beta.1:`

_Beta 1 Releases of IYERIS don't include any changes besides pkg updates, and are meant to sync beta users to the latest STABLE._

- **Ver:** Bumped version to `v2.2.0`.
- **PKG:** Updated packages.

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

### MSI Installer Support (MSI builds are NOT provided for betas)

> [!IMPORTANT]
> **Enterprise Users:** We now support Windows X64/ARM64 `.MSI` installers for MDM/AD deployment.
>
> - **.MSI installers do NOT support auto-updates.** You must deploy the new MSI manually.
> - These are strictly for enterprise management; standard users should use the **EXE** above.
> - _Files available in the "Assets" dropdown below._

---

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)
- **Code Signing:** macOS releases are fully signed. Windows releases are not signed by an org, but are signed by my GPG signature (same with Linux).
- **Legacy Binaries:** Separate x64/arm64 Windows binaries are deprecated in favor of the Universal installer. They are still listed in the downloads section, but the universal installer is recommended for simplicity.

### This changelog is made using the BCLS standard: https://github.com/BurntToasters/BCLS
