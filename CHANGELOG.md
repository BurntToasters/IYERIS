# Changelog

All notable changes to IYERIS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Recent files tracking in sidebar
- Folder statistics in Properties modal (file type breakdown)
- Image thumbnails in list view mode
- CHANGELOG.md for tracking project history

### Changed
- Improved type safety throughout codebase
- Better null checking for window and indexer references

### Fixed
- Various type safety improvements

---

## [0.9.0-beta.1] - 2024-12-26

### Added
- Custom theme editor with live preview
- Theme presets (Midnight Blue, Forest Green, Sunset Orange, Lavender Purple, Rose Pink, Ocean Teal)
- Folder size calculation in Properties modal with progress indicator
- File checksum calculation (MD5, SHA256) in Properties modal
- Archive operations panel showing compress/extract progress
- Support for multiple archive formats (ZIP, 7Z, TAR, TAR.GZ)
- Archive operation cancellation support
- Zoom controls with popup indicator (Ctrl+/-, Ctrl+0 to reset)
- Power management integration (pause indexer on sleep, resume on wake)
- System resume detection with automatic refresh
- Support popup for first-time users (appears on second launch)
- Global search mode (Ctrl+Shift+F) to search all indexed files
- Search scope toggle between local and global search
- Directory history dropdown in address bar
- Search history dropdown with recent searches

### Changed
- Improved breadcrumb navigation with click-to-navigate
- Enhanced file indexer with background initialization
- Better cross-window clipboard synchronization
- Improved drag-and-drop between windows
- Updated Electron to version 39.0.0
- Updated TypeScript to version 5.9.3

### Fixed
- MS Store specific bug fixes and improvements
- Column view display issues
- Various security improvements (XSS prevention)
- macOS-specific bug fixes
- Better error handling throughout

### Security
- Enhanced XSS prevention with HTML escaping
- Path validation with null-byte checking
- URL scheme whitelisting (http, https, mailto, file only)
- Safe window communication checks
- Restricted access to sensitive system paths on Windows

---

## [0.8.7] - 2024-12-15

### Fixed
- Microsoft Store integration fixes
- Version bump for store release

---

## [0.8.6] - 2024-12-10

### Added
- New build arguments for improved builds

### Fixed
- Various bug fixes
- TypeScript updates
- MS Store specific bugfixes

---

## [0.8.5] - 2024-12-05

### Added
- App Store integrations

### Fixed
- Column view fixes

---

## [0.8.4] - 2024-12-01

### Security
- Security improvements for XSS prevention

---

## [0.8.3] - 2024-11-25

### Changed
- Updated Flatpak SDK

### Fixed
- macOS bug fixes
- Performance optimizations

---

## [0.8.2] - 2024-11-20

### Added
- Initial release candidate features

---

## [0.8.0] - 2024-11-01

### Added
- File indexing for fast search
- Undo/Redo support for file operations (50-item stack)
- Trash integration (move to trash instead of permanent delete)
- Archive compression and extraction support
- QuickLook preview (press Space on selected file)
- Preview panel with support for images, text, audio, video, PDF
- Multiple view modes (Grid, List, Column)
- Bookmarks system for favorite folders
- Custom themes with transparency/glassmorphism effects
- Start on login option with minimize to tray
- Auto-updater with beta channel support
- Terminal integration (open folder in terminal)
- Multi-window support
- Cross-platform support (Windows, macOS, Linux)
- Flatpak, MSI, NSIS, DMG, AppImage, DEB, RPM package support

### Changed
- Complete UI overhaul with liquid-glass design
- Improved keyboard shortcuts

---

## [0.7.0] - 2024-10-01

### Added
- Initial public release
- Basic file browsing functionality
- File operations (copy, cut, paste, delete, rename)
- Navigation history (back, forward, up)
- Address bar with path input
- File search within current directory
- Settings persistence
- Multiple color themes (Charcoal, Cobalt, Light)

---

[Unreleased]: https://github.com/BurntToasters/IYERIS/compare/v0.9.0-beta.1...HEAD
[0.9.0-beta.1]: https://github.com/BurntToasters/IYERIS/compare/v0.8.7...v0.9.0-beta.1
[0.8.7]: https://github.com/BurntToasters/IYERIS/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/BurntToasters/IYERIS/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/BurntToasters/IYERIS/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/BurntToasters/IYERIS/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/BurntToasters/IYERIS/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/BurntToasters/IYERIS/compare/v0.8.0...v0.8.2
[0.8.0]: https://github.com/BurntToasters/IYERIS/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/BurntToasters/IYERIS/releases/tag/v0.7.0
