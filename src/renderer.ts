import type { Settings, FileItem, ItemProperties } from './types';

const path = {
  basename: (filePath: string, ext?: string): string => {
    const name = filePath.split(/[\\/]/).pop() || '';
    if (ext && name.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
    return name;
  },
  dirname: (filePath: string): string => {
    return filePath.split(/[\\/]/).slice(0, -1).join('/');
  },
  extname: (filePath: string): string => {
    const name = filePath.split(/[\\/]/).pop() || '';
    const dotIndex = name.lastIndexOf('.');
    return dotIndex === -1 ? '' : name.slice(dotIndex);
  },
  join: (...parts: string[]): string => {
    return parts.join('/').replace(/\/+/g, '/');
  }
};

function escapeHtml(text: any): string {
  if (text === null || text === undefined) return '';
  const str = String(text);
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, (m) => map[m]);
}

function encodeFileUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  // Encode each path segment
  const encoded = normalizedPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `file:///${encoded}`;
}

function emojiToCodepoint(emoji: string): string {
  const codePoints: number[] = [];
  let i = 0;
  while (i < emoji.length) {
    const code = emoji.codePointAt(i);
    if (code !== undefined) {
      if (code !== 0xFE0F) {
        codePoints.push(code);
      }
      i += code > 0xFFFF ? 2 : 1;
    } else {
      i++;
    }
  }
  return codePoints.map(cp => cp.toString(16)).join('-');
}

function twemojiImg(emoji: string, className: string = 'twemoji', alt?: string): string {
  const codepoint = emojiToCodepoint(emoji);
  const src = `assets/twemoji/${codepoint}.svg`;
  const altText = alt || emoji;
  return `<img src="${src}" class="${className}" alt="${altText}" draggable="false" />`;
}

type ViewMode = 'grid' | 'list';

interface ArchiveOperation {
  id: string;
  type: 'compress' | 'extract';
  name: string;
  current: number;
  total: number;
  currentFile: string;
  aborted: boolean;
}

const activeOperations = new Map<string, ArchiveOperation>();

function generateOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function showOperationsPanel() {
  const panel = document.getElementById('archive-operations-panel');
  if (panel && activeOperations.size > 0) {
    panel.style.display = 'block';
  }
}

function hideOperationsPanel() {
  const panel = document.getElementById('archive-operations-panel');
  if (panel && activeOperations.size === 0) {
    panel.style.display = 'none';
  }
}

function addOperation(id: string, type: 'compress' | 'extract', name: string) {
  const operation: ArchiveOperation = {
    id,
    type,
    name,
    current: 0,
    total: 0,
    currentFile: 'Preparing...',
    aborted: false
  };
  
  activeOperations.set(id, operation);
  renderOperations();
  showOperationsPanel();
}

function updateOperation(id: string, current: number, total: number, currentFile: string) {
  const operation = activeOperations.get(id);
  if (operation && !operation.aborted) {
    operation.current = current;
    operation.total = total;
    operation.currentFile = currentFile;
    renderOperations();
  }
}

function removeOperation(id: string) {
  activeOperations.delete(id);
  renderOperations();
  hideOperationsPanel();
}

function abortOperation(id: string) {
  const operation = activeOperations.get(id);
  if (operation) {
    operation.aborted = true;
    operation.currentFile = 'Cancelling...';
    renderOperations();

    window.electronAPI.cancelArchiveOperation(id).then((result) => {
      if (result.success) {
        console.log('[Archive] Operation cancelled:', id);
      } else {
        console.error('[Archive] Failed to cancel:', result.error);
      }
    });

    setTimeout(() => {
      removeOperation(id);
    }, 1500);
  }
}

function renderOperations() {
  const list = document.getElementById('archive-operations-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  for (const [id, operation] of activeOperations) {
    const item = document.createElement('div');
    item.className = 'archive-operation-item';
    
    const icon = operation.type === 'compress' ? '1f5dc' : '1f4e6';
    const iconEmoji = operation.type === 'compress' ? '🗜️' : '📦';
    const title = operation.type === 'compress' ? 'Compressing' : 'Extracting';
    
    const percent = operation.total > 0 
      ? Math.round((operation.current / operation.total) * 100) 
      : 0;
    
    item.innerHTML = `
      <div class="archive-operation-header">
        <div class="archive-operation-title">
          <img src="assets/twemoji/${icon}.svg" class="twemoji" alt="${iconEmoji}" draggable="false" />
          <span class="archive-operation-name" title="${operation.name}">${title}: ${operation.name}</span>
        </div>
        ${!operation.aborted ? `<button class="archive-operation-cancel" data-id="${id}">Cancel</button>` : ''}
      </div>
      <div class="archive-operation-file">${operation.currentFile}</div>
      <div class="archive-operation-stats">${operation.current} / ${operation.total} files</div>
      <div class="archive-progress-bar-container">
        <div class="archive-progress-bar" style="width: ${percent}%"></div>
      </div>
    `;
    
    const cancelBtn = item.querySelector('.archive-operation-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        abortOperation(id);
      });
    }
    
    list.appendChild(item);
  }
}

type DialogType = 'info' | 'warning' | 'error' | 'success' | 'question';

function asElement(target: EventTarget | null): HTMLElement | null {
  return target as HTMLElement;
}

let currentPath: string = '';
let history: string[] = [];
let historyIndex: number = -1;
let selectedItems: Set<string> = new Set();
let viewMode: ViewMode = 'grid';
let contextMenuData: FileItem | null = null;
let clipboard: { operation: 'copy' | 'cut'; paths: string[] } | null = null;
let allFiles: FileItem[] = [];
let isSearchMode: boolean = false;
let isGlobalSearch: boolean = false;
let isPreviewPanelVisible: boolean = false;
let currentPreviewFile: FileItem | null = null;
let currentQuicklookFile: FileItem | null = null;
let platformOS: string = '';
let canUndo: boolean = false;
let canRedo: boolean = false;
let currentZoomLevel: number = 1.0;
let zoomPopupTimeout: NodeJS.Timeout | null = null;
let indexStatusInterval: NodeJS.Timeout | null = null;

const addressInput = document.getElementById('address-input') as HTMLInputElement;
const fileGrid = document.getElementById('file-grid') as HTMLElement;
const loading = document.getElementById('loading') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;
const forwardBtn = document.getElementById('forward-btn') as HTMLButtonElement;
const upBtn = document.getElementById('up-btn') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const newFileBtn = document.getElementById('new-file-btn') as HTMLButtonElement;
const newFolderBtn = document.getElementById('new-folder-btn') as HTMLButtonElement;
const viewToggleBtn = document.getElementById('view-toggle-btn') as HTMLButtonElement;
const drivesList = document.getElementById('drives-list') as HTMLElement;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBarWrapper = document.querySelector('.search-bar-wrapper') as HTMLElement;
const searchBar = document.querySelector('.search-bar') as HTMLElement;
const searchClose = document.getElementById('search-close') as HTMLButtonElement;
const searchScopeToggle = document.getElementById('search-scope-toggle') as HTMLButtonElement;
const addressBarWrapper = document.querySelector('.address-bar-wrapper') as HTMLElement;
const addressBar = document.querySelector('.address-bar') as HTMLElement;
const sortBtn = document.getElementById('sort-btn') as HTMLButtonElement;
const bookmarksList = document.getElementById('bookmarks-list') as HTMLElement;
const bookmarkAddBtn = document.getElementById('bookmark-add-btn') as HTMLButtonElement;
const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;

function showDialog(title: string, message: string, type: DialogType = 'info', showCancel: boolean = false): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
    const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
    const dialogContent = document.getElementById('dialog-content') as HTMLElement;
    const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
    const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
    const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;

    const icons: Record<DialogType, string> = {
      info: '2139',
      warning: '26a0',
      error: '274c',
      success: '2705',
      question: '2753'
    };

    dialogIcon.innerHTML = twemojiImg(String.fromCodePoint(parseInt(icons[type] || icons.info, 16)), 'twemoji');
    dialogTitle.textContent = title;
    dialogContent.textContent = message;
    
    if (showCancel) {
      dialogCancel.style.display = 'block';
    } else {
      dialogCancel.style.display = 'none';
    }

    dialogModal.style.display = 'flex';

    const handleOk = (): void => {
      dialogModal.style.display = 'none';
      cleanup();
      resolve(true);
    };

    const handleCancel = (): void => {
      dialogModal.style.display = 'none';
      cleanup();
      resolve(false);
    };

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        dialogModal.style.display = 'none';
        cleanup();
        resolve(false);
      }
    };

    const cleanup = (): void => {
      dialogOk.removeEventListener('click', handleOk);
      dialogCancel.removeEventListener('click', handleCancel);
      document.removeEventListener('keydown', handleEscape);
    };

    dialogOk.addEventListener('click', handleOk);
    dialogCancel.addEventListener('click', handleCancel);
    document.addEventListener('keydown', handleEscape);
  });
}

async function showAlert(message: string, title: string = 'IYERIS', type: DialogType = 'info'): Promise<void> {
  await showDialog(title, message, type, false);
}

async function showConfirm(message: string, title: string = 'Confirm', type: DialogType = 'question'): Promise<boolean> {
  return await showDialog(title, message, type, true);
}

let currentSettings: Settings = {
  transparency: true,
  theme: 'default',
  sortBy: 'name',
  sortOrder: 'asc',
  bookmarks: [],
  viewMode: 'grid',
  showDangerousOptions: false,
  startupPath: '',
  showHiddenFiles: false,
  enableSearchHistory: true,
  searchHistory: [],
  directoryHistory: [],
  enableIndexer: true,
  minimizeToTray: false,
  startOnLogin: false,
  autoCheckUpdates: true
};

function showToast(message: string, title: string = '', type: 'success' | 'error' | 'info' | 'warning' = 'info'): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cursor = 'pointer';
  
  const icons: Record<string, string> = {
    success: '2705',
    error: '274c',
    info: '2139',
    warning: '26a0'
  };

  toast.innerHTML = `
    <span class="toast-icon">${twemojiImg(String.fromCodePoint(parseInt(icons[type], 16)), 'twemoji')}</span>
    <div class="toast-content">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
  `;

  container.appendChild(toast);

  const removeToast = () => {
    toast.classList.add('removing');
    setTimeout(() => {
      if (container.contains(toast)) {
        container.removeChild(toast);
      }
    }, 300);
  };

  toast.addEventListener('click', removeToast);

  setTimeout(removeToast, 3000);
}

async function loadSettings(): Promise<void> {
  const result = await window.electronAPI.getSettings();
  if (result.success && result.settings) {
    currentSettings = {
      transparency: true,
      theme: 'default',
      sortBy: 'name',
      sortOrder: 'asc',
      bookmarks: [],
      viewMode: 'grid',
      showDangerousOptions: false,
      startupPath: '',
      showHiddenFiles: false,
      ...result.settings
    };
    applySettings(currentSettings);
  }
}

function applySettings(settings: Settings) {
  if (settings.transparency === false) {
    document.body.classList.add('no-transparency');
  } else {
    document.body.classList.remove('no-transparency');
  }
  
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-default');
  if (settings.theme && settings.theme !== 'default') {
    document.body.classList.add(`theme-${settings.theme}`);
  }
  
  if (settings.viewMode) {
    viewMode = settings.viewMode;
    fileGrid.className = viewMode === 'list' ? 'file-grid list-view' : 'file-grid';
    updateViewToggleButton();
  }
  
  loadBookmarks();
}

