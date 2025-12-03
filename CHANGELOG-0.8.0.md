# IYERIS v0.8.0 Changes

## New Features

### Column View Mode
- Added new "Column" view mode (macOS Finder-style navigation)
- Grid → List → Column view cycle
- Column panes with folder drilling navigation
- Drive column for Windows root navigation

### Breadcrumb Navigation
- Clickable breadcrumb path segments in address bar
- Click segment to navigate to that directory
- Click address bar to toggle between breadcrumb/text input mode
- Auto-updates on directory change

### File Properties Enhancements
- Folder size calculation with progress indicator
- Cancellable folder size calculations
- MD5 and SHA256 checksum calculation for files
- Checksum progress indicator
- Cancellable checksum calculations

## Changes

### Auto-Updater
- Beta builds use separate update channel
- Added version comparison to prevent downgrades
- Beta vs stable update filtering
- Different UI messaging for beta vs release update checks
