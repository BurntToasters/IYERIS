import type { Settings } from './types';
import { formatFileSize } from './rendererFileIcons.js';
import { isWindowsPath } from './rendererUtils.js';
import { ignoreError } from './shared.js';

type UtilityDrawerConfig = {
  getCurrentSettings: () => Settings;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<unknown>;
  showToast: (message: string, title: string, type: 'success' | 'info' | 'error') => void;
};

export function createUtilityDrawerController(config: UtilityDrawerConfig) {
  const AUTO_CHECKSUM_MAX_BYTES = 50 * 1024 * 1024;
  let activeItemPath: string | null = null;
  let activeItemSize: number | null = null;
  let isDirectory = false;
  let currentFileMode = 0;
  let platformOS = '';
  let inProgressChecksumId: string | null = null;
  let selectionRequestId = 0;

  // Cache elements
  const drawerEl = document.getElementById('utility-drawer');
  const headerEl = document.getElementById('utility-drawer-header');
  const toggleBtn = document.getElementById('utility-drawer-toggle-btn');
  const bodyEl = document.getElementById('utility-drawer-body');
  const statusEl = document.getElementById('utility-drawer-status');

  // Metadata elements
  const metaPathEl = document.getElementById('utility-meta-path');
  const metaSizeEl = document.getElementById('utility-meta-size');
  const copyPathBtn = document.getElementById('utility-copy-path-btn');
  const copyNameBtn = document.getElementById('utility-copy-name-btn');
  const copyUriBtn = document.getElementById('utility-copy-uri-btn');

  // Permissions placeholders & panels
  const posixWrapper = document.getElementById('utility-posix-perms');
  const winWrapper = document.getElementById('utility-win-attrs');
  const placeholderEl = document.getElementById('utility-no-perms-placeholder');

  // POSIX checkboxes
  const permCheckboxes = {
    ur: document.getElementById('perm-ur') as HTMLInputElement | null,
    uw: document.getElementById('perm-uw') as HTMLInputElement | null,
    ux: document.getElementById('perm-ux') as HTMLInputElement | null,
    gr: document.getElementById('perm-gr') as HTMLInputElement | null,
    gw: document.getElementById('perm-gw') as HTMLInputElement | null,
    gx: document.getElementById('perm-gx') as HTMLInputElement | null,
    or: document.getElementById('perm-or') as HTMLInputElement | null,
    ow: document.getElementById('perm-ow') as HTMLInputElement | null,
    ox: document.getElementById('perm-ox') as HTMLInputElement | null,
  };
  const octalInput = document.getElementById('posix-octal-input') as HTMLInputElement | null;
  const applyPosixBtn = document.getElementById('utility-apply-posix-btn');

  // Windows attributes
  const winCheckboxes = {
    readonly: document.getElementById('attr-readonly') as HTMLInputElement | null,
    hidden: document.getElementById('attr-hidden') as HTMLInputElement | null,
    system: document.getElementById('attr-system') as HTMLInputElement | null,
  };
  const applyWinBtn = document.getElementById('utility-apply-win-btn');

  // Checksum elements
  const checksumAlgoSelect = document.getElementById(
    'utility-checksum-algo'
  ) as HTMLSelectElement | null;
  const calcChecksumBtn = document.getElementById(
    'utility-calc-checksum-btn'
  ) as HTMLButtonElement | null;
  const checksumValueArea = document.getElementById(
    'utility-checksum-value'
  ) as HTMLTextAreaElement | null;
  const copyChecksumBtn = document.getElementById(
    'utility-copy-checksum-btn'
  ) as HTMLButtonElement | null;

  function init(): void {
    if (!drawerEl || !headerEl) return;

    // Detect platform OS early
    window.tauriAPI
      .getPlatform()
      .then((os) => {
        platformOS = os.toLowerCase();
      })
      .catch(ignoreError);

    // Initial expanded/collapsed state from settings
    const settings = config.getCurrentSettings();
    const isCollapsed = settings.utilityDrawerCollapsed !== false;
    setCollapsedState(isCollapsed);

    if (checksumAlgoSelect) {
      checksumAlgoSelect.value = settings.defaultChecksumAlgorithm || 'sha256';
    }

    // Bind Expand/Collapse click events
    headerEl.addEventListener('click', (e) => {
      // Prevent collapse if clicking the chevron button or inside header buttons
      if ((e.target as HTMLElement).closest('.utility-drawer-toggle-btn')) return;
      toggleDrawer();
    });

    toggleBtn?.addEventListener('click', toggleDrawer);

    // Bind path copy buttons
    copyPathBtn?.addEventListener('click', () => {
      if (activeItemPath) {
        window.tauriAPI
          .writeToSystemClipboard(activeItemPath)
          .then(() => config.showToast('Path copied to clipboard', 'Success', 'success'))
          .catch((err) => config.showToast(String(err), 'Error', 'error'));
      }
    });

    copyNameBtn?.addEventListener('click', () => {
      if (activeItemPath) {
        const parts = activeItemPath.split(/[\\/]/);
        const name = parts[parts.length - 1] || activeItemPath;
        window.tauriAPI
          .writeToSystemClipboard(name)
          .then(() => config.showToast('Filename copied to clipboard', 'Success', 'success'))
          .catch((err) => config.showToast(String(err), 'Error', 'error'));
      }
    });

    copyUriBtn?.addEventListener('click', () => {
      if (activeItemPath) {
        const uri = toFileUri(activeItemPath);
        window.tauriAPI
          .writeToSystemClipboard(uri)
          .then(() => config.showToast('File URI copied to clipboard', 'Success', 'success'))
          .catch((err) => config.showToast(String(err), 'Error', 'error'));
      }
    });

    // POSIX permissions check sync
    Object.values(permCheckboxes).forEach((chk) => {
      chk?.addEventListener('change', updateOctalFromCheckboxes);
    });

    octalInput?.addEventListener('input', updateCheckboxesFromOctal);

    applyPosixBtn?.addEventListener('click', applyPosixPermissions);
    applyWinBtn?.addEventListener('click', applyWindowsAttributes);

    // Checksum calculator bindings
    calcChecksumBtn?.addEventListener('click', triggerManualChecksum);
    checksumAlgoSelect?.addEventListener('change', () => {
      // Re-trigger auto-checksum if selection changes and auto-calc is allowed
      if (activeItemPath && !isDirectory) {
        const settings = config.getCurrentSettings();
        if (settings.enableAutoChecksum !== false && metaSizeEl) {
          triggerAutoChecksum();
        }
      }
    });

    copyChecksumBtn?.addEventListener('click', () => {
      if (checksumValueArea && checksumValueArea.value) {
        window.tauriAPI
          .writeToSystemClipboard(checksumValueArea.value)
          .then(() => config.showToast('Checksum hash copied', 'Success', 'success'))
          .catch((err) => config.showToast(String(err), 'Error', 'error'));
      }
    });

    // Listen to background checksum progress changes
    window.tauriAPI.onChecksumProgress((progress) => {
      if (inProgressChecksumId && progress.operationId === inProgressChecksumId) {
        if (checksumValueArea) {
          checksumValueArea.value = `Calculating... ${progress.percent}%`;
        }
      }
    });

    // Make drawer visible
    drawerEl.style.display = 'flex';
  }

  function setCollapsedState(collapsed: boolean): void {
    if (!drawerEl || !bodyEl) return;
    if (collapsed) {
      drawerEl.classList.add('collapsed');
      bodyEl.style.display = 'none';
      toggleBtn?.setAttribute('aria-expanded', 'false');
    } else {
      drawerEl.classList.remove('collapsed');
      bodyEl.style.display = 'flex';
      toggleBtn?.setAttribute('aria-expanded', 'true');
    }
  }

  function toggleDrawer(): void {
    const settings = config.getCurrentSettings();
    const nextState = !drawerEl?.classList.contains('collapsed');
    settings.utilityDrawerCollapsed = nextState;
    setCollapsedState(nextState);
    config.saveSettingsWithTimestamp(settings).catch(ignoreError);
  }

  // Update selection bindings
  function updateSelection(itemPath: string | null): void {
    activeItemPath = itemPath;
    activeItemSize = null;
    isDirectory = false;
    const requestId = ++selectionRequestId;

    // Reset status fields
    if (inProgressChecksumId) {
      window.tauriAPI.cancelChecksumCalculation(inProgressChecksumId).catch(ignoreError);
      inProgressChecksumId = null;
    }

    if (!itemPath) {
      // Clear selection states
      if (statusEl) statusEl.textContent = 'No selection';
      if (metaPathEl) metaPathEl.textContent = '-';
      if (metaSizeEl) metaSizeEl.textContent = '-';

      // Disable all action buttons
      toggleButtonsState(true);

      // Hide all panels & show placeholders
      if (posixWrapper) posixWrapper.style.display = 'none';
      if (winWrapper) winWrapper.style.display = 'none';
      if (placeholderEl) placeholderEl.style.display = 'flex';
      if (checksumValueArea) checksumValueArea.value = '';

      return;
    }

    // Single item is selected
    const parts = itemPath.split(/[\\/]/);
    const filename = parts[parts.length - 1] || itemPath;
    if (statusEl) statusEl.textContent = `Selected: ${filename}`;
    if (metaPathEl) metaPathEl.textContent = itemPath;

    // Enable path utility actions
    toggleButtonsState(false);

    // Call properties query
    window.tauriAPI
      .getItemProperties(itemPath)
      .then((res) => {
        if (requestId !== selectionRequestId || activeItemPath !== itemPath) return;
        if (res.success && res.properties) {
          const props = res.properties;
          activeItemSize = props.size;
          isDirectory = props.isDirectory;

          // Size Formatting
          if (metaSizeEl) {
            metaSizeEl.textContent = props.isDirectory ? 'Folder' : formatFileSize(props.size);
          }

          // Checksum visibility
          if (props.isDirectory) {
            if (calcChecksumBtn) calcChecksumBtn.disabled = true;
            if (checksumAlgoSelect) checksumAlgoSelect.disabled = true;
            if (checksumValueArea) {
              checksumValueArea.value = 'Not applicable for folders';
            }
            if (copyChecksumBtn) copyChecksumBtn.disabled = true;
          } else {
            if (calcChecksumBtn) calcChecksumBtn.disabled = false;
            if (checksumAlgoSelect) checksumAlgoSelect.disabled = false;
            if (checksumValueArea) checksumValueArea.value = '';
            if (copyChecksumBtn) copyChecksumBtn.disabled = true;

            // Trigger Auto Checksum calculation if size permits
            const settings = config.getCurrentSettings();
            if (settings.enableAutoChecksum !== false && props.size < AUTO_CHECKSUM_MAX_BYTES) {
              triggerAutoChecksum(itemPath);
            }
          }

          // Render Platform Permissions
          if (placeholderEl) placeholderEl.style.display = 'none';
          if (isWindowsPlatform(itemPath)) {
            if (posixWrapper) posixWrapper.style.display = 'none';
            if (winWrapper) winWrapper.style.display = 'flex';

            // Set Windows checkboxes
            if (winCheckboxes.readonly) winCheckboxes.readonly.checked = !!props.isReadOnly;
            if (winCheckboxes.hidden) winCheckboxes.hidden.checked = !!props.isHiddenAttr;
            if (winCheckboxes.system) winCheckboxes.system.checked = !!props.isSystemAttr;
          } else {
            if (winWrapper) winWrapper.style.display = 'none';
            if (posixWrapper) posixWrapper.style.display = 'flex';

            // Render POSIX checks from bitmask Mode
            currentFileMode = props.mode || 0;
            renderPOSIXCheckboxes(currentFileMode);
          }
        }
      })
      .catch((err) => {
        if (requestId !== selectionRequestId || activeItemPath !== itemPath) return;
        if (statusEl) statusEl.textContent = `Failed to read selection details`;
        console.error('[UtilityDrawer] getItemProperties failed:', err);
      });
  }

  function toggleButtonsState(disabled: boolean): void {
    if (copyPathBtn) (copyPathBtn as HTMLButtonElement).disabled = disabled;
    if (copyNameBtn) (copyNameBtn as HTMLButtonElement).disabled = disabled;
    if (copyUriBtn) (copyUriBtn as HTMLButtonElement).disabled = disabled;
    if (calcChecksumBtn) calcChecksumBtn.disabled = disabled;
    if (checksumAlgoSelect) checksumAlgoSelect.disabled = disabled;
    if (copyChecksumBtn) copyChecksumBtn.disabled = disabled;
  }

  // POSIX Permissions management
  function renderPOSIXCheckboxes(mode: number): void {
    if (permCheckboxes.ur) permCheckboxes.ur.checked = (mode & 0o400) !== 0;
    if (permCheckboxes.uw) permCheckboxes.uw.checked = (mode & 0o200) !== 0;
    if (permCheckboxes.ux) permCheckboxes.ux.checked = (mode & 0o100) !== 0;

    if (permCheckboxes.gr) permCheckboxes.gr.checked = (mode & 0o040) !== 0;
    if (permCheckboxes.gw) permCheckboxes.gw.checked = (mode & 0o020) !== 0;
    if (permCheckboxes.gx) permCheckboxes.gx.checked = (mode & 0o010) !== 0;

    if (permCheckboxes.or) permCheckboxes.or.checked = (mode & 0o004) !== 0;
    if (permCheckboxes.ow) permCheckboxes.ow.checked = (mode & 0o002) !== 0;
    if (permCheckboxes.ox) permCheckboxes.ox.checked = (mode & 0o001) !== 0;

    if (octalInput) {
      octalInput.value = (mode & 0o777).toString(8).padStart(3, '0');
    }
  }

  function updateOctalFromCheckboxes(): void {
    let mode = 0;
    if (permCheckboxes.ur?.checked) mode |= 0o400;
    if (permCheckboxes.uw?.checked) mode |= 0o200;
    if (permCheckboxes.ux?.checked) mode |= 0o100;

    if (permCheckboxes.gr?.checked) mode |= 0o040;
    if (permCheckboxes.gw?.checked) mode |= 0o020;
    if (permCheckboxes.gx?.checked) mode |= 0o010;

    if (permCheckboxes.or?.checked) mode |= 0o004;
    if (permCheckboxes.ow?.checked) mode |= 0o002;
    if (permCheckboxes.ox?.checked) mode |= 0o001;

    currentFileMode = mode;
    if (octalInput) {
      octalInput.value = mode.toString(8).padStart(3, '0');
    }
  }

  function updateCheckboxesFromOctal(): void {
    if (!octalInput) return;
    const value = octalInput.value.trim();
    if (!/^[0-7]{1,4}$/.test(value)) return;
    const mode = parseInt(value, 8);
    currentFileMode = mode;

    if (permCheckboxes.ur) permCheckboxes.ur.checked = (mode & 0o400) !== 0;
    if (permCheckboxes.uw) permCheckboxes.uw.checked = (mode & 0o200) !== 0;
    if (permCheckboxes.ux) permCheckboxes.ux.checked = (mode & 0o100) !== 0;

    if (permCheckboxes.gr) permCheckboxes.gr.checked = (mode & 0o040) !== 0;
    if (permCheckboxes.gw) permCheckboxes.gw.checked = (mode & 0o020) !== 0;
    if (permCheckboxes.gx) permCheckboxes.gx.checked = (mode & 0o010) !== 0;

    if (permCheckboxes.or) permCheckboxes.or.checked = (mode & 0o004) !== 0;
    if (permCheckboxes.ow) permCheckboxes.ow.checked = (mode & 0o002) !== 0;
    if (permCheckboxes.ox) permCheckboxes.ox.checked = (mode & 0o001) !== 0;
  }

  function applyPosixPermissions(): void {
    if (!activeItemPath) return;
    window.tauriAPI
      .setPermissions(activeItemPath, currentFileMode)
      .then((res) => {
        if (res.success) {
          config.showToast('POSIX permissions updated successfully', 'Success', 'success');
        } else {
          config.showToast(res.error || 'Failed to update permissions', 'Error', 'error');
        }
      })
      .catch((err) => config.showToast(String(err), 'Error', 'error'));
  }

  function applyWindowsAttributes(): void {
    if (!activeItemPath) return;
    const attrs = {
      readOnly: !!winCheckboxes.readonly?.checked,
      hidden: !!winCheckboxes.hidden?.checked,
      system: !!winCheckboxes.system?.checked,
    };
    window.tauriAPI
      .setAttributes(activeItemPath, attrs)
      .then((res) => {
        if (res.success) {
          config.showToast('Windows file attributes updated successfully', 'Success', 'success');
        } else {
          config.showToast(res.error || 'Failed to update attributes', 'Error', 'error');
        }
      })
      .catch((err) => config.showToast(String(err), 'Error', 'error'));
  }

  // Checksum triggers
  function triggerAutoChecksum(filePath = activeItemPath): void {
    if (!filePath) return;
    if (activeItemSize == null || activeItemSize >= AUTO_CHECKSUM_MAX_BYTES) return;
    const algo = checksumAlgoSelect?.value || 'sha256';
    calculateHash(filePath, algo);
  }

  function triggerManualChecksum(): void {
    if (!activeItemPath) return;
    const algo = checksumAlgoSelect?.value || 'sha256';
    calculateHash(activeItemPath, algo);
  }

  function calculateHash(filePath: string, algorithm: string): void {
    if (inProgressChecksumId) {
      window.tauriAPI.cancelChecksumCalculation(inProgressChecksumId).catch(ignoreError);
    }

    const operationId = `checksum-${Date.now()}`;
    inProgressChecksumId = operationId;

    if (checksumValueArea) {
      checksumValueArea.value = 'Calculating...';
    }
    if (copyChecksumBtn) {
      copyChecksumBtn.disabled = true;
    }

    window.tauriAPI
      .calculateChecksum(filePath, operationId, [algorithm])
      .then((res) => {
        if (inProgressChecksumId !== operationId) return; // Stale task
        inProgressChecksumId = null;

        if (res.success && res.result) {
          const hashValue = res.result[algorithm as keyof typeof res.result];
          if (hashValue) {
            if (checksumValueArea) checksumValueArea.value = hashValue;
            if (copyChecksumBtn) copyChecksumBtn.disabled = false;
          } else {
            if (checksumValueArea) checksumValueArea.value = `Error: hash missing for ${algorithm}`;
          }
        } else {
          if (checksumValueArea) {
            checksumValueArea.value = `Error: ${res.error || 'Operation failed'}`;
          }
        }
      })
      .catch((err) => {
        if (inProgressChecksumId !== operationId) return;
        inProgressChecksumId = null;
        if (checksumValueArea) {
          checksumValueArea.value = `Error: ${String(err)}`;
        }
      });
  }

  function isWindowsPlatform(pathHint: string | null): boolean {
    return (
      platformOS === 'win32' ||
      platformOS === 'windows' ||
      !!pathHint?.match(/^[A-Za-z]:[\\/]/) ||
      !!pathHint?.startsWith('\\\\')
    );
  }

  function toFileUri(filePath: string): string {
    if (filePath.startsWith('file://')) return filePath;

    if (isWindowsPath(filePath)) {
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.startsWith('//')) {
        return `file:${encodeURI(normalized)}`;
      }
      return `file:///${encodeURI(normalized)}`;
    }

    return `file://${encodeURI(filePath)}`;
  }

  return { init, updateSelection };
}