async function showSettingsModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  
  const settingsModal = document.getElementById('settings-modal');
  
  // Reset tabs
  const tabs = document.querySelectorAll('.settings-tab');
  const sections = document.querySelectorAll('.settings-section');
  
  tabs.forEach(t => t.classList.remove('active'));
  sections.forEach(s => s.classList.remove('active'));
  
  if (tabs.length > 0) tabs[0].classList.add('active');
  if (sections.length > 0) sections[0].classList.add('active');

  const transparencyToggle = document.getElementById('transparency-toggle') as HTMLInputElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
  const showHiddenFilesToggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
  const minimizeToTrayToggle = document.getElementById('minimize-to-tray-toggle') as HTMLInputElement;
  const startOnLoginToggle = document.getElementById('start-on-login-toggle') as HTMLInputElement;
  const autoCheckUpdatesToggle = document.getElementById('auto-check-updates-toggle') as HTMLInputElement;
  const enableSearchHistoryToggle = document.getElementById('enable-search-history-toggle') as HTMLInputElement;
  const dangerousOptionsToggle = document.getElementById('dangerous-options-toggle') as HTMLInputElement;
  const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
  const enableIndexerToggle = document.getElementById('enable-indexer-toggle') as HTMLInputElement;
  const settingsPath = document.getElementById('settings-path');
  
  if (transparencyToggle) {
    transparencyToggle.checked = currentSettings.transparency;
  }
  
  if (themeSelect) {
    themeSelect.value = currentSettings.theme || 'default';
  }
  
  if (sortBySelect) {
    sortBySelect.value = currentSettings.sortBy || 'name';
  }
  
  if (sortOrderSelect) {
    sortOrderSelect.value = currentSettings.sortOrder || 'asc';
  }
  
  if (showHiddenFilesToggle) {
    showHiddenFilesToggle.checked = currentSettings.showHiddenFiles || false;
  }

  if (minimizeToTrayToggle) {
    minimizeToTrayToggle.checked = currentSettings.minimizeToTray || false;
  }
  
  if (startOnLoginToggle) {
    startOnLoginToggle.checked = currentSettings.startOnLogin || false;
  }

  if (autoCheckUpdatesToggle) {
    autoCheckUpdatesToggle.checked = currentSettings.autoCheckUpdates !== false;
  }
  
  if (enableSearchHistoryToggle) {
    enableSearchHistoryToggle.checked = currentSettings.enableSearchHistory !== false;
  }
  
  if (dangerousOptionsToggle) {
    dangerousOptionsToggle.checked = currentSettings.showDangerousOptions || false;
    updateDangerousOptionsVisibility(dangerousOptionsToggle.checked);
  }
  
  if (startupPathInput) {
    startupPathInput.value = currentSettings.startupPath || '';
  }
  
  if (enableIndexerToggle) {
    enableIndexerToggle.checked = currentSettings.enableIndexer !== false;
  }

  await updateIndexStatus();
  
  const path = await window.electronAPI.getSettingsPath();
  if (settingsPath) {
    settingsPath.textContent = path;
  }
  
  if (settingsModal) {
    settingsModal.style.display = 'flex';
  }
}

function hideSettingsModal() {
  const settingsModal = document.getElementById('settings-modal');
  settingsModal.style.display = 'none';
  stopIndexStatusPolling();
}

function startIndexStatusPolling() {
  stopIndexStatusPolling();
  indexStatusInterval = setInterval(async () => {
    await updateIndexStatus();
    const result = await window.electronAPI.getIndexStatus();
    if (result.success && result.status && !result.status.isIndexing) {
      stopIndexStatusPolling();
    }
  }, 500);
}

function stopIndexStatusPolling() {
  if (indexStatusInterval) {
    clearInterval(indexStatusInterval);
    indexStatusInterval = null;
  }
}

async function updateIndexStatus() {
  const indexStatus = document.getElementById('index-status');
  if (!indexStatus) return;
  
  try {
    const result = await window.electronAPI.getIndexStatus();
    if (result.success && result.status) {
      const status = result.status;
      if (status.isIndexing) {
        indexStatus.textContent = `Status: Indexing... (${status.indexedFiles.toLocaleString()} files found)`;
        if (!indexStatusInterval) {
          startIndexStatusPolling();
        }
      } else if (status.lastIndexTime) {
        const date = new Date(status.lastIndexTime);
        indexStatus.textContent = `Status: ${status.indexedFiles.toLocaleString()} files indexed on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
      } else {
        indexStatus.textContent = 'Status: Not indexed yet';
      }
    } else {
      indexStatus.textContent = 'Status: Unknown';
    }
  } catch (error) {
    console.error('Failed to get index status:', error);
    indexStatus.textContent = 'Status: Error';
  }
}

async function rebuildIndex() {
  const rebuildBtn = document.getElementById('rebuild-index-btn') as HTMLButtonElement;
  if (!rebuildBtn) return;
  
  const originalHTML = rebuildBtn.innerHTML;
  rebuildBtn.disabled = true;
  rebuildBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x23F3), 'twemoji')} Rebuilding...`;
  
  try {
    const result = await window.electronAPI.rebuildIndex();
    if (result.success) {
      showToast('Index rebuild started', 'File Indexer', 'success');
      setTimeout(async () => {
        await updateIndexStatus();
      }, 300);
    } else {
      showToast('Failed to rebuild index: ' + result.error, 'Error', 'error');
    }
  } catch (error) {
    showToast('Error rebuilding index', 'Error', 'error');
  } finally {
    rebuildBtn.disabled = false;
    rebuildBtn.innerHTML = originalHTML;
  }
}


function updateDangerousOptionsVisibility(show: boolean) {
  const dangerousOptions = document.querySelectorAll('.dangerous-option');
  dangerousOptions.forEach(option => {
    (option as HTMLElement).style.display = show ? 'flex' : 'none';
  });
}

async function showLicensesModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  
  const licensesModal = document.getElementById('licenses-modal');
  if (!licensesModal) return;
  
  licensesModal.style.display = 'flex';
  
  const licensesContent = document.getElementById('licenses-content');
  const totalDeps = document.getElementById('total-deps');
  
  if (!licensesContent) return;
  
  licensesContent.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Loading licenses...</p>';
  
  try {
    const result = await window.electronAPI.getLicenses();
    
    if (result.success && result.licenses) {
      const licenses = result.licenses;
      const packageCount = Object.keys(licenses).length;
      
      if (totalDeps) {
        totalDeps.textContent = packageCount.toString();
      }
      
      let html = '';
      
      for (const [packageName, packageInfo] of Object.entries(licenses)) {
        const info = packageInfo as any;
        html += '<div class="license-package">';
        html += `<div class="license-package-name">${packageName}</div>`;
        html += '<div class="license-package-info">';
        html += `<span class="license-package-license">${info.licenses || 'Unknown'}</span>`;
        if (info.repository) {
          html += `<span>Repository: ${info.repository}</span>`;
        }
        if (info.publisher) {
          html += `<span>Publisher: ${info.publisher}</span>`;
        }
        html += '</div>';
        
        if (info.licenseFile && info.licenseText) {
          html += `<div class="license-package-text">${escapeHtml(info.licenseText.substring(0, 1000))}${info.licenseText.length > 1000 ? '...' : ''}</div>`;
        }
        
        html += '</div>';
      }
      
      licensesContent.innerHTML = html;
    } else {
      licensesContent.innerHTML = `<p style="color: var(--error-color); text-align: center;">Error loading licenses: ${result.error || 'Unknown error'}</p>`;
    }
  } catch (error) {
    licensesContent.innerHTML = `<p style="color: var(--error-color); text-align: center;">Error: ${(error as Error).message}</p>`;
  }
}

function hideLicensesModal() {
  const licensesModal = document.getElementById('licenses-modal');
  if (licensesModal) {
    licensesModal.style.display = 'none';
  }
}

function showShortcutsModal() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  
  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.style.display = 'flex';
    
    if (platformOS === 'darwin') {
      const allKbdElements = shortcutsModal.querySelectorAll('kbd');
      allKbdElements.forEach(kbd => {
        if (kbd.textContent === 'Ctrl') {
          kbd.textContent = '⌘ Cmd';
        } else if (kbd.textContent === 'Alt') {
          kbd.textContent = '⌥ Option';
        }
      });
    }
  }
}

function hideShortcutsModal() {
  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.style.display = 'none';
  }
}

function openNewWindow() {
  window.electronAPI.openNewWindow();
}

function copyLicensesText() {
  const licensesContent = document.getElementById('licenses-content');
  if (!licensesContent) return;
  
  const text = licensesContent.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-licenses-btn');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = originalText;
      }, 2000);
    }
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

async function saveSettings() {
  const transparencyToggle = document.getElementById('transparency-toggle') as HTMLInputElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
  const showHiddenFilesToggle = document.getElementById('show-hidden-files-toggle') as HTMLInputElement;
  const minimizeToTrayToggle = document.getElementById('minimize-to-tray-toggle') as HTMLInputElement;
  const startOnLoginToggle = document.getElementById('start-on-login-toggle') as HTMLInputElement;
  const autoCheckUpdatesToggle = document.getElementById('auto-check-updates-toggle') as HTMLInputElement;
  const enableSearchHistoryToggle = document.getElementById('enable-search-history-toggle') as HTMLInputElement;
  const dangerousOptionsToggle = document.getElementById('dangerous-options-toggle') as HTMLInputElement;
  const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
  const enableIndexerToggle = document.getElementById('enable-indexer-toggle') as HTMLInputElement;
  
  if (transparencyToggle) {
    currentSettings.transparency = transparencyToggle.checked;
  }
  
  if (themeSelect) {
    currentSettings.theme = themeSelect.value as any;
  }
  
  if (sortBySelect) {
    currentSettings.sortBy = sortBySelect.value as any;
  }
  
  if (sortOrderSelect) {
    currentSettings.sortOrder = sortOrderSelect.value as any;
  }
  
  if (showHiddenFilesToggle) {
    currentSettings.showHiddenFiles = showHiddenFilesToggle.checked;
  }
  
  if (minimizeToTrayToggle) {
    currentSettings.minimizeToTray = minimizeToTrayToggle.checked;
  }
  
  if (startOnLoginToggle) {
    currentSettings.startOnLogin = startOnLoginToggle.checked;
  }

  if (autoCheckUpdatesToggle) {
    currentSettings.autoCheckUpdates = autoCheckUpdatesToggle.checked;
  }
  
  if (enableSearchHistoryToggle) {
    currentSettings.enableSearchHistory = enableSearchHistoryToggle.checked;
  }

  if (dangerousOptionsToggle) {
    currentSettings.showDangerousOptions = dangerousOptionsToggle.checked;
    updateDangerousOptionsVisibility(currentSettings.showDangerousOptions);
  }

  if (startupPathInput) {
    currentSettings.startupPath = startupPathInput.value;
  }

  if (enableIndexerToggle) {
    currentSettings.enableIndexer = enableIndexerToggle.checked;
  }
  
  currentSettings.viewMode = viewMode;
  
  const result = await window.electronAPI.saveSettings(currentSettings);
  if (result.success) {
    applySettings(currentSettings);
    hideSettingsModal();
    showToast('Settings saved successfully!', 'Settings', 'success');
    if (currentPath) {
      refresh();
    }
  } else {
    showToast('Failed to save settings: ' + result.error, 'Error', 'error');
  }
}

async function resetSettings() {
  const confirmed = await showConfirm(
    'Are you sure you want to reset all settings to default? The app will restart. This cannot be undone.',
    'Reset Settings',
    'warning'
  );
  
  if (confirmed) {
    const result = await window.electronAPI.resetSettings();
    if (result.success) {
      await window.electronAPI.relaunchApp();
    } else {
      showToast('Failed to reset settings: ' + result.error, 'Error', 'error');
    }
  }
}

function loadBookmarks() {
  if (!bookmarksList) return;
  bookmarksList.innerHTML = '';
  
  if (!currentSettings.bookmarks || currentSettings.bookmarks.length === 0) {
    return;
  }
  
  currentSettings.bookmarks.forEach(bookmarkPath => {
    const bookmarkItem = document.createElement('div');
    bookmarkItem.className = 'bookmark-item';
    const pathParts = bookmarkPath.split(/[/\\]/);
    const name = pathParts[pathParts.length - 1] || bookmarkPath;
    
    bookmarkItem.innerHTML = `
      <span class="bookmark-icon">${twemojiImg(String.fromCodePoint(0x2B50), 'twemoji')}</span>
      <span class="bookmark-label">${escapeHtml(name)}</span>
      <button class="bookmark-remove" title="Remove bookmark">${twemojiImg(String.fromCodePoint(0x274C), 'twemoji')}</button>
    `;
    
    bookmarkItem.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).classList.contains('bookmark-remove')) {
        navigateTo(bookmarkPath);
      }
    });
    
    const removeBtn = bookmarkItem.querySelector('.bookmark-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeBookmark(bookmarkPath);
      });
    }
    
    bookmarksList.appendChild(bookmarkItem);
  });
}

async function addBookmark() {
  if (!currentPath) return;
  await addBookmarkByPath(currentPath);
}

async function addBookmarkByPath(path: string) {
  if (!currentSettings.bookmarks) {
    currentSettings.bookmarks = [];
  }
  
  if (currentSettings.bookmarks.includes(path)) {
    showToast('This folder is already bookmarked', 'Bookmarks', 'info');
    return;
  }
  
  currentSettings.bookmarks.push(path);
  const result = await window.electronAPI.saveSettings(currentSettings);
  
  if (result.success) {
    loadBookmarks();
    showToast('Bookmark added', 'Bookmarks', 'success');
  } else {
    showToast('Failed to add bookmark', 'Error', 'error');
  }
}

async function removeBookmark(path: string) {
  if (!currentSettings.bookmarks) return;
  
  currentSettings.bookmarks = currentSettings.bookmarks.filter(b => b !== path);
  const result = await window.electronAPI.saveSettings(currentSettings);
  
  if (result.success) {
    loadBookmarks();
    showToast('Bookmark removed', 'Bookmarks', 'success');
  } else {
    showToast('Failed to remove bookmark', 'Error', 'error');
  }
}

