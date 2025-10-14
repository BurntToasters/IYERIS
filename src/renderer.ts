// @ts-nocheck
import type { Settings, FileItem, ItemProperties } from './types';

type ViewMode = 'grid' | 'list';
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
let isPreviewPanelVisible: boolean = false;
let currentPreviewFile: FileItem | null = null;
let currentQuicklookFile: FileItem | null = null;

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
const searchBar = document.querySelector('.search-bar') as HTMLElement;
const searchClose = document.getElementById('search-close') as HTMLButtonElement;
const addressBar = document.querySelector('.address-bar') as HTMLElement;
const sortBtn = document.getElementById('sort-btn') as HTMLButtonElement;
const bookmarksList = document.getElementById('bookmarks-list') as HTMLElement;
const bookmarkAddBtn = document.getElementById('bookmark-add-btn') as HTMLButtonElement;

function showDialog(title: string, message: string, type: DialogType = 'info', showCancel: boolean = false): Promise<boolean> {
  return new Promise((resolve) => {
    const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
    const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
    const dialogContent = document.getElementById('dialog-content') as HTMLElement;
    const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
    const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
    const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;

    const icons: Record<DialogType, string> = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      success: '✅',
      question: '❓'
    };

    dialogIcon.textContent = icons[type] || icons.info;
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
  viewMode: 'grid'
};

function showToast(message: string, title: string = '', type: 'success' | 'error' | 'info' | 'warning' = 'info'): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cursor = 'pointer';
  
  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <div class="toast-content">
      ${title ? `<div class="toast-title">${title}</div>` : ''}
      <div class="toast-message">${message}</div>
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
      ...result.settings
    };
    applySettings(currentSettings);
  }
}

function applySettings(settings) {
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
  const settingsModal = document.getElementById('settings-modal');
  const transparencyToggle = document.getElementById('transparency-toggle') as HTMLInputElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
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
}

