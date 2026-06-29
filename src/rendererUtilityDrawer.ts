import type { Settings } from './types';
import { formatFileSize } from './rendererFileIcons.js';
import { isWindowsPath } from './rendererUtils.js';
import { ignoreError, escapeHtml } from './shared.js';
import { DASHBOARD_WIDGET_KEYS } from './constants.js';

type UtilityDrawerConfig = {
  getCurrentSettings: () => Settings;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<unknown>;
  showToast: (message: string, title: string, type: 'success' | 'info' | 'error') => void;
  getCurrentPath?: () => string;
  navigateTo?: (path: string) => void;
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
  let storageRequestId = 0;
  let isEditMode = false;

  // Cache elements
  const drawerEl = document.getElementById('utility-drawer');
  const headerEl = document.getElementById('utility-drawer-header');
  const toggleBtn = document.getElementById('utility-drawer-toggle-btn');
  const bodyEl = document.getElementById('utility-drawer-body');
  const statusEl = document.getElementById('utility-drawer-status');

  // Keep references to the original sections before we dynamically manipulate them
  const originalMeta = bodyEl?.querySelector('.utility-meta-section') as HTMLElement | null;
  const originalPerms = bodyEl?.querySelector('.utility-perms-section') as HTMLElement | null;
  const originalChecksum = bodyEl?.querySelector('.utility-checksum-section') as HTMLElement | null;

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
    if (!drawerEl || !headerEl || !bodyEl) return;

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

    // Detach the original sections initially so we can lay them out inside the quick-info card
    if (originalMeta) originalMeta.remove();
    if (originalPerms) originalPerms.remove();
    if (originalChecksum) originalChecksum.remove();

    // Bind Expand/Collapse click events
    headerEl.addEventListener('click', (e) => {
      // Prevent collapse if clicking the chevron button, customize button, or inside header buttons
      if (
        (e.target as HTMLElement).closest('.utility-drawer-toggle-btn') ||
        (e.target as HTMLElement).closest('.utility-customize-btn')
      )
        return;
      toggleDrawer();
    });

    toggleBtn?.addEventListener('click', toggleDrawer);

    // Bind customize dashboard button
    const customizeBtn = document.getElementById('utility-customize-btn');
    customizeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      isEditMode = !isEditMode;
      if (isEditMode) {
        customizeBtn.classList.add('active');
        drawerEl.classList.add('edit-mode');
      } else {
        customizeBtn.classList.remove('active');
        drawerEl.classList.remove('edit-mode');
      }
      renderWidgets();
    });

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

    // Listen for recent operations changes to dynamically update that widget
    document.addEventListener('recent-operations-changed', () => {
      const contentEl = bodyEl.querySelector('.recent-operations-content') as HTMLElement | null;
      if (contentEl) {
        renderRecentOperations(contentEl);
      }
    });

    // Render dashboard widgets
    renderWidgets();

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

  // Dashboard layout rendering
  const ALL_POSSIBLE_WIDGETS = [...DASHBOARD_WIDGET_KEYS];
  const POSSIBLE_WIDGET_SET = new Set<string>(ALL_POSSIBLE_WIDGETS);

  function getActiveWidgets(settings: Settings): string[] {
    const active = (settings.dashboardWidgets || ALL_POSSIBLE_WIDGETS).filter(
      (widget, index, widgets) =>
        POSSIBLE_WIDGET_SET.has(widget) && widgets.indexOf(widget) === index
    );
    return active.length > 0 ? active : [...ALL_POSSIBLE_WIDGETS];
  }

  function friendlyWidgetName(key: string): string {
    switch (key) {
      case 'quick-info':
        return 'Quick Info';
      case 'recent-operations':
        return 'Recent Operations';
      case 'storage-overview':
        return 'Storage Overview';
      case 'favorites':
        return 'Favorites';
      default:
        return key;
    }
  }

  function renderWidgets(): void {
    if (!bodyEl) return;
    bodyEl.innerHTML = '';

    const settings = config.getCurrentSettings();
    const activeWidgets = getActiveWidgets(settings);

    activeWidgets.forEach((widgetKey, idx) => {
      const card = document.createElement('div');
      card.className = `utility-widget-card ${widgetKey}-card`;
      card.dataset.widget = widgetKey;
      if (isEditMode) {
        card.classList.add('edit-active');
      }

      // Card Header
      const header = document.createElement('div');
      header.className = 'utility-widget-header';

      const title = document.createElement('span');
      title.className = 'widget-title';
      title.textContent = friendlyWidgetName(widgetKey);
      header.appendChild(title);

      // Edit controls
      if (isEditMode) {
        const controls = document.createElement('div');
        controls.className = 'widget-controls';

        const leftBtn = document.createElement('button');
        leftBtn.className = 'widget-control-btn btn-left';
        leftBtn.innerHTML = '◀';
        leftBtn.title = 'Move Left';
        if (idx === 0) leftBtn.disabled = true;
        leftBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          moveWidget(widgetKey, -1);
        });

        const rightBtn = document.createElement('button');
        rightBtn.className = 'widget-control-btn btn-right';
        rightBtn.innerHTML = '▶';
        rightBtn.title = 'Move Right';
        if (idx === activeWidgets.length - 1) rightBtn.disabled = true;
        rightBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          moveWidget(widgetKey, 1);
        });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'widget-control-btn btn-remove';
        removeBtn.innerHTML = '✕';
        removeBtn.title = 'Remove Widget';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeWidget(widgetKey);
        });

        controls.appendChild(leftBtn);
        controls.appendChild(rightBtn);
        controls.appendChild(removeBtn);
        header.appendChild(controls);
      }

      card.appendChild(header);

      // Card Content
      const content = document.createElement('div');
      content.className = `utility-widget-content ${widgetKey}-content`;

      if (widgetKey === 'quick-info') {
        content.style.display = 'flex';
        content.style.gap = 'var(--spacing-xxl)';
        content.style.flex = '1';
        content.style.minHeight = '0';
        if (originalMeta) content.appendChild(originalMeta);
        if (originalPerms) content.appendChild(originalPerms);
        if (originalChecksum) content.appendChild(originalChecksum);
      } else if (widgetKey === 'recent-operations') {
        renderRecentOperations(content);
      } else if (widgetKey === 'storage-overview') {
        renderStorageOverview(content);
      } else if (widgetKey === 'favorites') {
        renderFavorites(content);
      }

      card.appendChild(content);
      bodyEl.appendChild(card);
    });

    // Render "Add Widgets" panel at the end of the scroll container in Edit Mode
    if (isEditMode) {
      const inactiveWidgets = ALL_POSSIBLE_WIDGETS.filter((w) => !activeWidgets.includes(w));
      if (inactiveWidgets.length > 0) {
        const addCard = document.createElement('div');
        addCard.className = 'utility-widget-card add-widgets-card';
        addCard.style.width = '250px';
        addCard.style.minWidth = '250px';

        const addHeader = document.createElement('div');
        addHeader.className = 'utility-widget-header';
        const addTitle = document.createElement('span');
        addTitle.className = 'widget-title';
        addTitle.textContent = 'Add Widgets';
        addHeader.appendChild(addTitle);
        addCard.appendChild(addHeader);

        const addContent = document.createElement('div');
        addContent.className = 'utility-widget-content add-widgets-content';
        addContent.style.display = 'flex';
        addContent.style.flexDirection = 'column';
        addContent.style.gap = '8px';
        addContent.style.justifyContent = 'center';
        addContent.style.height = '100%';

        inactiveWidgets.forEach((widgetKey) => {
          const btn = document.createElement('button');
          btn.className = 'drawer-action-btn';
          btn.textContent = `+ ${friendlyWidgetName(widgetKey)}`;
          btn.addEventListener('click', () => {
            addWidget(widgetKey);
          });
          addContent.appendChild(btn);
        });

        addCard.appendChild(addContent);
        bodyEl.appendChild(addCard);
      }
    }
  }

  function getOpIconEmoji(kind: string): string {
    switch (kind) {
      case 'copy':
        return '📄';
      case 'move':
        return '📦';
      case 'delete':
        return '🗑️';
      case 'duplicate':
        return '👥';
      case 'compress':
        return '🤐';
      case 'extract':
        return '📂';
      case 'checksum':
        return '🔑';
      default:
        return '⚙️';
    }
  }

  function renderRecentOperations(contentEl: HTMLElement): void {
    const win = window as unknown as {
      recentOperations?: Array<{
        id: string;
        kind: string;
        name: string;
        status: string;
        timestamp: number;
      }>;
    };
    const ops = win.recentOperations || [];
    if (ops.length === 0) {
      contentEl.innerHTML = '<div class="empty-widget-state">No recent operations</div>';
      return;
    }

    contentEl.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'recent-ops-list';

    ops.slice(0, 5).forEach((op) => {
      const item = document.createElement('div');
      item.className = 'recent-op-item';

      const icon = document.createElement('span');
      icon.className = 'op-icon twemoji';
      icon.innerHTML = getOpIconEmoji(op.kind);

      const details = document.createElement('div');
      details.className = 'op-details';

      const name = document.createElement('div');
      name.className = 'op-name';
      name.textContent = op.name;

      const status = document.createElement('span');
      status.className = `op-status status-${op.status}`;
      status.textContent = op.status;

      details.appendChild(name);
      details.appendChild(status);
      item.appendChild(icon);
      item.appendChild(details);

      list.appendChild(item);
    });

    contentEl.appendChild(list);
  }

  function renderStorageOverview(contentEl: HTMLElement): void {
    const reqId = ++storageRequestId;
    const currentPath = activeItemPath || (config.getCurrentPath ? config.getCurrentPath() : '/');
    window.tauriAPI
      .getDiskSpace(currentPath)
      .then((res) => {
        if (reqId !== storageRequestId) return;
        if (
          res.success &&
          typeof res.total === 'number' &&
          typeof res.free === 'number' &&
          res.total > 0
        ) {
          const freeStr = formatFileSize(res.free);
          const totalStr = formatFileSize(res.total);
          const used = res.total - res.free;
          const usedStr = formatFileSize(used);
          const percent = ((used / res.total) * 100).toFixed(1);
          const percentNumeric = parseFloat(percent);

          const usageState =
            percentNumeric > 90 ? 'critical' : percentNumeric > 80 ? 'warning' : 'healthy';

          const escapedPath = escapeHtml(currentPath);
          // eslint-disable-next-line no-restricted-syntax -- escaped via escapeHtml(); rest is static markup
          contentEl.innerHTML = `
            <div class="storage-widget-details">
              <div class="storage-path" title="${escapedPath}">Volume: <code>${escapedPath}</code></div>
              <div class="storage-text">${freeStr} free of ${totalStr}</div>
              <div class="storage-progress-bar">
                <div class="storage-progress-fill ${usageState}" style="width: ${percent}%"></div>
              </div>
              <div class="storage-percent">${percent}% used (${usedStr} used)</div>
            </div>
          `;
        } else {
          contentEl.innerHTML = '<div class="empty-widget-state">Storage info unavailable</div>';
        }
      })
      .catch(() => {
        if (reqId !== storageRequestId) return;
        contentEl.innerHTML = '<div class="empty-widget-state">Storage info unavailable</div>';
      });
  }

  function renderFavorites(contentEl: HTMLElement): void {
    const settings = config.getCurrentSettings();
    const bookmarks = settings.bookmarks || [];
    if (bookmarks.length === 0) {
      contentEl.innerHTML = '<div class="empty-widget-state">No favorites saved</div>';
      return;
    }

    contentEl.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'favorites-list';

    bookmarks.forEach((path) => {
      const item = document.createElement('div');
      item.className = 'favorite-item';
      item.title = path;

      const icon = document.createElement('span');
      icon.className = 'favorite-icon twemoji';
      icon.innerHTML = '⭐';

      const name = document.createElement('span');
      name.className = 'favorite-name';
      const parts = path.split(/[\\/]/);
      name.textContent = parts[parts.length - 1] || path;

      item.appendChild(icon);
      item.appendChild(name);

      item.addEventListener('click', () => {
        if (config.navigateTo) {
          config.navigateTo(path);
        }
      });

      list.appendChild(item);
    });

    contentEl.appendChild(list);
  }

  function removeWidget(key: string): void {
    const settings = config.getCurrentSettings();
    settings.dashboardWidgets = getActiveWidgets(settings).filter((w) => w !== key);
    config
      .saveSettingsWithTimestamp(settings)
      .then(() => {
        renderWidgets();
      })
      .catch(ignoreError);
  }

  function moveWidget(key: string, direction: number): void {
    const settings = config.getCurrentSettings();
    const list = getActiveWidgets(settings);
    const index = list.indexOf(key);
    if (index === -1) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= list.length) return;

    const temp = list[index]!;
    list[index] = list[targetIndex]!;
    list[targetIndex] = temp;

    settings.dashboardWidgets = list;
    config
      .saveSettingsWithTimestamp(settings)
      .then(() => {
        renderWidgets();
      })
      .catch(ignoreError);
  }

  function addWidget(key: string): void {
    const settings = config.getCurrentSettings();
    const list = getActiveWidgets(settings);
    if (!POSSIBLE_WIDGET_SET.has(key)) return;
    if (!list.includes(key)) {
      list.push(key);
    }
    settings.dashboardWidgets = list;
    config
      .saveSettingsWithTimestamp(settings)
      .then(() => {
        renderWidgets();
      })
      .catch(ignoreError);
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

      // Update storage overview if widget is active
      const storageContent = bodyEl?.querySelector(
        '.storage-overview-content'
      ) as HTMLElement | null;
      if (storageContent) {
        renderStorageOverview(storageContent);
      }

      return;
    }

    // Single item is selected
    const parts = itemPath.split(/[\\/]/);
    const filename = parts[parts.length - 1] || itemPath;
    if (statusEl) statusEl.textContent = `Selected: ${filename}`;
    if (metaPathEl) metaPathEl.textContent = itemPath;

    // Enable path utility actions
    toggleButtonsState(false);

    // Update storage overview if widget is active to reflect the selected item's volume
    const storageContent = bodyEl?.querySelector('.storage-overview-content') as HTMLElement | null;
    if (storageContent) {
      renderStorageOverview(storageContent);
    }

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