function toggleSearch() {
  if (searchBarWrapper.style.display === 'none' || !searchBarWrapper.style.display) {
    searchBarWrapper.style.display = 'block';
    searchInput.focus();
    isSearchMode = true;
    updateSearchPlaceholder();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  searchBarWrapper.style.display = 'none';
  searchInput.value = '';
  isSearchMode = false;
  isGlobalSearch = false;
  searchScopeToggle.classList.remove('global');
  hideSearchHistoryDropdown();
  updateSearchPlaceholder();
  if (currentPath) {
    navigateTo(currentPath);
  }
}

function toggleSearchScope() {
  isGlobalSearch = !isGlobalSearch;
  if (isGlobalSearch) {
    searchScopeToggle.classList.add('global');
    searchScopeToggle.title = 'Global Search (All Indexed Files)';
    const img = searchScopeToggle.querySelector('img');
    if (img) {
      img.src = 'assets/twemoji/1f30d.svg';
      img.alt = '🌍';
    }
  } else {
    searchScopeToggle.classList.remove('global');
    searchScopeToggle.title = 'Local Search (Current Folder)';
    const img = searchScopeToggle.querySelector('img');
    if (img) {
      img.src = 'assets/twemoji/1f4c1.svg';
      img.alt = '📁';
    }
  }
  updateSearchPlaceholder();

  if (searchInput.value.trim()) {
    performSearch();
  }
}

function updateSearchPlaceholder() {
  if (isGlobalSearch) {
    searchInput.placeholder = 'Search all files...';
  } else {
    searchInput.placeholder = 'Search files...';
  }
}

async function performSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  if (!isGlobalSearch && !currentPath) return;
  
  addToSearchHistory(query);
  
  loading.style.display = 'flex';
  emptyState.style.display = 'none';
  fileGrid.innerHTML = '';
  
  let result;
  
  if (isGlobalSearch) {
    result = await window.electronAPI.searchIndex(query);
    
    if (result.success && result.results) {
      const fileItems: FileItem[] = [];
      
      for (const entry of result.results) {
        const isHidden = entry.name.startsWith('.');
        
        fileItems.push({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
          size: entry.size,
          modified: entry.modified,
          isHidden
        });
      }
      
      allFiles = fileItems;
      renderFiles(fileItems);
    } else {
      if (result.error === 'Indexer is disabled') {
        showToast('File indexer is disabled. Enable it in settings to use global search.', 'Index Disabled', 'warning');
      } else {
        showToast(result.error || 'Global search failed', 'Search Error', 'error');
      }
    }
  } else {
    result = await window.electronAPI.searchFiles(currentPath, query);
    
    if (result.success && result.results) {
      allFiles = result.results;
      renderFiles(result.results);
    } else {
      showToast(result.error || 'Search failed', 'Search Error', 'error');
    }
  }
  
  loading.style.display = 'none';
  updateStatusBar();
}

function copyToClipboard() {
  if (selectedItems.size === 0) return;
  clipboard = {
    operation: 'copy',
    paths: Array.from(selectedItems)
  };
  updateCutVisuals();
  showToast(`${selectedItems.size} item(s) copied`, 'Clipboard', 'success');
}

function cutToClipboard() {
  if (selectedItems.size === 0) return;
  clipboard = {
    operation: 'cut',
    paths: Array.from(selectedItems)
  };
  updateCutVisuals();
  showToast(`${selectedItems.size} item(s) cut`, 'Clipboard', 'success');
}

async function pasteFromClipboard() {
  if (!clipboard || !currentPath) return;
  
  const operation = clipboard.operation === 'copy' ? 'copyItems' : 'moveItems';
  const result = await window.electronAPI[operation](clipboard.paths, currentPath);
  
  if (result.success) {
    showToast(`${clipboard.paths.length} item(s) ${clipboard.operation === 'copy' ? 'copied' : 'moved'}`, 'Success', 'success');
    
    if (clipboard.operation === 'cut') {
      await updateUndoRedoState();
    }
    
    clipboard = null;
    updateCutVisuals();
    refresh();
  } else {
    showToast(result.error || 'Operation failed', 'Error', 'error');
  }
}

function updateCutVisuals() {
  document.querySelectorAll('.file-item').forEach(item => {
    const itemPath = item.getAttribute('data-path');
    if (clipboard && clipboard.operation === 'cut' && clipboard.paths.includes(itemPath)) {
      item.classList.add('cut');
    } else {
      item.classList.remove('cut');
    }
  });
}

function showSortMenu(e: MouseEvent) {
  const sortMenu = document.getElementById('sort-menu');
  if (!sortMenu) return;
  
  const rect = sortBtn.getBoundingClientRect();
  sortMenu.style.display = 'block';
  
  const menuRect = sortMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  let left = rect.left;
  let top = rect.bottom + 5;
  
  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }
  
  if (top + menuRect.height > viewportHeight) {
    top = rect.top - menuRect.height - 5;
  }
  
  if (left < 10) left = 10;
  if (top < 10) top = 10;
  
  sortMenu.style.left = left + 'px';
  sortMenu.style.top = top + 'px';
  
  updateSortIndicators();
  
  e.stopPropagation();
}

function hideSortMenu() {
  const sortMenu = document.getElementById('sort-menu');
  if (sortMenu) {
    sortMenu.style.display = 'none';
  }
}

function updateSortIndicators() {
  ['name', 'date', 'size', 'type'].forEach(sortType => {
    const indicator = document.getElementById(`sort-${sortType}`);
    if (indicator) {
      if (currentSettings.sortBy === sortType) {
        indicator.textContent = currentSettings.sortOrder === 'asc' ? '▲' : '▼';
      } else {
        indicator.textContent = '';
      }
    }
  });
}

async function changeSortMode(sortBy: string) {
  if (currentSettings.sortBy === sortBy) {
    currentSettings.sortOrder = currentSettings.sortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    currentSettings.sortBy = sortBy as any;
    currentSettings.sortOrder = 'asc';
  }
  
  await window.electronAPI.saveSettings(currentSettings);
  hideSortMenu();
  
  if (allFiles.length > 0) {
    renderFiles(allFiles);
  }
}

function updateStatusBar() {
  const statusItems = document.getElementById('status-items');
  const statusSelected = document.getElementById('status-selected');
  
  if (statusItems) {
    statusItems.textContent = `${allFiles.length} item${allFiles.length !== 1 ? 's' : ''}`;
  }
  
  if (statusSelected) {
    if (selectedItems.size > 0) {
      const totalSize = Array.from(selectedItems).reduce((acc, path) => {
        const item = allFiles.find(f => f.path === path);
        return acc + (item ? item.size : 0);
      }, 0);
      const sizeStr = formatFileSize(totalSize);
      statusSelected.textContent = `${selectedItems.size} selected (${sizeStr})`;
      statusSelected.style.display = 'inline';
    } else {
      statusSelected.style.display = 'none';
    }
  }
}