async function showLicensesModal() {
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function saveSettings() {
  const transparencyToggle = document.getElementById('transparency-toggle') as HTMLInputElement;
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const sortBySelect = document.getElementById('sort-by-select') as HTMLSelectElement;
  const sortOrderSelect = document.getElementById('sort-order-select') as HTMLSelectElement;
  
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
    'Are you sure you want to reset all settings to default? This cannot be undone.',
    'Reset Settings',
    'warning'
  );
  
  if (confirmed) {
    const result = await window.electronAPI.resetSettings();
    if (result.success) {
      await loadSettings();
      hideSettingsModal();
      showToast('Settings have been reset to default.', 'Settings Reset', 'success');
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
      <span class="bookmark-icon">⭐</span>
      <span class="bookmark-label">${name}</span>
      <button class="bookmark-remove" title="Remove bookmark">✕</button>
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
  
  if (!currentSettings.bookmarks) {
    currentSettings.bookmarks = [];
  }
  
  if (currentSettings.bookmarks.includes(currentPath)) {
    showToast('This folder is already bookmarked', 'Bookmarks', 'info');
    return;
  }
  
  currentSettings.bookmarks.push(currentPath);
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
  if (searchBar.style.display === 'none' || !searchBar.style.display) {
    searchBar.style.display = 'flex';
    addressBar.style.display = 'none';
    searchInput.focus();
    isSearchMode = true;
  } else {
    closeSearch();
  }
}

function closeSearch() {
  searchBar.style.display = 'none';
  addressBar.style.display = 'flex';
  searchInput.value = '';
  isSearchMode = false;
  if (currentPath) {
    navigateTo(currentPath);
  }
}

async function performSearch() {
  const query = searchInput.value.trim();
  if (!query || !currentPath) return;
  
  loading.style.display = 'flex';
  emptyState.style.display = 'none';
  fileGrid.innerHTML = '';
  
  const result = await window.electronAPI.searchFiles(currentPath, query);
  
  if (result.success && result.results) {
    allFiles = result.results;
    renderFiles(result.results);
  } else {
    showToast(result.error || 'Search failed', 'Search Error', 'error');
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
  if (!statusDiskSpace || !currentPath) return;
  
  let drivePath = currentPath;
  if (process.platform === 'win32') {
    drivePath = currentPath.substring(0, 3);
  } else {
    drivePath = '/';
  }
  
  const result = await window.electronAPI.getDiskSpace(drivePath);
  if (result.success && result.total && result.free) {
    const freeStr = formatFileSize(result.free);
    const totalStr = formatFileSize(result.total);
    statusDiskSpace.textContent = `${freeStr} free of ${totalStr}`;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function init() {
  console.log('Init: Loading settings...');
  await loadSettings();
  
  console.log('Init: Getting home directory...');
  const homeDir = await window.electronAPI.getHomeDirectory();
  console.log('Init: Home directory is', homeDir);
  
  console.log('Init: Navigating to home...');
  navigateTo(homeDir);
  
  console.log('Init: Loading drives...');
  loadDrives();
  
  console.log('Init: Setting up event listeners...');
  setupEventListeners();
  
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
      <span class="nav-icon">💾</span>
      <span class="nav-label">${drive}</span>
    `;
    driveItem.addEventListener('click', () => navigateTo(drive));
    drivesList.appendChild(driveItem);
  });
}

function setupEventListeners() {
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
  refreshBtn?.addEventListener('click', refresh);
  newFileBtn?.addEventListener('click', createNewFile);
  newFolderBtn?.addEventListener('click', createNewFolder);
  viewToggleBtn?.addEventListener('click', toggleView);
  
  searchBtn?.addEventListener('click', toggleSearch);
  searchClose?.addEventListener('click', closeSearch);
  sortBtn?.addEventListener('click', showSortMenu);
  bookmarkAddBtn?.addEventListener('click', addBookmark);
  
  searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
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
  
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'c') {
        e.preventDefault();
        copyToClipboard();
      } else if (e.key === 'x') {
        e.preventDefault();
        cutToClipboard();
      } else if (e.key === 'v') {
        e.preventDefault();
        pasteFromClipboard();
      } else if (e.key === 'f') {
        e.preventDefault();
        toggleSearch();
      } else if (e.key === 'a') {
        e.preventDefault();
        selectAll();
      }
    } else if (e.key === 'F5') {
      e.preventDefault();
      refresh();
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameSelected();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape') {
      if (isSearchMode) {
        closeSearch();
      }
    }
  });
  
  document.querySelectorAll('.nav-item[data-action]').forEach(item => {
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
      }
    });
  });
  
  document.addEventListener('click', (e) => {
    const contextMenu = document.getElementById('context-menu');
    const emptySpaceContextMenu = document.getElementById('empty-space-context-menu');
    const sortMenu = document.getElementById('sort-menu');
    
    if (contextMenu && contextMenu.style.display === 'block' && !contextMenu.contains(e.target)) {
      hideContextMenu();
    }
    if (emptySpaceContextMenu && emptySpaceContextMenu.style.display === 'block' && !emptySpaceContextMenu.contains(e.target)) {
      hideEmptySpaceContextMenu();
    }
    if (sortMenu && sortMenu.style.display === 'block' && !sortMenu.contains(e.target) && e.target !== sortBtn) {
      hideSortMenu();
    }
  });
  
  document.addEventListener('click', (e) => {
    const sortMenu = document.getElementById('sort-menu');
    const menuItem = e.target.closest('.context-menu-item');
    
    if (menuItem && sortMenu && sortMenu.style.display === 'block') {
      const sortType = menuItem.getAttribute('data-sort');
      if (sortType) {
        changeSortMode(sortType);
      }
      return;
    }
    
    if (menuItem && contextMenuData) {
      handleContextMenuAction(menuItem.dataset.action, contextMenuData);
      hideContextMenu();
    }
  });
  
  document.addEventListener('click', (e) => {
    const emptySpaceMenu = document.getElementById('empty-space-context-menu');
    const menuItem = e.target.closest('.context-menu-item');
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
      
      if (e.target.closest('.file-item')) {
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
    if (!e.target.closest('.file-item')) {
      e.preventDefault();
      const clickedOnFileView = e.target.closest('#file-view') || 
                                 e.target.id === 'file-view' || 
                                 e.target.closest('.file-grid') || 
                                 e.target.id === 'file-grid' ||
                                 e.target.closest('.empty-state') ||
                                 e.target.id === 'empty-state';
      if (clickedOnFileView && currentPath) {
        showEmptySpaceContextMenu(e.pageX, e.pageY);
      } else {
        hideContextMenu();
        hideEmptySpaceContextMenu();
      }
    }
  });
}

async function navigateTo(path) {
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

function renderFiles(items) {
  if (!fileGrid) return;
  
  fileGrid.innerHTML = '';
  clearSelection();
  allFiles = items;
  
  if (items.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    updateStatusBar();
    return;
  }
  
  const sortedItems = [...items].sort((a, b) => {
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
  
  sortedItems.forEach(item => {
    const fileItem = createFileItem(item);
    fileGrid.appendChild(fileItem);
  });
  
  updateCutVisuals();
  updateStatusBar();
}

function createFileItem(item) {
  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.dataset.path = item.path;
  fileItem.dataset.isDirectory = item.isDirectory;
  
  const icon = item.isDirectory ? '📁' : getFileIcon(item.name);
  const ext = item.name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico'];
  const isImage = !item.isDirectory && imageExts.includes(ext);
  
  if (isImage) {
    fileItem.classList.add('has-thumbnail');
    fileItem.innerHTML = `
      <div class="file-icon">
        <div class="spinner" style="width: 30px; height: 30px; border-width: 2px;"></div>
      </div>
      <div class="file-name">${item.name}</div>
    `;
    
    loadThumbnail(fileItem, item);
  } else {
    fileItem.innerHTML = `
      <div class="file-icon">${icon}</div>
      <div class="file-name">${item.name}</div>
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
    const result = await window.electronAPI.getFileDataUrl(item.path, 500 * 1024);
    const iconDiv = fileItem.querySelector('.file-icon');
    
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

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap = {
    'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'bmp': '🖼️',
    'mp4': '🎬', 'avi': '🎬', 'mov': '🎬', 'mkv': '🎬', 'webm': '🎬',
    'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'ogg': '🎵', 'm4a': '🎵',
    'pdf': '📄', 'doc': '📝', 'docx': '📝', 'txt': '📝', 'rtf': '📝',
    'xls': '📊', 'xlsx': '📊', 'csv': '📊',
    'ppt': '📊', 'pptx': '📊',
    'js': '📜', 'ts': '📜', 'jsx': '📜', 'tsx': '📜',
    'html': '🌐', 'css': '🎨', 'json': '⚙️', 'xml': '⚙️',
    'py': '🐍', 'java': '☕', 'c': '©️', 'cpp': '©️', 'cs': '©️',
    'php': '🐘', 'rb': '💎', 'go': '🐹', 'rs': '🦀',
    'zip': '🗜️', 'rar': '🗜️', '7z': '🗜️', 'tar': '🗜️', 'gz': '🗜️',
    'exe': '⚙️', 'app': '⚙️', 'msi': '⚙️', 'dmg': '⚙️'
  };
  
  return iconMap[ext] || '📄';
}

async function handleDrop(sourcePaths: string[], destPath: string, operation: 'copy' | 'move'): Promise<void> {
  try {
    const result = operation === 'copy' 
      ? await window.electronAPI.copyItems(sourcePaths, destPath)
      : await window.electronAPI.moveItems(sourcePaths, destPath);
    
    if (result.success) {
      showToast(`${operation === 'copy' ? 'Copied' : 'Moved'} ${sourcePaths.length} item(s)`, 'Success', 'success');
      await navigateTo(currentPath);
      clearSelection();
    } else {
      showToast(result.message || `Failed to ${operation} items`, 'Error', 'error');
    }
  } catch (error) {
    console.error(`Error during ${operation}:`, error);
    showToast(`Failed to ${operation} items`, 'Error', 'error');
  }
}

function toggleSelection(fileItem) {
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
  for (const fileItem of fileItems) {
    if (fileItem.getAttribute('data-path') === itemPath) {
      const item = allFiles.find(f => f.path === itemPath);
      if (item) {
        startInlineRename(fileItem, item.name, item.path);
      }
      break;
    }
  }
}

async function deleteSelected() {
  if (selectedItems.size === 0) return;
  
  const count = selectedItems.size;
  const confirmed = await showConfirm(
    `Are you sure you want to delete ${count} item${count > 1 ? 's' : ''}?`,
    'Confirm Delete',
    'warning'
  );
  
  if (confirmed) {
    let successCount = 0;
    for (const itemPath of selectedItems) {
      const result = await window.electronAPI.deleteItem(itemPath);
      if (result.success) successCount++;
    }
    
    if (successCount > 0) {
      showToast(`${successCount} item${successCount > 1 ? 's' : ''} deleted`, 'Success', 'success');
      refresh();
    }
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
      for (const item of fileItems) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFileName) {
          startInlineRename(item, finalFileName, createdFilePath);
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
      for (const item of fileItems) {
        const nameElement = item.querySelector('.file-name');
        if (nameElement && nameElement.textContent === finalFolderName) {
          startInlineRename(item, finalFolderName, createdFolderPath);
          break;
        }
      }
    }, 100);
  } else {
    await showAlert(result.error, 'Error Creating Folder', 'error');
  }
}

function startInlineRename(fileItem, currentName, itemPath) {
  const nameElement = fileItem.querySelector('.file-name');
  if (!nameElement) return;
  
  nameElement.style.display = 'none';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-input';
  input.value = currentName;
  fileItem.appendChild(input);
  
  fileItem.classList.add('renaming');
  
  input.focus();
  input.select();
  
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

function showContextMenu(x, y, item) {
  const contextMenu = document.getElementById('context-menu');
  if (!contextMenu) return;
  
  contextMenuData = item;
  
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

async function handleEmptySpaceContextMenuAction(action) {
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

async function handleContextMenuAction(action, item) {
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
      for (const fileItem of fileItems) {
        if (fileItem.dataset.path === item.path) {
          startInlineRename(fileItem, item.name, item.path);
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
      const confirmDelete = await showConfirm(
        `Are you sure you want to delete "${item.name}"?`,
        'Confirm Delete',
        'warning'
      );
      if (confirmDelete) {
        const result = await window.electronAPI.deleteItem(item.path);
        if (result.success) {
          showToast('Item deleted', 'Success', 'success');
          refresh();
        } else {
          showToast(result.error, 'Error Deleting', 'error');
        }
      }
      break;
  }
}

function showPropertiesDialog(props) {
  const modal = document.getElementById('properties-modal');
  const content = document.getElementById('properties-content');
  
  const sizeInKB = (props.size / 1024).toFixed(2);
  const sizeInMB = (props.size / (1024 * 1024)).toFixed(2);
  const sizeDisplay = props.size > 1024 * 1024 ? `${sizeInMB} MB` : `${sizeInKB} KB`;
  
  content.innerHTML = `
    <div class="property-row">
      <div class="property-label">Name:</div>
      <div class="property-value">${props.name}</div>
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
      <div class="property-value">${props.path}</div>
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


document.getElementById('settings-btn')?.addEventListener('click', showSettingsModal);
document.getElementById('settings-close')?.addEventListener('click', hideSettingsModal);
document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
document.getElementById('reset-settings-btn')?.addEventListener('click', resetSettings);
document.getElementById('restart-admin-btn')?.addEventListener('click', restartAsAdmin);
document.getElementById('github-btn')?.addEventListener('click', () => {
  window.electronAPI.openFile('https://github.com/BurntToasters/IYERIS');
});
document.getElementById('version-indicator')?.addEventListener('click', () => {
  const version = document.getElementById('version-indicator')?.textContent || 'v0.1.0';
  window.electronAPI.openFile(`https://github.com/BurntToasters/IYERIS/releases/tag/${version}`);
});

document.getElementById('licenses-btn')?.addEventListener('click', showLicensesModal);
document.getElementById('licenses-close')?.addEventListener('click', hideLicensesModal);
document.getElementById('close-licenses-btn')?.addEventListener('click', hideLicensesModal);
document.getElementById('copy-licenses-btn')?.addEventListener('click', copyLicensesText);

const settingsModal = document.getElementById('settings-modal');
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') {
      hideSettingsModal();
    }
  });
}

const licensesModal = document.getElementById('licenses-modal');
if (licensesModal) {
  licensesModal.addEventListener('click', (e) => {
    if (e.target.id === 'licenses-modal') {
      hideLicensesModal();
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
      <div class="preview-empty-icon">👁️</div>
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
  
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const textExts = ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'php', 'rb', 'go', 'rs', 'log', 'ini', 'cfg', 'yml', 'yaml'];
  
  if (imageExts.includes(ext)) {
    showImagePreview(file);
  } else if (textExts.includes(ext)) {
    showTextPreview(file);
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
      ${result.isTruncated ? '<div class="preview-truncated">⚠️ File truncated to first 50KB</div>' : ''}
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
        <span class="preview-info-value">${file.name}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Size</span>
        <span class="preview-info-value">${sizeDisplay}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Modified</span>
        <span class="preview-info-value">${modified.toLocaleDateString()} ${modified.toLocaleTimeString()}</span>
      </div>
      ${props && props.created ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Created</span>
        <span class="preview-info-value">${new Date(props.created).toLocaleDateString()} ${new Date(props.created).toLocaleTimeString()}</span>
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
  
  const selectedPath = Array.from(selectedItems)[0];
  const file = allFiles.find(f => f.path === selectedPath);
  
  if (!file || file.isDirectory) return;
  
  currentQuicklookFile = file;
  quicklookTitle.textContent = file.name;
  quicklookModal.style.display = 'flex';
  
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const textExts = ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'php', 'rb', 'go', 'rs', 'log', 'ini', 'cfg', 'yml', 'yaml'];
  
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
        ${result.isTruncated ? '<div class="preview-truncated">⚠️ File truncated to first 100KB</div>' : ''}
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