async function updateDiskSpace() {
  const statusDiskSpace = document.getElementById('status-disk-space');
  console.log('[DiskSpace] Element found:', !!statusDiskSpace, 'Current path:', currentPath);
  if (!statusDiskSpace || !currentPath) return;
  
  let drivePath = currentPath;
  if (platformOS === 'win32') {
    drivePath = currentPath.substring(0, 3);
  } else {
    drivePath = '/';
  }
  
  console.log('[DiskSpace] Checking drive:', drivePath, 'Platform:', platformOS);
  const result = await window.electronAPI.getDiskSpace(drivePath);
  console.log('[DiskSpace] Result:', result);
  if (result.success && result.total && result.free) {
    const freeStr = formatFileSize(result.free);
    const totalStr = formatFileSize(result.total);
    const usedBytes = result.total - result.free;
    const usedPercent = ((usedBytes / result.total) * 100).toFixed(1);
    let usageColor = '#107c10';
    if (parseFloat(usedPercent) > 80) {
      usageColor = '#ff8c00';
    }
    if (parseFloat(usedPercent) > 90) {
      usageColor = '#e81123';
    }

    statusDiskSpace.innerHTML = `
      <span style="display: inline-flex; align-items: center; gap: 6px;">
        ${twemojiImg(String.fromCodePoint(0x1F4BE), 'twemoji')} ${freeStr} free of ${totalStr}
        <span style="display: inline-block; width: 60px; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; position: relative;">
          <span style="position: absolute; left: 0; top: 0; height: 100%; width: ${usedPercent}%; background: ${usageColor}; transition: width 0.3s ease;"></span>
        </span>
        <span style="opacity: 0.7;">(${usedPercent}% used)</span>
      </span>
    `;
    console.log('[DiskSpace] Updated display successfully');
  } else {
    console.log('[DiskSpace] Failed to get disk space info');
    statusDiskSpace.textContent = '';
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function updateZoomLevel(newZoom: number) {
  currentZoomLevel = Math.max(0.5, Math.min(2.0, newZoom));
  const result = await window.electronAPI.setZoomLevel(currentZoomLevel);
  
  if (result.success) {
    updateZoomDisplay();
    showZoomPopup();
  }
}

function updateZoomDisplay() {
  const zoomDisplay = document.getElementById('zoom-level-display');
  if (zoomDisplay) {
    zoomDisplay.textContent = `${Math.round(currentZoomLevel * 100)}%`;
  }
}

function showZoomPopup() {
  const zoomPopup = document.getElementById('zoom-popup') as HTMLElement;
  if (!zoomPopup) return;
  
  zoomPopup.style.display = 'flex';

  if (zoomPopupTimeout) {
    clearTimeout(zoomPopupTimeout);
  }

  zoomPopupTimeout = setTimeout(() => {
    zoomPopup.style.display = 'none';
  }, 2000);
}

async function zoomIn() {
  await updateZoomLevel(currentZoomLevel + 0.1);
}

async function zoomOut() {
  await updateZoomLevel(currentZoomLevel - 0.1);
}

async function zoomReset() {
  await updateZoomLevel(1.0);
}

async function init() {
  console.log('Init: Getting platform...');
  platformOS = await window.electronAPI.getPlatform();
  console.log('Init: Platform is', platformOS);
  
  console.log('Init: Loading settings...');
  await loadSettings();
  
  console.log('Init: Determining startup path...');
  let startupPath = currentSettings.startupPath && currentSettings.startupPath.trim() !== '' 
    ? currentSettings.startupPath 
    : await window.electronAPI.getHomeDirectory();
  console.log('Init: Startup path is', startupPath);
  
  console.log('Init: Navigating to startup path...');
  navigateTo(startupPath);
  
  console.log('Init: Setting up event listeners...');
  setupEventListeners();

  const isMas = await window.electronAPI.isMas();
  if (isMas) {
    const updateBtn = document.getElementById('check-updates-btn');
    if (updateBtn) {
      const container = updateBtn.closest('.setting-item') as HTMLElement;
      if (container) {
        container.style.display = 'none';
      } else {
        updateBtn.style.display = 'none';
      }
    }

    const restartAdminSetting = document.getElementById('restart-admin-setting');
    if (restartAdminSetting) {
      restartAdminSetting.remove();
    }
  }

  setTimeout(() => {
    console.log('Init: Loading bookmarks...');
    loadBookmarks();
    
    console.log('Init: Updating undo/redo state...');
    updateUndoRedoState();
    
    console.log('Init: Loading drives...');
    loadDrives();
    
    console.log('Init: Getting zoom level...');
    window.electronAPI.getZoomLevel().then(zoomResult => {
      if (zoomResult.success && zoomResult.zoomLevel) {
        currentZoomLevel = zoomResult.zoomLevel;
        updateZoomDisplay();
      }
    });

    window.electronAPI.onUpdateAvailable((info) => {
      console.log('Update available:', info);

      const settingsBtn = document.getElementById('settings-btn');
      if (settingsBtn) {
        if (!settingsBtn.querySelector('.notification-badge')) {
          const badge = document.createElement('span');
          badge.className = 'notification-badge';
          badge.textContent = '1';
          settingsBtn.style.position = 'relative';
          settingsBtn.appendChild(badge);
        }
      }

      const checkUpdatesBtn = document.getElementById('check-updates-btn');
      if (checkUpdatesBtn) {
        checkUpdatesBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1F389), 'twemoji')} Update Available!`;
        checkUpdatesBtn.classList.add('primary');
      }
    });
  }, 0);
  
  console.log('Init: Complete');
}

async function loadDrives() {
  if (!drivesList) return;
  
  const drives = await window.electronAPI.getDrives();
  drivesList.innerHTML = '';
  
  drives.forEach(drive => {
    const driveItem = document.createElement('div');
    driveItem.className = 'nav-item';
    driveItem.innerHTML = `
      <span class="nav-icon">${twemojiImg(String.fromCodePoint(0x1F4BE), 'twemoji')}</span>
      <span class="nav-label">${escapeHtml(drive)}</span>
    `;
    driveItem.addEventListener('click', () => navigateTo(drive));
    drivesList.appendChild(driveItem);
  });
}

function setupEventListeners() {
  initSettingsTabs();
  document.getElementById('minimize-btn')?.addEventListener('click', () => {
    window.electronAPI.minimizeWindow();
  });
  
  document.getElementById('maximize-btn')?.addEventListener('click', () => {
    window.electronAPI.maximizeWindow();
  });
  
  document.getElementById('close-btn')?.addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });
  
  backBtn?.addEventListener('click', goBack);
  forwardBtn?.addEventListener('click', goForward);
  upBtn?.addEventListener('click', goUp);
  undoBtn?.addEventListener('click', performUndo);
  redoBtn?.addEventListener('click', performRedo);
  refreshBtn?.addEventListener('click', refresh);
  newFileBtn?.addEventListener('click', createNewFile);
  newFolderBtn?.addEventListener('click', createNewFolder);
  viewToggleBtn?.addEventListener('click', toggleView);

  document.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      goForward();
    }
  });
  
  searchBtn?.addEventListener('click', toggleSearch);
  searchClose?.addEventListener('click', closeSearch);
  searchScopeToggle?.addEventListener('click', toggleSearchScope);
  sortBtn?.addEventListener('click', showSortMenu);
  bookmarkAddBtn?.addEventListener('click', addBookmark);
  
  searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      hideSearchHistoryDropdown();
      performSearch();
    }
  });
  
  searchInput?.addEventListener('input', () => {
    if (searchInput.value.length === 0) {
      closeSearch();
    }
  });
  
  addressInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      navigateTo(addressInput.value);
    }
  });

  function isModalOpen(): boolean {
    const settingsModal = document.getElementById('settings-modal');
    const shortcutsModal = document.getElementById('shortcuts-modal');
    const dialogModal = document.getElementById('dialog-modal');
    const licensesModal = document.getElementById('licenses-modal');
    const quicklookModal = document.getElementById('quicklook-modal');
    
    return (
      (settingsModal && settingsModal.style.display === 'flex') ||
      (shortcutsModal && shortcutsModal.style.display === 'flex') ||
      (dialogModal && dialogModal.style.display === 'flex') ||
      (licensesModal && licensesModal.style.display === 'flex') ||
      (quicklookModal && quicklookModal.style.display === 'flex')
    );
  }
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const settingsModal = document.getElementById('settings-modal');
      if (settingsModal && settingsModal.style.display === 'flex') {
        hideSettingsModal();
        return;
      }
      
      const shortcutsModal = document.getElementById('shortcuts-modal');
      if (shortcutsModal && shortcutsModal.style.display === 'flex') {
        hideShortcutsModal();
        return;
      }

      const contextMenu = document.getElementById('context-menu');
      if (contextMenu && contextMenu.style.display === 'block') {
        hideContextMenu();
        return;
      }

      const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
      if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block') {
        hideEmptySpaceContextMenu();
        return;
      }

      if (isSearchMode) {
        closeSearch();
      }
      return;
    }

    if (isModalOpen()) {
      return;
    }

    const hasTextSelection = (): boolean => {
      const selection = window.getSelection();
      return selection !== null && selection.toString().length > 0;
    };
    
    if (e.ctrlKey || e.metaKey) {
      if (e.key === ',') {
        e.preventDefault();
        showSettingsModal();
      } else if (e.key === '.') {
        e.preventDefault();
        showShortcutsModal();
      } else if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        openNewWindow();
      } else if (e.key === 'c') {
        if (hasTextSelection()) {
          return;
        }
        e.preventDefault();
        copyToClipboard();
      } else if (e.key === 'x') {
        if (hasTextSelection()) {
          return;
        }
        e.preventDefault();
        cutToClipboard();
      } else if (e.key === 'v') {
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
        pasteFromClipboard();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (e.shiftKey) {
          // Ctrl+Shift+F - Open search in global mode
          if (!isSearchMode) {
            searchBarWrapper.style.display = 'block';
            isSearchMode = true;
          }
          // Always set to global search mode
          isGlobalSearch = true;
          searchScopeToggle.classList.add('global');
          searchScopeToggle.title = 'Global Search (All Indexed Files)';
          const img = searchScopeToggle.querySelector('img');
          if (img) {
            img.src = 'assets/twemoji/1f30d.svg';
            img.alt = '🌍';
          }
          updateSearchPlaceholder();
          searchInput.focus();
        } else {
          if (!isSearchMode) {
            searchBarWrapper.style.display = 'block';
            isSearchMode = true;
          }
          isGlobalSearch = false;
          searchScopeToggle.classList.remove('global');
          searchScopeToggle.title = 'Local Search (Current Folder)';
          const img = searchScopeToggle.querySelector('img');
          if (img) {
            img.src = 'assets/twemoji/1f4c1.svg';
            img.alt = '📁';
          }
          updateSearchPlaceholder();
          searchInput.focus();
        }
      } else if (e.key === 'a') {
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
        selectAll();
      } else if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        performRedo();
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    } else if (e.key === ' ' && selectedItems.size === 1) {
      const activeElement = document.activeElement;
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
        return;
      }
      e.preventDefault();
      showQuickLook();
    } else if (e.key === 'F5') {
      e.preventDefault();
      refresh();
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameSelected();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (e.shiftKey) {
        permanentlyDeleteSelected();
      } else {
        deleteSelected();
      }
    }
  });
  
  document.querySelectorAll('.nav-item[data-action]').forEach(element => {
    const item = element as HTMLElement;
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      if (action === 'home') {
        const homeDir = await window.electronAPI.getHomeDirectory();
        navigateTo(homeDir);
      } else if (action === 'browse') {
        const result = await window.electronAPI.selectFolder();
        if (result.success) {
          navigateTo(result.path);
        }
      } else if (action === 'trash') {
        const result = await window.electronAPI.openTrash();
        if (result.success) {
          showToast('Opening system trash folder', 'Info', 'info');
        } else {
          showToast('Failed to open trash folder', 'Error', 'error');
        }
      }
    });
  });
  
  document.addEventListener('click', (e) => {
    const contextMenu = document.getElementById('context-menu');
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
    const sortMenu = document.getElementById('sort-menu');
    
    if (contextMenu && contextMenu.style.display === 'block' && !contextMenu.contains(e.target as Node)) {
      hideContextMenu();
    }
    if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block' && !emptySpaceContextMenu.contains(e.target as Node)) {
      hideEmptySpaceContextMenu();
    }
    if (sortMenu && sortMenu.style.display === 'block' && !sortMenu.contains(e.target as Node) && e.target !== sortBtn) {
      hideSortMenu();
    }
  });
  
  document.addEventListener('click', (e) => {
    const sortMenu = document.getElementById('sort-menu');
    const menuItem = (e.target as HTMLElement).closest('.context-menu-item') as HTMLElement;
    
    if (menuItem && sortMenu && sortMenu.style.display === 'block') {
      const sortType = menuItem.getAttribute('data-sort');
      if (sortType) {
        changeSortMode(sortType as any);
      }
      return;
    }
    
    if (menuItem && contextMenuData) {
      const format = menuItem.dataset.format;
      handleContextMenuAction(menuItem.dataset.action, contextMenuData, format);
      hideContextMenu();
    }
  });
  
  document.addEventListener('click', (e) => {
    const emptySpaceMenu = document.getElementById('empty-space-context-menu');
    const menuItem = (e.target as HTMLElement).closest('.context-menu-item') as HTMLElement;
    if (menuItem && emptySpaceMenu && emptySpaceMenu.style.display === 'block') {
      handleEmptySpaceContextMenuAction(menuItem.dataset.action);
      hideEmptySpaceContextMenu();
    }
  });
  
  if (fileGrid) {
    fileGrid.addEventListener('click', (e) => {
      if (e.target === fileGrid) {
        clearSelection();
      }
    });
    
    fileGrid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (!currentPath) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      fileGrid.classList.add('drag-over');
    });
    
    fileGrid.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const rect = fileGrid.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
          e.clientY < rect.top || e.clientY >= rect.bottom) {
        fileGrid.classList.remove('drag-over');
      }
    });
    
    fileGrid.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      fileGrid.classList.remove('drag-over');
      
      if ((e.target as HTMLElement).closest('.file-item')) {
        return;
      }
      
      const draggedPaths = JSON.parse(e.dataTransfer.getData('text/plain') || '[]');
    if (draggedPaths.length === 0 || !currentPath) {
      return;
    }
    
    const alreadyInCurrentDir = draggedPaths.some(path => {
      const parentDir = path.substring(0, path.lastIndexOf(path.includes('\\') ? '\\' : '/'));
      return parentDir === currentPath || path === currentPath;
    });
    
    if (alreadyInCurrentDir) {
      showToast('Items are already in this directory', 'Info', 'info');
      return;
    }
    
    const operation = e.ctrlKey ? 'copy' : 'move';
    await handleDrop(draggedPaths, currentPath, operation);
    });
  }
  
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target as HTMLElement).closest('.file-item')) {
      e.preventDefault();
      const target = e.target as HTMLElement;
      const clickedOnFileView = target.closest('#file-view') || 
                                 target.id === 'file-view' || 
                                 target.closest('.file-grid') || 
                                 target.id === 'file-grid' ||
                                 target.closest('.empty-state') ||
                                 target.id === 'empty-state';
      if (clickedOnFileView && currentPath) {
        showEmptySpaceContextMenu(e.pageX, e.pageY);
      } else {
        hideContextMenu();
        hideEmptySpaceContextMenu();
      }
    }
  });
}

function addToSearchHistory(query: string) {
  if (!currentSettings.enableSearchHistory || !query.trim()) return;
  if (!currentSettings.searchHistory) {
    currentSettings.searchHistory = [];
  }
  currentSettings.searchHistory = currentSettings.searchHistory.filter(item => item !== query);
  currentSettings.searchHistory.unshift(query);
  currentSettings.searchHistory = currentSettings.searchHistory.slice(0, 5);
  window.electronAPI.saveSettings(currentSettings);
}

function addToDirectoryHistory(dirPath: string) {
  if (!currentSettings.enableSearchHistory || !dirPath.trim()) return;
  if (!currentSettings.directoryHistory) {
    currentSettings.directoryHistory = [];
  }
  currentSettings.directoryHistory = currentSettings.directoryHistory.filter(item => item !== dirPath);
  currentSettings.directoryHistory.unshift(dirPath);
  currentSettings.directoryHistory = currentSettings.directoryHistory.slice(0, 5);
  window.electronAPI.saveSettings(currentSettings);
}

function showSearchHistoryDropdown() {
  const dropdown = document.getElementById('search-history-dropdown');
  if (!dropdown || !currentSettings.enableSearchHistory) return;
  
  const history = currentSettings.searchHistory || [];
  
  if (history.length === 0) {
    dropdown.innerHTML = '<div class="history-empty">No recent searches</div>';
  } else {
    dropdown.innerHTML = history.map(item => 
      `<div class="history-item" data-query="${escapeHtml(item)}">${twemojiImg(String.fromCodePoint(0x1F50D), 'twemoji')} ${escapeHtml(item)}</div>`
    ).join('') + `<div class="history-clear" data-action="clear-search">${twemojiImg(String.fromCodePoint(0x1F5D1), 'twemoji')} Clear Search History</div>`;
  }
  
  dropdown.style.display = 'block';
}

function showDirectoryHistoryDropdown() {
  const dropdown = document.getElementById('directory-history-dropdown');
  if (!dropdown || !currentSettings.enableSearchHistory) return;
  
  const history = currentSettings.directoryHistory || [];
  
  if (history.length === 0) {
    dropdown.innerHTML = '<div class="history-empty">No recent directories</div>';
  } else {
    dropdown.innerHTML = history.map(item => 
      `<div class="history-item" data-path="${escapeHtml(item)}">${twemojiImg(String.fromCodePoint(0x1F4C1), 'twemoji')} ${escapeHtml(item)}</div>`
    ).join('') + `<div class="history-clear" data-action="clear-directory">${twemojiImg(String.fromCodePoint(0x1F5D1), 'twemoji')} Clear Directory History</div>`;
  }
  
  dropdown.style.display = 'block';
}

function hideSearchHistoryDropdown() {
  const dropdown = document.getElementById('search-history-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function hideDirectoryHistoryDropdown() {
  const dropdown = document.getElementById('directory-history-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function clearSearchHistory() {
  currentSettings.searchHistory = [];
  window.electronAPI.saveSettings(currentSettings);
  hideSearchHistoryDropdown();
  showToast('Search history cleared', 'History', 'success');
}

function clearDirectoryHistory() {
  currentSettings.directoryHistory = [];
  window.electronAPI.saveSettings(currentSettings);
  hideDirectoryHistoryDropdown();
  showToast('Directory history cleared', 'History', 'success');
}

async function navigateTo(path: string) {
  if (!path) return;
  
  if (isSearchMode) {
    closeSearch();
  }
  
  if (loading) loading.style.display = 'flex';
  if (emptyState) emptyState.style.display = 'none';
  if (fileGrid) fileGrid.innerHTML = '';
  
  const result = await window.electronAPI.getDirectoryContents(path);
  
  if (result.success) {
    currentPath = path;
    if (addressInput) addressInput.value = path;
    addToDirectoryHistory(path);
    
    if (historyIndex === -1 || history[historyIndex] !== path) {
      history = history.slice(0, historyIndex + 1);
      history.push(path);
      historyIndex = history.length - 1;
    }
    
    updateNavigationButtons();
    renderFiles(result.contents);
    updateDiskSpace();
  } else {
    console.error('Error loading directory:', result.error);
    showToast(result.error, 'Error Loading Directory', 'error');
  }
  
  if (loading) loading.style.display = 'none';
}

function renderFiles(items: FileItem[]) {
  if (!fileGrid) return;
  
  fileGrid.innerHTML = '';
  clearSelection();
  allFiles = items;
  
  const visibleItems = currentSettings.showHiddenFiles 
    ? items 
    : items.filter(item => !item.isHidden);
  
  if (visibleItems.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    updateStatusBar();
    return;
  }
  
  const sortedItems = [...visibleItems].sort((a, b) => {
    const dirSort = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0);
    if (dirSort !== 0) return dirSort;
    
    let comparison = 0;
    const sortBy = currentSettings.sortBy || 'name';
    const sortOrder = currentSettings.sortOrder || 'asc';
    
    switch (sortBy) {
      case 'name':
        comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'date':
        comparison = new Date(a.modified).getTime() - new Date(b.modified).getTime();
        break;
      case 'size':
        comparison = a.size - b.size;
        break;
      case 'type':
        const extA = a.name.split('.').pop()?.toLowerCase() || '';
        const extB = b.name.split('.').pop()?.toLowerCase() || '';
        comparison = extA.localeCompare(extB);
        break;
      default:
        comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const fragment = document.createDocumentFragment();

  const batchSize = 50;
  let currentBatch = 0;
  
  const renderBatch = () => {
    const start = currentBatch * batchSize;
    const end = Math.min(start + batchSize, sortedItems.length);
    
    for (let i = start; i < end; i++) {
      const fileItem = createFileItem(sortedItems[i]);
      fragment.appendChild(fileItem);
    }
    
    fileGrid.appendChild(fragment);
    currentBatch++;
    
    if (end < sortedItems.length) {
      requestAnimationFrame(renderBatch);
    } else {
      updateCutVisuals();
      updateStatusBar();

      lazyLoadThumbnails();
    }
  };
  
  renderBatch();
}

let thumbnailObserver: IntersectionObserver | null = null;

function lazyLoadThumbnails() {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }
  
  thumbnailObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const fileItem = entry.target as HTMLElement;
        const path = fileItem.dataset.path;
        const item = allFiles.find(f => f.path === path);
        
        if (item && fileItem.classList.contains('has-thumbnail')) {
          loadThumbnail(fileItem, item);
          thumbnailObserver?.unobserve(fileItem);
        }
      }
    });
  }, {
    root: null,
    rootMargin: '50px',
    threshold: 0.01
  });

  document.querySelectorAll('.file-item.has-thumbnail').forEach(item => {
    thumbnailObserver?.observe(item);
  });
}

function createFileItem(item: FileItem): HTMLElement {
  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.dataset.path = item.path;
  fileItem.dataset.isDirectory = String(item.isDirectory);
  
  const icon = item.isDirectory ? twemojiImg(String.fromCodePoint(0x1F4C1), 'twemoji file-icon') : getFileIcon(item.name);
  const ext = item.name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico'];
  const isImage = !item.isDirectory && imageExts.includes(ext);
  
  if (isImage) {
    fileItem.classList.add('has-thumbnail');
    fileItem.innerHTML = `
      <div class="file-icon">
        ${getFileIcon(item.name)}
      </div>
      <div class="file-name">${escapeHtml(item.name)}</div>
    `;
  } else {
    fileItem.innerHTML = `
      <div class="file-icon">${icon}</div>
      <div class="file-name">${escapeHtml(item.name)}</div>
    `;
  }
  
  fileItem.addEventListener('dblclick', () => {
    if (item.isDirectory) {
      navigateTo(item.path);
    } else {
      window.electronAPI.openFile(item.path);
    }
  });
  
  fileItem.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!e.ctrlKey && !e.metaKey) {
      clearSelection();
    }
    toggleSelection(fileItem);
  });
  
  fileItem.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!fileItem.classList.contains('selected')) {
      clearSelection();
      toggleSelection(fileItem);
    }
    showContextMenu(e.pageX, e.pageY, item);
  });
  
  fileItem.draggable = true;
  
  fileItem.addEventListener('dragstart', (e) => {
    e.stopPropagation();

    if (!fileItem.classList.contains('selected')) {
      clearSelection();
      toggleSelection(fileItem);
    }
    
    const selectedPaths = Array.from(selectedItems);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', JSON.stringify(selectedPaths));
    
    fileItem.classList.add('dragging');

    if (selectedPaths.length > 1) {
      const dragImage = document.createElement('div');
      dragImage.className = 'drag-image';
      dragImage.textContent = `${selectedPaths.length} items`;
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      document.body.appendChild(dragImage);
      e.dataTransfer.setDragImage(dragImage, 0, 0);
      setTimeout(() => dragImage.remove(), 0);
    }
  });
  
  fileItem.addEventListener('dragend', (e) => {
    fileItem.classList.remove('dragging');
    document.querySelectorAll('.file-item.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    document.getElementById('file-grid')?.classList.remove('drag-over');
  });

  if (item.isDirectory) {
    fileItem.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const draggedPaths = JSON.parse(e.dataTransfer.getData('text/plain') || '[]');
      if (draggedPaths.includes(item.path)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      fileItem.classList.add('drag-over');
    });
    
    fileItem.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = fileItem.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
          e.clientY < rect.top || e.clientY >= rect.bottom) {
        fileItem.classList.remove('drag-over');
      }
    });
    
    fileItem.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      fileItem.classList.remove('drag-over');
      
      const draggedPaths = JSON.parse(e.dataTransfer.getData('text/plain') || '[]');
      if (draggedPaths.length === 0 || draggedPaths.includes(item.path)) {
        return;
      }
      
      const operation = e.ctrlKey ? 'copy' : 'move';
      await handleDrop(draggedPaths, item.path, operation);
    });
  }
  
  return fileItem;
}

async function loadThumbnail(fileItem: HTMLElement, item: FileItem) {
  try {
    const iconDiv = fileItem.querySelector('.file-icon');

    if (iconDiv) {
      iconDiv.innerHTML = `<div class="spinner" style="width: 30px; height: 30px; border-width: 2px;"></div>`;
    }
    
    const result = await window.electronAPI.getFileDataUrl(item.path, 500 * 1024);
    
    if (result.success && result.dataUrl && iconDiv) {
      iconDiv.innerHTML = `<img src="${result.dataUrl}" class="file-thumbnail" alt="${item.name}">`;
    } else {
      if (iconDiv) {
        iconDiv.innerHTML = getFileIcon(item.name);
      }
      fileItem.classList.remove('has-thumbnail');
    }
  } catch (error) {
    const iconDiv = fileItem.querySelector('.file-icon');
    if (iconDiv) {
      iconDiv.innerHTML = getFileIcon(item.name);
    }
    fileItem.classList.remove('has-thumbnail');
  }
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap: Record<string, string> = {
    'jpg': '1f5bc', 'jpeg': '1f5bc', 'png': '1f5bc', 'gif': '1f5bc', 'svg': '1f5bc', 'bmp': '1f5bc',
    'mp4': '1f3ac', 'avi': '1f3ac', 'mov': '1f3ac', 'mkv': '1f3ac', 'webm': '1f3ac',
    'mp3': '1f3b5', 'wav': '1f3b5', 'flac': '1f3b5', 'ogg': '1f3b5', 'm4a': '1f3b5',
    'pdf': '1f4c4', 'doc': '1f4dd', 'docx': '1f4dd', 'txt': '1f4dd', 'rtf': '1f4dd',
    'xls': '1f4ca', 'xlsx': '1f4ca', 'csv': '1f4ca',
    'ppt': '1f4ca', 'pptx': '1f4ca',
    'js': '1f4dc', 'ts': '1f4dc', 'jsx': '1f4dc', 'tsx': '1f4dc',
    'html': '1f310', 'css': '1f3a8', 'json': '2699', 'xml': '2699',
    'py': '1f40d', 'java': '2615', 'c': 'a9', 'cpp': 'a9', 'cs': 'a9',
    'php': '1f418', 'rb': '1f48e', 'go': '1f439', 'rs': '1f980',
    'zip': '1f5dc', 'rar': '1f5dc', '7z': '1f5dc', 'tar': '1f5dc', 'gz': '1f5dc',
    'exe': '2699', 'app': '2699', 'msi': '2699', 'dmg': '2699'
  };
  
  const codepoint = iconMap[ext] || '1f4c4';
  return twemojiImg(String.fromCodePoint(parseInt(codepoint, 16)), 'twemoji');
}

async function handleDrop(sourcePaths: string[], destPath: string, operation: 'copy' | 'move'): Promise<void> {
  try {
    const result = operation === 'copy' 
      ? await window.electronAPI.copyItems(sourcePaths, destPath)
      : await window.electronAPI.moveItems(sourcePaths, destPath);
    
    if (result.success) {
      showToast(`${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s)`, 'Success', 'success');
      
      if (operation === 'move') {
        await updateUndoRedoState();
      }
      
      await navigateTo(currentPath);
      clearSelection();
    } else {
      showToast(result.error || `Failed to ${operation} items`, 'Error', 'error');
    }
  } catch (error) {
    console.error(`Error during ${operation}:`, error);
    showToast(`Failed to ${operation} items`, 'Error', 'error');
  }
}

function toggleSelection(fileItem: HTMLElement) {
  fileItem.classList.toggle('selected');
  if (fileItem.classList.contains('selected')) {
    selectedItems.add(fileItem.dataset.path);
  } else {
    selectedItems.delete(fileItem.dataset.path);
  }
  updateStatusBar();
  
  if (isPreviewPanelVisible && selectedItems.size === 1) {
    const selectedPath = Array.from(selectedItems)[0];
    const file = allFiles.find(f => f.path === selectedPath);
    if (file && file.isFile) {
           updatePreview(file);
    } else {
      showEmptyPreview();
    }
  } else if (isPreviewPanelVisible && selectedItems.size !== 1) {
    showEmptyPreview();
  }
}

function clearSelection() {
  document.querySelectorAll('.file-item.selected').forEach(item => {
    item.classList.remove('selected');
  });
  selectedItems.clear();
  updateStatusBar();
  
  if (isPreviewPanelVisible) {
    showEmptyPreview();
  }
}

function selectAll() {
  document.querySelectorAll('.file-item').forEach(item => {
    item.classList.add('selected');
    selectedItems.add(item.getAttribute('data-path'));
  });
  updateStatusBar();
}

async function renameSelected() {
  if (selectedItems.size !== 1) return;
  const itemPath = Array.from(selectedItems)[0];
  const fileItems = document.querySelectorAll('.file-item');
  for (const fileItem of Array.from(fileItems)) {
    if (fileItem.getAttribute('data-path') === itemPath) {
      const item = allFiles.find(f => f.path === itemPath);
      if (item) {
        startInlineRename(fileItem as HTMLElement, item.name, item.path);
      }
      break;
    }
  }
}

async function deleteSelected() {
  if (selectedItems.size === 0) return;
  
  const count = selectedItems.size;
  const confirmed = await showConfirm(
    `Move ${count} item${count > 1 ? 's' : ''} to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}?`,
    'Move to Trash',
    'warning'
  );
  
  if (confirmed) {
    let successCount = 0;
    for (const itemPath of selectedItems) {
      const result = await window.electronAPI.trashItem(itemPath);
      if (result.success) successCount++;
    }
    
    if (successCount > 0) {
      showToast(`${successCount} item${successCount > 1 ? 's' : ''} moved to ${platformOS === 'win32' ? 'Recycle Bin' : 'Trash'}`, 'Success', 'success');
      await updateUndoRedoState();
      refresh();
    }
  }
}

async function permanentlyDeleteSelected() {
  if (selectedItems.size === 0) return;
  
  const count = selectedItems.size;
  const confirmed = await showConfirm(
    `${twemojiImg(String.fromCodePoint(0x26A0), 'twemoji')} PERMANENTLY delete ${count} item${count > 1 ? 's' : ''}? This CANNOT be undone!`,
    'Permanent Delete',
    'error'
  );
  
  if (confirmed) {
    let successCount = 0;
    for (const itemPath of selectedItems) {
      const result = await window.electronAPI.deleteItem(itemPath);
      if (result.success) successCount++;
    }
    
    if (successCount > 0) {
      showToast(`${successCount} item${successCount > 1 ? 's' : ''} permanently deleted`, 'Success', 'success');
      refresh();
    }
  }
}

async function updateUndoRedoState() {
  const state = await window.electronAPI.getUndoRedoState();
  canUndo = state.canUndo;
  canRedo = state.canRedo;
  
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  if (undoBtn) undoBtn.disabled = !canUndo;
  if (redoBtn) redoBtn.disabled = !canRedo;
}

async function performUndo() {
  const result = await window.electronAPI.undoAction();
  if (result.success) {
    showToast('Action undone', 'Undo', 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || 'Cannot undo', 'Undo Failed', 'warning');
    await updateUndoRedoState();
  }
}

async function performRedo() {
  const result = await window.electronAPI.redoAction();
  if (result.success) {
    showToast('Action redone', 'Redo', 'success');
    await updateUndoRedoState();
    refresh();
  } else {
    showToast(result.error || 'Cannot redo', 'Redo Failed', 'warning');
    await updateUndoRedoState();
  }
}


function goBack() {
  if (historyIndex > 0) {
    historyIndex--;
    const path = history[historyIndex];
    navigateTo(path);
  }
}

function goForward() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    const path = history[historyIndex];
    navigateTo(path);
  }
}

function goUp() {
  if (!currentPath) return;
  const parentPath = currentPath.split(/[\\/]/).slice(0, -1).join('/') || 
                     (currentPath.includes(':\\') ? currentPath.split(':\\')[0] + ':\\' : '/');
  navigateTo(parentPath);
}

function refresh() {
  if (currentPath) {
    navigateTo(currentPath);
  }
}

function updateNavigationButtons() {
  backBtn.disabled = historyIndex <= 0;
  forwardBtn.disabled = historyIndex >= history.length - 1;
  upBtn.disabled = !currentPath || currentPath === '/' || currentPath.endsWith(':\\');
}

function toggleView() {
  viewMode = viewMode === 'grid' ? 'list' : 'grid';
  fileGrid.className = viewMode === 'list' ? 'file-grid list-view' : 'file-grid';
  updateViewToggleButton();
}

function updateViewToggleButton() {
  if (viewMode === 'list') {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="3" width="12" height="2" fill="currentColor" rx="1"/>
        <rect x="2" y="7" width="12" height="2" fill="currentColor" rx="1"/>
        <rect x="2" y="11" width="12" height="2" fill="currentColor" rx="1"/>
      </svg>
    `;
  } else {
    viewToggleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16">
        <rect x="2" y="2" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="9" y="2" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="2" y="9" width="5" height="5" fill="currentColor" rx="1"/>
        <rect x="9" y="9" width="5" height="5" fill="currentColor" rx="1"/>
      </svg>
    `;
  }
}

async function createNewFile() {
  await createNewFileWithInlineRename();
}

async function createNewFolder() {
  await createNewFolderWithInlineRename();
}

async function createNewFileWithInlineRename() {
  let fileName = 'File';
  let counter = 1;
  let finalFileName = fileName;
  
  const existingFiles = Array.from(document.querySelectorAll('.file-item')).map(item => {
    return item.querySelector('.file-name')?.textContent || '';
  });
  
  while (existingFiles.includes(finalFileName)) {
    finalFileName = `${fileName} (${counter})`;
    counter++;
  }
  
  const result = await window.electronAPI.createFile(currentPath, finalFileName);
  if (result.success) {
    const createdFilePath = result.path;
    await navigateTo(currentPath);
    
    setTimeout(() => {
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFileName) {
          startInlineRename(item as HTMLElement, finalFileName, createdFilePath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error, 'Error Creating File', 'error');
  }
}

async function createNewFolderWithInlineRename() {
  let folderName = 'New Folder';
  let counter = 1;
  let finalFolderName = folderName;
  
  const existingFolders = Array.from(document.querySelectorAll('.file-item')).map(item => {
    return item.querySelector('.file-name')?.textContent || '';
  });
  
  while (existingFolders.includes(finalFolderName)) {
    finalFolderName = `${folderName} (${counter})`;
    counter++;
  }
  
  const result = await window.electronAPI.createFolder(currentPath, finalFolderName);
  if (result.success) {
    const createdFolderPath = result.path;
    await navigateTo(currentPath);
    
    setTimeout(() => {
      const fileItems = document.querySelectorAll('.file-item');
      for (const item of Array.from(fileItems)) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFolderName) {
          startInlineRename(item as HTMLElement, finalFolderName, createdFolderPath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error, 'Error Creating Folder', 'error');
  }
}

function startInlineRename(fileItem: HTMLElement, currentName: string, itemPath: string) {
  const nameElement = fileItem.querySelector('.file-name') as HTMLElement | null;
  if (!nameElement) return;
  
  nameElement.style.display = 'none';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-input';
  input.value = currentName;
  fileItem.appendChild(input);
  
  fileItem.classList.add('renaming');
  
  input.focus();
  
  const lastDotIndex = currentName.lastIndexOf('.');
  if (lastDotIndex > 0) {
    input.setSelectionRange(0, lastDotIndex);
  } else {
    input.select();
  }
  
  let renameHandled = false;

  const finishRename = async () => {
    if (renameHandled) {
      return;
    }
    renameHandled = true;

    input.removeEventListener('blur', finishRename);
    input.removeEventListener('keypress', handleKeyPress);
    input.removeEventListener('keydown', handleKeyDown);

    const newName = input.value.trim();
    
    if (newName && newName !== currentName) {
      const result = await window.electronAPI.renameItem(itemPath, newName);
      if (result.success) {
        await navigateTo(currentPath);
      } else {
        await showAlert(result.error, 'Error Renaming', 'error');
        nameElement.style.display = '';
        input.remove();
        fileItem.classList.remove('renaming');
      }
    } else {
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    }
  };
  
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      finishRename();
    }
  };
  
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      renameHandled = true;
      input.removeEventListener('blur', finishRename);
      input.removeEventListener('keypress', handleKeyPress);
      input.removeEventListener('keydown', handleKeyDown);
      nameElement.style.display = '';
      input.remove();
      fileItem.classList.remove('renaming');
    }
  };
  
  input.addEventListener('blur', finishRename);
  input.addEventListener('keypress', handleKeyPress);
  input.addEventListener('keydown', handleKeyDown);
}

function showContextMenu(x: number, y: number, item: FileItem) {
  const contextMenu = document.getElementById('context-menu');
  const addToBookmarksItem = document.getElementById('add-to-bookmarks-item');
  const copyPathItem = document.getElementById('copy-path-item');
  const openTerminalItem = document.getElementById('open-terminal-item');
  const compressItem = document.getElementById('compress-item');
  const extractItem = document.getElementById('extract-item');
  
  if (!contextMenu) return;
  
  hideEmptySpaceContextMenu();
  
  contextMenuData = item;
  
  if (addToBookmarksItem) {
    if (item.isDirectory) {
      addToBookmarksItem.style.display = 'flex';
    } else {
      addToBookmarksItem.style.display = 'none';
    }
  }
  
  if (copyPathItem) {
    if (!item.isDirectory) {
      copyPathItem.style.display = 'flex';
    } else {
      copyPathItem.style.display = 'none';
    }
  }
  
  if (openTerminalItem) {
    if (item.isDirectory) {
      openTerminalItem.style.display = 'flex';
    } else {
      openTerminalItem.style.display = 'none';
    }
  }

  if (compressItem) {
    compressItem.style.display = 'flex';
  }

  if (extractItem) {
    const fileName = item.name.toLowerCase();
    const isArchive = fileName.endsWith('.zip') || 
                      fileName.endsWith('.tar.gz') || 
                      fileName.endsWith('.tgz') ||
                      fileName.endsWith('.7z') ||
                      fileName.endsWith('.rar') ||
                      fileName.endsWith('.tar') ||
                      fileName.endsWith('.gz') ||
                      fileName.endsWith('.bz2') ||
                      fileName.endsWith('.xz') ||
                      fileName.endsWith('.iso') ||
                      fileName.endsWith('.cab') ||
                      fileName.endsWith('.arj') ||
                      fileName.endsWith('.lzh') ||
                      fileName.endsWith('.wim');
    
    if (isArchive && !item.isDirectory) {
      extractItem.style.display = 'flex';
    } else {
      extractItem.style.display = 'none';
    }
  }
  
  contextMenu.style.display = 'block';
  
  const menuRect = contextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  let left = x;
  let top = y;
  
  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }
  
  if (top + menuRect.height > viewportHeight) {
    top = viewportHeight - menuRect.height - 10;
  }
  
  if (left < 10) left = 10;
  if (top < 10) top = 10;
  
  contextMenu.style.left = left + 'px';
  contextMenu.style.top = top + 'px';
}

function hideContextMenu() {
  const contextMenuElement = document.getElementById('context-menu');
  if (contextMenuElement) {
    contextMenuElement.style.display = 'none';
    contextMenuData = null;
  }
}

function showEmptySpaceContextMenu(x, y) {
  const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
  if (!emptySpaceContextMenu) return;
  
  hideContextMenu();
  
  emptySpaceContextMenu.style.display = 'block';
  
  const menuRect = emptySpaceContextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  let left = x;
  let top = y;
  
  if (left + menuRect.width > viewportWidth) {
    left = viewportWidth - menuRect.width - 10;
  }
  
  if (top + menuRect.height > viewportHeight) {
    top = viewportHeight - menuRect.height - 10;
  }
  
  if (left < 10) left = 10;
  if (top < 10) top = 10;
  
  emptySpaceContextMenu.style.left = left + 'px';
  emptySpaceContextMenu.style.top = top + 'px';
}

function hideEmptySpaceContextMenu() {
  const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
  if (emptySpaceContextMenu) {
    emptySpaceContextMenu.style.display = 'none';
  }
}

async function handleEmptySpaceContextMenuAction(action: string | undefined) {
  switch (action) {
    case 'new-folder':
      await createNewFolderWithInlineRename();
      break;
      
    case 'new-file':
      await createNewFileWithInlineRename();
      break;
      
    case 'paste':
      await pasteFromClipboard();
      break;
      
    case 'refresh':
      await navigateTo(currentPath);
      break;
      
    case 'open-terminal':
      const terminalResult = await window.electronAPI.openTerminal(currentPath);
      if (!terminalResult.success) {
        showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
      }
      break;
  }
  
  hideEmptySpaceContextMenu();
}

async function handleContextMenuAction(action: string | undefined, item: FileItem, format?: string) {
  switch (action) {
    case 'open':
      if (item.isDirectory) {
        navigateTo(item.path);
      } else {
        window.electronAPI.openFile(item.path);
      }
      break;
      
    case 'rename':
      const fileItems = document.querySelectorAll('.file-item');
      for (const fileItem of Array.from(fileItems)) {
        if ((fileItem as HTMLElement).dataset.path === item.path) {
          startInlineRename(fileItem as HTMLElement, item.name, item.path);
          break;
        }
      }
      break;
      
    case 'copy':
      copyToClipboard();
      break;
      
    case 'cut':
      cutToClipboard();
      break;
      
    case 'copy-path':
      try {
        await navigator.clipboard.writeText(item.path);
        showToast('File path copied to clipboard', 'Success', 'success');
      } catch (error) {
        showToast('Failed to copy file path', 'Error', 'error');
      }
      break;
      
    case 'add-to-bookmarks':
      if (item.isDirectory) {
        await addBookmarkByPath(item.path);
      }
      break;
      
    case 'open-terminal':
      const terminalPath = item.isDirectory ? item.path : path.dirname(item.path);
      const terminalResult = await window.electronAPI.openTerminal(terminalPath);
      if (!terminalResult.success) {
        showToast(terminalResult.error || 'Failed to open terminal', 'Error', 'error');
      }
      break;
      
    case 'properties':
      const propsResult = await window.electronAPI.getItemProperties(item.path);
      if (propsResult.success) {
        showPropertiesDialog(propsResult.properties);
      } else {
        showToast(propsResult.error, 'Error Getting Properties', 'error');
      }
      break;
      
    case 'delete':
      await deleteSelected();
      break;
      
    case 'compress':
      await handleCompress(format || 'zip');
      break;
      
    case 'extract':
      await handleExtract(item);
      break;
  }
}

async function handleCompress(format: string = 'zip') {
  const selectedPaths = Array.from(selectedItems);
  
  if (selectedPaths.length === 0) {
    showToast('No items selected', 'Error', 'error');
    return;
  }

  const extensionMap: Record<string, string> = {
    'zip': '.zip',
    '7z': '.7z',
    'tar': '.tar',
    'tar.gz': '.tar.gz'
  };
  
  const extension = extensionMap[format] || '.zip';

  let archiveName: string;
  if (selectedPaths.length === 1) {
    const itemName = path.basename(selectedPaths[0]);
    const nameWithoutExt = itemName.replace(/\.[^/.]+$/, '');
    archiveName = `${nameWithoutExt}${extension}`;
  } else {
    const folderName = path.basename(currentPath);
    archiveName = `${folderName}_${selectedPaths.length}_items${extension}`;
  }
  
  const outputPath = path.join(currentPath, archiveName);
  const operationId = generateOperationId();

  addOperation(operationId, 'compress', archiveName);

  const progressHandler = (progress: {operationId?: string; current: number; total: number; name: string}) => {
    if (progress.operationId === operationId) {
      const operation = activeOperations.get(operationId);
      if (operation && !operation.aborted) {
        updateOperation(operationId, progress.current, progress.total, progress.name);
      }
    }
  };
  
  window.electronAPI.onCompressProgress(progressHandler);
  
  try {
    const operation = activeOperations.get(operationId);
    if (operation?.aborted) {
      removeOperation(operationId);
      return;
    }
    
    const result = await window.electronAPI.compressFiles(selectedPaths, outputPath, format, operationId);
    
    removeOperation(operationId);
    
    if (result.success) {
      showToast(`Created ${archiveName}`, 'Compressed Successfully', 'success');
      await navigateTo(currentPath);
    } else {
      showToast(result.error || 'Compression failed', 'Error', 'error');
    }
  } catch (error) {
    removeOperation(operationId);
    showToast((error as Error).message, 'Compression Error', 'error');
  }
}

async function handleExtract(item: FileItem) {
  const ext = path.extname(item.path).toLowerCase();
  const supportedFormats = ['.zip', '.tar.gz', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab', '.arj', '.lzh', '.wim'];

  const isSupported = supportedFormats.some(format => item.path.toLowerCase().endsWith(format));
  
  if (!isSupported) {
    showToast('Unsupported archive format. Supported: .zip, .7z, .rar, .tar.gz, and more', 'Error', 'error');
    return;
  }

  let baseName = path.basename(item.path);
  if (item.path.toLowerCase().endsWith('.tar.gz')) {
    baseName = baseName.replace(/\.tar\.gz$/i, '');
  } else {
    baseName = path.basename(item.path, ext);
  }
  const destPath = path.join(currentPath, baseName);
  const operationId = generateOperationId();

  addOperation(operationId, 'extract', baseName);

  const progressHandler = (progress: {operationId?: string; current: number; total: number; name: string}) => {
    if (progress.operationId === operationId) {
      const operation = activeOperations.get(operationId);
      if (operation && !operation.aborted) {
        updateOperation(operationId, progress.current, progress.total, progress.name);
      }
    }
  };
  
  window.electronAPI.onExtractProgress(progressHandler);
  
  try {
    const operation = activeOperations.get(operationId);
    if (operation?.aborted) {
      removeOperation(operationId);
      return;
    }
    
    const result = await window.electronAPI.extractArchive(item.path, destPath, operationId);
    
    removeOperation(operationId);
    
    if (result.success) {
      showToast(`Extracted to ${baseName}`, 'Extraction Complete', 'success');
      await navigateTo(currentPath);
    } else {
      showToast(result.error || 'Extraction failed', 'Error', 'error');
    }
  } catch (error) {
    removeOperation(operationId);
    showToast((error as Error).message, 'Extraction Error', 'error');
  }
}

function showPropertiesDialog(props: ItemProperties) {
  const modal = document.getElementById('properties-modal');
  const content = document.getElementById('properties-content');
  
  const sizeInKB = (props.size / 1024).toFixed(2);
  const sizeInMB = (props.size / (1024 * 1024)).toFixed(2);
  const sizeDisplay = props.size > 1024 * 1024 ? `${sizeInMB} MB` : `${sizeInKB} KB`;
  
  content.innerHTML = `
    <div class="property-row">
      <div class="property-label">Name:</div>
      <div class="property-value">${escapeHtml(props.name)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Type:</div>
      <div class="property-value">${props.isDirectory ? 'Folder' : 'File'}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Size:</div>
      <div class="property-value">${props.size.toLocaleString()} bytes (${sizeDisplay})</div>
    </div>
    <div class="property-row">
      <div class="property-label">Location:</div>
      <div class="property-value">${escapeHtml(props.path)}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Created:</div>
      <div class="property-value">${new Date(props.created).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Modified:</div>
      <div class="property-value">${new Date(props.modified).toLocaleString()}</div>
    </div>
    <div class="property-row">
      <div class="property-label">Accessed:</div>
      <div class="property-value">${new Date(props.accessed).toLocaleString()}</div>
    </div>
  `;
  
  modal.style.display = 'flex';
  
  const closeModal = () => {
    modal.style.display = 'none';
  };
  
  document.getElementById('properties-close').onclick = closeModal;
  document.getElementById('properties-ok').onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };
}

async function restartAsAdmin() {
  const confirmed = await showDialog(
    'Restart as Administrator',
    "Restarting the app with elevated permissions can lead to possible damage of your computer/files if you don't know what you're doing.",
    'warning',
    true
  );
  
  if (confirmed) {
    const result = await window.electronAPI.restartAsAdmin();
    if (!result.success) {
      showToast(result.error || 'Failed to restart with admin privileges', 'Restart Failed', 'error');
    }
  }
}

function stripHtmlTags(html: string): string {
  let text = html.replace(/<[^>]*>/g, '');
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/!\[.*?\]\(.*?\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  return text;
}

async function checkForUpdates() {
  const btn = document.getElementById('check-updates-btn') as HTMLButtonElement;
  if (!btn) return;
  
  const originalHTML = btn.innerHTML;
  btn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1F504), 'twemoji')} Checking...`;
  btn.disabled = true;
  
  try {
    const result = await window.electronAPI.checkForUpdates();
    
    if (result.success) {
      if (result.isFlatpak) {
        showDialog(
          'Updates via Flatpak',
          `You're running IYERIS as a Flatpak (${result.currentVersion}).\n\n${result.flatpakMessage}\n\nOr use your system's software center to check for updates.`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMas) {
        showDialog(
          'Updates via App Store',
          `You're running IYERIS from the Mac App Store (${result.currentVersion}).\n\n${result.masMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.isMsi) {
        showDialog(
          'Enterprise Installation',
          `You're running IYERIS as an enterprise installation (${result.currentVersion}).\n\n${result.msiMessage}`,
          'info',
          false
        );
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        return;
      }

      if (result.hasUpdate) {
        const confirmed = await showDialog(
          'Update Available',
          `A new version is available!\n\nCurrent Version: ${result.currentVersion}\nNew Version: ${result.latestVersion}\n\nWould you like to download and install the update?`,
          'success',
          true
        );
        
        if (confirmed) {
          await downloadAndInstallUpdate();
        }
      } else {
        showDialog(
          'No Updates Available',
          `You're running the latest version (${result.currentVersion})!`,
          'info',
          false
        );
      }
    } else {
      showDialog(
        'Update Check Failed',
        `Failed to check for updates: ${result.error}`,
        'error',
        false
      );
    }
  } catch (error) {
    showDialog(
      'Update Check Failed',
      `An error occurred while checking for updates: ${(error as Error).message}`,
      'error',
      false
    );
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

async function downloadAndInstallUpdate() {
  const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
  const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
  const dialogContent = document.getElementById('dialog-content') as HTMLElement;
  const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
  const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
  const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;
  
  dialogIcon.textContent = '⬇️';
  dialogTitle.textContent = 'Downloading Update';
  dialogContent.textContent = 'Preparing download... 0%';
  dialogOk.style.display = 'none';
  dialogCancel.style.display = 'none';
  dialogModal.style.display = 'flex';
  
  window.electronAPI.onUpdateDownloadProgress((progress) => {
    const percent = progress.percent.toFixed(1);
    const transferred = formatFileSize(progress.transferred);
    const total = formatFileSize(progress.total);
    const speed = formatFileSize(progress.bytesPerSecond);
    
    dialogContent.textContent = `Downloading update...\n\n${percent}% (${transferred} / ${total})\nSpeed: ${speed}/s`;
  });
  
  try {
    const downloadResult = await window.electronAPI.downloadUpdate();
    
    if (!downloadResult.success) {
      dialogModal.style.display = 'none';
      showDialog(
        'Download Failed',
        `Failed to download update: ${downloadResult.error}`,
        'error',
        false
      );
      return;
    }
    
    dialogIcon.innerHTML = twemojiImg(String.fromCodePoint(0x2705), 'twemoji-large');
    dialogTitle.textContent = 'Update Downloaded';
    dialogContent.textContent = 'The update has been downloaded successfully.\n\nThe application will restart to install the update.';
    dialogOk.style.display = 'block';
    dialogOk.textContent = 'Install & Restart';
    dialogCancel.style.display = 'block';
    dialogCancel.textContent = 'Later';
    
    const installPromise = new Promise<boolean>((resolve) => {
      const handleOk = () => {
        cleanup();
        resolve(true);
      };
      
      const handleCancel = () => {
        cleanup();
        resolve(false);
      };
      
      const cleanup = () => {
        dialogOk.removeEventListener('click', handleOk);
        dialogCancel.removeEventListener('click', handleCancel);
      };
      
      dialogOk.addEventListener('click', handleOk);
      dialogCancel.addEventListener('click', handleCancel);
    });
    
    const shouldInstall = await installPromise;
    dialogModal.style.display = 'none';
    
    if (shouldInstall) {
      await window.electronAPI.installUpdate();
    }
  } catch (error) {
    dialogModal.style.display = 'none';
    showDialog(
      'Update Error',
      `An error occurred during the update process: ${(error as Error).message}`,
      'error',
      false
    );
  }
}

function initSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  const sections = document.querySelectorAll('.settings-section');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs
      tabs.forEach(t => t.classList.remove('active'));
      // Add active class to clicked tab
      tab.classList.add('active');

      // Hide all sections
      sections.forEach(section => section.classList.remove('active'));
      
      // Show target section
      const targetId = `tab-${tab.getAttribute('data-tab')}`;
      const targetSection = document.getElementById(targetId);
      if (targetSection) {
        targetSection.classList.add('active');
      }
    });
  });
}

document.getElementById('settings-btn')?.addEventListener('click', showSettingsModal);
document.getElementById('settings-close')?.addEventListener('click', hideSettingsModal);
document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
document.getElementById('reset-settings-btn')?.addEventListener('click', resetSettings);
document.getElementById('dangerous-options-toggle')?.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  updateDangerousOptionsVisibility(target.checked);
});
document.getElementById('browse-startup-path-btn')?.addEventListener('click', async () => {
  const result = await window.electronAPI.selectFolder();
  if (result.success && result.path) {
    const startupPathInput = document.getElementById('startup-path-input') as HTMLInputElement;
    if (startupPathInput) {
      startupPathInput.value = result.path;
    }
  }
});
document.getElementById('rebuild-index-btn')?.addEventListener('click', rebuildIndex);
document.getElementById('restart-admin-btn')?.addEventListener('click', restartAsAdmin);
document.getElementById('check-updates-btn')?.addEventListener('click', checkForUpdates);
document.getElementById('github-btn')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://github.com/BurntToasters/IYERIS');
});
document.getElementById('rosie-link')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://rosie.run/support');
});
document.getElementById('twemoji-cc-link')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://github.com/jdecked/twemoji');
});
document.getElementById('help-link')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://help.rosie.run/iyeris/en-us/faq');
});
document.getElementById('heart-button')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://rosie.run/support');
});
document.getElementById('version-indicator')?.addEventListener('click', () => {
  const version = document.getElementById('version-indicator')?.textContent || 'v0.1.0';
  window.electronAPI.openFile(`https://github.com/BurntToasters/IYERIS/releases/tag/${version}`);
});

document.getElementById('zoom-in-btn')?.addEventListener('click', zoomIn);
document.getElementById('zoom-out-btn')?.addEventListener('click', zoomOut);
document.getElementById('zoom-reset-btn')?.addEventListener('click', zoomReset);

document.getElementById('licenses-btn')?.addEventListener('click', showLicensesModal);
document.getElementById('licenses-close')?.addEventListener('click', hideLicensesModal);
document.getElementById('close-licenses-btn')?.addEventListener('click', hideLicensesModal);
document.getElementById('copy-licenses-btn')?.addEventListener('click', copyLicensesText);

document.getElementById('shortcuts-close')?.addEventListener('click', hideShortcutsModal);
document.getElementById('close-shortcuts-btn')?.addEventListener('click', hideShortcutsModal);

const settingsModal = document.getElementById('settings-modal');
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'settings-modal') {
      hideSettingsModal();
    }
  });
}

const licensesModal = document.getElementById('licenses-modal');
if (licensesModal) {
  licensesModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'licenses-modal') {
      hideLicensesModal();
    }
  });
}

const shortcutsModal = document.getElementById('shortcuts-modal');
if (shortcutsModal) {
  shortcutsModal.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'shortcuts-modal') {
      hideShortcutsModal();
    }
  });
}

const previewPanel = document.getElementById('preview-panel') as HTMLElement;
const previewContent = document.getElementById('preview-content') as HTMLElement;
const previewToggleBtn = document.getElementById('preview-toggle-btn') as HTMLButtonElement;
const previewCloseBtn = document.getElementById('preview-close') as HTMLButtonElement;

function showEmptyPreview() {
  if (!previewContent) return;
  previewContent.innerHTML = `
    <div class="preview-empty">
      <div class="preview-empty-icon">${twemojiImg(String.fromCodePoint(0x1F441), 'twemoji-xlarge')}</div>
      <p>Select a file to preview</p>
      <small>Press Space for quick look</small>
    </div>
  `;
}

function togglePreviewPanel() {
  isPreviewPanelVisible = !isPreviewPanelVisible;
  if (isPreviewPanelVisible) {
    previewPanel.style.display = 'flex';
    if (selectedItems.size === 1) {
      const selectedPath = Array.from(selectedItems)[0];
      const file = allFiles.find(f => f.path === selectedPath);
      if (file && file.isFile) {
        updatePreview(file);
      }
    }
  } else {
    previewPanel.style.display = 'none';
  }
}

function updatePreview(file: FileItem) {
  if (!file || file.isDirectory) {
    showEmptyPreview();
    return;
  }
  
  currentPreviewFile = file;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'jfif'];

  const textExts = [
    'txt', 'text', 'md', 'markdown', 'log', 'readme', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'pyc', 'pyw', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'r', 'lua', 'perl', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'json', 'xml', 'yml', 'yaml', 'toml', 'csv', 'tsv', 'sql',
    'ini', 'conf', 'config', 'cfg', 'env', 'properties', 'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'dockerignore',
    'rst', 'tex', 'adoc', 'asciidoc', 'makefile', 'cmake', 'gradle', 'maven'
  ];

  const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];
  const pdfExts = ['pdf'];
  
  if (imageExts.includes(ext)) {
    showImagePreview(file);
  } else if (textExts.includes(ext)) {
    showTextPreview(file);
  } else if (videoExts.includes(ext)) {
    showVideoPreview(file);
  } else if (audioExts.includes(ext)) {
    showAudioPreview(file);
  } else if (pdfExts.includes(ext)) {
    showPdfPreview(file);
  } else {
    showFileInfo(file);
  }
}

async function showImagePreview(file: FileItem) {
  if (!previewContent) return;
  previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading image...</p>
    </div>
  `;
  
  const result = await window.electronAPI.getFileDataUrl(file.path);
  
  if (result.success && result.dataUrl) {
    const props = await window.electronAPI.getItemProperties(file.path);
    const info = props.success && props.properties ? props.properties : null;
    
    previewContent.innerHTML = `
      <img src="${result.dataUrl}" class="preview-image" alt="${file.name}">
      ${generateFileInfo(file, info)}
    `;
  } else {
    previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load image: ${result.error || 'Unknown error'}
      </div>
      ${generateFileInfo(file, null)}
    `;
  }
}

async function showTextPreview(file: FileItem) {
  if (!previewContent) return;
  previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading text...</p>
    </div>
  `;
  
  const result = await window.electronAPI.readFileContent(file.path, 50 * 1024);
  
  if (result.success && result.content) {
    const props = await window.electronAPI.getItemProperties(file.path);
    const info = props.success && props.properties ? props.properties : null;
    
    previewContent.innerHTML = `
      ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26A0), 'twemoji')} File truncated to first 50KB</div>` : ''}
      <div class="preview-text">${escapeHtml(result.content)}</div>
      ${generateFileInfo(file, info)}
    `;
  } else {
    previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load text: ${result.error || 'Unknown error'}
      </div>
      ${generateFileInfo(file, null)}
    `;
  }
}

async function showVideoPreview(file: FileItem) {
  if (!previewContent) return;
  
  const props = await window.electronAPI.getItemProperties(file.path);
  const info = props.success && props.properties ? props.properties : null;
  
  const fileUrl = encodeFileUrl(file.path);
  
  previewContent.innerHTML = `
    <video src="${fileUrl}" class="preview-video" controls controlsList="nodownload">
      Your browser does not support the video tag.
    </video>
    ${generateFileInfo(file, info)}
  `;
}

async function showAudioPreview(file: FileItem) {
  if (!previewContent) return;
  
  const props = await window.electronAPI.getItemProperties(file.path);
  const info = props.success && props.properties ? props.properties : null;
  
  const fileUrl = encodeFileUrl(file.path);
  
  previewContent.innerHTML = `
    <div class="preview-audio-container">
      <div class="preview-audio-icon">${twemojiImg(String.fromCodePoint(0x1F3B5), 'twemoji-xlarge')}</div>
      <audio src="${fileUrl}" class="preview-audio" controls controlsList="nodownload">
        Your browser does not support the audio tag.
      </audio>
    </div>
    ${generateFileInfo(file, info)}
  `;
}

async function showPdfPreview(file: FileItem) {
  if (!previewContent) return;
  
  const props = await window.electronAPI.getItemProperties(file.path);
  const info = props.success && props.properties ? props.properties : null;
  
  const fileUrl = encodeFileUrl(file.path);
  
  previewContent.innerHTML = `
    <iframe src="${fileUrl}" class="preview-pdf" frameborder="0"></iframe>
    ${generateFileInfo(file, info)}
  `;
}

async function showFileInfo(file: FileItem) {
  if (!previewContent) return;
  const props = await window.electronAPI.getItemProperties(file.path);
  const info = props.success && props.properties ? props.properties : null;
  
  previewContent.innerHTML = `
    <div class="preview-unsupported">
      <div class="preview-unsupported-icon">${getFileIcon(file.name)}</div>
      <div>
        <strong>${file.name}</strong>
        <p>Preview not available for this file type</p>
      </div>
    </div>
    ${generateFileInfo(file, info)}
  `;
}

function generateFileInfo(file: FileItem, props: ItemProperties | null): string {
  const size = props ? props.size : file.size;
  const sizeDisplay = formatFileSize(size);
  const modified = props ? new Date(props.modified) : new Date(file.modified);
  
  return `
    <div class="preview-info">
      <div class="preview-info-item">
        <span class="preview-info-label">Name</span>
        <span class="preview-info-value">${escapeHtml(file.name)}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Type</span>
        <span class="preview-info-value">${file.isDirectory ? 'Folder' : 'File'}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Size</span>
        <span class="preview-info-value">${sizeDisplay}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Location</span>
        <span class="preview-info-value">${escapeHtml(file.path)}</span>
      </div>
      ${props && props.created ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Created</span>
        <span class="preview-info-value">${new Date(props.created).toLocaleString()}</span>
      </div>` : ''}
      <div class="preview-info-item">
        <span class="preview-info-label">Modified</span>
        <span class="preview-info-value">${modified.toLocaleDateString()} ${modified.toLocaleTimeString()}</span>
      </div>
      ${props && props.accessed ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Accessed</span>
        <span class="preview-info-value">${new Date(props.accessed).toLocaleString()}</span>
      </div>` : ''}
    </div>
  `;
}

const quicklookModal = document.getElementById('quicklook-modal') as HTMLElement;
const quicklookContent = document.getElementById('quicklook-content') as HTMLElement;
const quicklookTitle = document.getElementById('quicklook-title') as HTMLElement;
const quicklookInfo = document.getElementById('quicklook-info') as HTMLElement;
const quicklookClose = document.getElementById('quicklook-close') as HTMLButtonElement;
const quicklookOpen = document.getElementById('quicklook-open') as HTMLButtonElement;

async function showQuickLook() {
  if (selectedItems.size !== 1) return;
  if (!quicklookModal || !quicklookTitle || !quicklookContent || !quicklookInfo) return;

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  
  const selectedPath = Array.from(selectedItems)[0];
  const file = allFiles.find(f => f.path === selectedPath);
  
  if (!file || file.isDirectory) return;
  
  currentQuicklookFile = file;
  quicklookTitle.textContent = file.name;
  quicklookModal.style.display = 'flex';
  
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'jfif'];

  const textExts = [
    'txt', 'text', 'md', 'markdown', 'log', 'readme', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'pyc', 'pyw', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'r', 'lua', 'perl', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'json', 'xml', 'yml', 'yaml', 'toml', 'csv', 'tsv', 'sql',
    'ini', 'conf', 'config', 'cfg', 'env', 'properties', 'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'dockerignore',
    'rst', 'tex', 'adoc', 'asciidoc', 'makefile', 'cmake', 'gradle', 'maven'
  ];
  
  quicklookContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading preview...</p>
    </div>
  `;
  
  if (imageExts.includes(ext)) {
    const result = await window.electronAPI.getFileDataUrl(file.path);
    if (result.success && result.dataUrl) {
      quicklookContent.innerHTML = `<img src="${result.dataUrl}" alt="${file.name}">`;
      quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
    } else {
      quicklookContent.innerHTML = `<div class="preview-error">Failed to load image</div>`;
    }
  } else if (textExts.includes(ext)) {
    const result = await window.electronAPI.readFileContent(file.path, 100 * 1024);
    if (result.success && result.content) {
      quicklookContent.innerHTML = `
        ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26A0), 'twemoji')} File truncated to first 100KB</div>` : ''}
        <div class="preview-text">${escapeHtml(result.content)}</div>
      `;
      quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
    } else {
      quicklookContent.innerHTML = `<div class="preview-error">Failed to load text</div>`;
    }
  } else {
    quicklookContent.innerHTML = `
      <div class="preview-unsupported">
        <div class="preview-unsupported-icon">${getFileIcon(file.name)}</div>
        <p>Preview not available for this file type</p>
      </div>
    `;
    quicklookInfo.textContent = `${formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
  }
}

function closeQuickLook() {
  if (quicklookModal) quicklookModal.style.display = 'none';
  currentQuicklookFile = null;
}

if (previewToggleBtn) {
  previewToggleBtn.addEventListener('click', togglePreviewPanel);
}

if (previewCloseBtn) {
  previewCloseBtn.addEventListener('click', () => {
    isPreviewPanelVisible = false;
    if (previewPanel) previewPanel.style.display = 'none';
  });
}

if (quicklookClose) {
  quicklookClose.addEventListener('click', closeQuickLook);
}

if (quicklookOpen) {
  quicklookOpen.addEventListener('click', () => {
    if (currentQuicklookFile) {
      window.electronAPI.openFile(currentQuicklookFile.path);
      closeQuickLook();
    }
  });
}

if (quicklookModal) {
  quicklookModal.addEventListener('click', (e) => {
    if (e.target === quicklookModal) {
      closeQuickLook();
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }

    const settingsModal = document.getElementById('settings-modal');
    const shortcutsModal = document.getElementById('shortcuts-modal');
    const dialogModal = document.getElementById('dialog-modal');
    const licensesModal = document.getElementById('licenses-modal');
    
    if ((settingsModal && settingsModal.style.display === 'flex') ||
        (shortcutsModal && shortcutsModal.style.display === 'flex') ||
        (dialogModal && dialogModal.style.display === 'flex') ||
        (licensesModal && licensesModal.style.display === 'flex')) {
      return;
    }
    
    e.preventDefault();
    if (quicklookModal && quicklookModal.style.display === 'flex') {
      closeQuickLook();
    } else {
      showQuickLook();
    }
  }
  
  if (e.key === 'Escape' && quicklookModal && quicklookModal.style.display === 'flex') {
    closeQuickLook();
  }
});
if (searchInput) {
  searchInput.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) {
      showSearchHistoryDropdown();
    }
  });
  
  searchInput.addEventListener('blur', (e) => {
    setTimeout(() => {
      const searchDropdown = document.getElementById('search-history-dropdown');
      if (searchDropdown && !searchDropdown.matches(':hover')) {
        hideSearchHistoryDropdown();
      }
    }, 150);
  });
}

if (addressInput) {
  addressInput.addEventListener('focus', () => {
    if (currentSettings.enableSearchHistory) {
      showDirectoryHistoryDropdown();
    }
  });
  
  addressInput.addEventListener('blur', (e) => {
    setTimeout(() => {
      const directoryDropdown = document.getElementById('directory-history-dropdown');
      if (directoryDropdown && !directoryDropdown.matches(':hover')) {
        hideDirectoryHistoryDropdown();
      }
    }, 150);
  });
}

document.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;

  if (target.classList.contains('history-item') && target.dataset.query) {
    e.preventDefault();
    const query = target.dataset.query;
    if (searchInput) {
      searchInput.value = query;
      setTimeout(() => searchInput.focus(), 0);
    }
    hideSearchHistoryDropdown();
    performSearch();
    return;
  }

  if (target.classList.contains('history-item') && target.dataset.path) {
    e.preventDefault();
    const path = target.dataset.path;
    navigateTo(path);
    hideDirectoryHistoryDropdown();
    return;
  }

  if (target.classList.contains('history-clear') && target.dataset.action === 'clear-search') {
    e.preventDefault();
    clearSearchHistory();
    return;
  }

  if (target.classList.contains('history-clear') && target.dataset.action === 'clear-directory') {
    e.preventDefault();
    clearDirectoryHistory();
    return;
  }
});


(async () => {
  try {
    console.log('Starting IYERIS...');
    await init();
    console.log('IYERIS initialized successfully');
  } catch (error) {
    console.error('Failed to initialize IYERIS:', error);
    alert('Failed to start IYERIS: ' + error.message);
  }
})();

initSettingsTabs();




