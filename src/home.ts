import type { DriveInfo, HomeSettings, Settings } from './types';
import { createDefaultHomeSettings } from './homeSettings.js';
import { escapeHtml } from './shared.js';

export const HOME_VIEW_PATH = 'iyeris://home';
export const HOME_VIEW_LABEL = 'Home';
export const HOME_QUICK_ACCESS_ITEMS: Array<{ action: string; label: string; icon: number }> = [
  { action: 'home', label: 'Home', icon: 0x1f3e0 },
  { action: 'userhome', label: 'Home Folder', icon: 0x1f532 },
  { action: 'desktop', label: 'Desktop', icon: 0x1f5a5 },
  { action: 'documents', label: 'Documents', icon: 0x1f4c4 },
  { action: 'downloads', label: 'Downloads', icon: 0x1f4e5 },
  { action: 'music', label: 'Music', icon: 0x1f3b5 },
  { action: 'videos', label: 'Videos', icon: 0x1f3ac },
  { action: 'browse', label: 'Browse', icon: 0x1f4c2 },
  { action: 'trash', label: 'Trash', icon: 0x1f5d1 },
];

const HOME_QUICK_ACCESS_ACTIONS = new Set(HOME_QUICK_ACCESS_ITEMS.map((item) => item.action));
const HOME_SECTION_IDS = ['quick-access', 'recents', 'bookmarks', 'drives'] as const;
type HomeSectionId = (typeof HOME_SECTION_IDS)[number];
const isHomeSectionId = (value: string): value is HomeSectionId =>
  HOME_SECTION_IDS.includes(value as HomeSectionId);
const HOME_SECTION_LABELS: Record<(typeof HOME_SECTION_IDS)[number], string> = {
  'quick-access': 'Quick Access',
  recents: 'Recents',
  bookmarks: 'Bookmarks',
  drives: 'Drives',
};
const DRIVE_USAGE_CACHE_TTL_MS = 60000;
const MAX_HOME_RECENTS = 10;

export function isHomeViewPath(pathValue?: string | null): boolean {
  return pathValue === HOME_VIEW_PATH;
}

export function getPathDisplayValue(pathValue: string): string {
  return isHomeViewPath(pathValue) ? HOME_VIEW_LABEL : pathValue;
}

type ToastType = 'success' | 'error' | 'info' | 'warning';
type ConfirmType = 'info' | 'warning' | 'error' | 'success' | 'question';

type HomeControllerOptions = {
  twemojiImg: (emoji: string, className?: string, alt?: string) => string;
  showToast: (message: string, title?: string, type?: ToastType) => void;
  showConfirm: (message: string, title?: string, type?: ConfirmType) => Promise<boolean>;
  navigateTo: (path: string) => void | Promise<void>;
  handleQuickAction: (action: string) => void | Promise<void>;
  getFileIcon: (filename: string) => string;
  formatFileSize: (bytes: number) => string;
  getSettings: () => Settings;
  openPath?: (path: string) => void | Promise<void>;
};

export type HomeController = {
  loadHomeSettings: () => Promise<void>;
  setupHomeSettingsListeners: () => void;
  renderHomeView: () => void;
  renderHomeRecents: () => void;
  renderHomeBookmarks: () => void;
  renderHomeQuickAccess: () => void;
  renderHomeDrives: (drives?: DriveInfo[]) => Promise<void>;
  getHomeSettings: () => HomeSettings;
  getVisibleSidebarQuickAccessItems: () => Array<{ action: string; label: string; icon: number }>;
  closeHomeSettingsModal: (skipConfirmation?: boolean) => Promise<void>;
};

export function createHomeController(options: HomeControllerOptions): HomeController {
  const {
    twemojiImg,
    showToast,
    showConfirm,
    navigateTo,
    handleQuickAction,
    getFileIcon,
    formatFileSize,
    getSettings,
    openPath,
  } = options;

  const homeView = document.getElementById('home-view') as HTMLElement;
  const homeQuickAccessSection = document.getElementById(
    'home-section-quick-access'
  ) as HTMLElement;
  const homeRecentsSection = document.getElementById('home-section-recents') as HTMLElement;
  const homeBookmarksSection = document.getElementById('home-section-bookmarks') as HTMLElement;
  const homeDrivesSection = document.getElementById('home-section-drives') as HTMLElement;
  const homeCustomizeBtn = document.getElementById('home-customize-btn') as HTMLButtonElement;
  const homeQuickAccess = document.getElementById('home-quick-access') as HTMLElement;
  const homeRecents = document.getElementById('home-recents') as HTMLElement;
  const homeBookmarks = document.getElementById('home-bookmarks') as HTMLElement;
  const homeDrives = document.getElementById('home-drives') as HTMLElement;
  const homeSettingsModal = document.getElementById('home-settings-modal') as HTMLElement;
  const homeSettingsClose = document.getElementById('home-settings-close') as HTMLButtonElement;
  const homeSettingsCancel = document.getElementById('home-settings-cancel') as HTMLButtonElement;
  const homeSettingsSave = document.getElementById('home-settings-save') as HTMLButtonElement;
  const homeSettingsReset = document.getElementById('home-settings-reset') as HTMLButtonElement;
  const homeToggleQuickAccess = document.getElementById(
    'home-toggle-quick-access'
  ) as HTMLInputElement;
  const homeToggleRecents = document.getElementById('home-toggle-recents') as HTMLInputElement;
  const homeToggleBookmarks = document.getElementById('home-toggle-bookmarks') as HTMLInputElement;
  const homeToggleDrives = document.getElementById('home-toggle-drives') as HTMLInputElement;
  const homeToggleDiskUsage = document.getElementById('home-toggle-disk-usage') as HTMLInputElement;
  const homeToggleCompact = document.getElementById('home-toggle-compact') as HTMLInputElement;
  const homeQuickAccessOptions = document.getElementById(
    'home-quick-access-options'
  ) as HTMLElement;
  const homeSectionOrder = document.getElementById('home-section-order') as HTMLElement;
  const sidebarQuickAccessOptions = document.getElementById(
    'sidebar-quick-access-options'
  ) as HTMLElement;

  let currentHomeSettings: HomeSettings = createDefaultHomeSettings();
  let tempHomeSettings: HomeSettings = createDefaultHomeSettings();
  let homeSettingsHasUnsavedChanges = false;
  const driveUsageCache = new Map<string, { timestamp: number; total: number; free: number }>();
  let draggedSectionId: string | null = null;
  let draggedQuickAction: string | null = null;
  let draggedSidebarQuickAction: string | null = null;

  function normalizeHomeSettings(settings?: Partial<HomeSettings> | null): HomeSettings {
    const defaults = createDefaultHomeSettings();
    const merged = { ...defaults, ...(settings || {}) };

    const sectionOrderRaw = Array.isArray(merged.sectionOrder)
      ? merged.sectionOrder.filter((id): id is string => typeof id === 'string')
      : [];
    const sectionOrder = Array.from(new Set(sectionOrderRaw.filter(isHomeSectionId)));
    const sectionOrderWithMissing = [
      ...sectionOrder,
      ...HOME_SECTION_IDS.filter((id) => !sectionOrder.includes(id)),
    ];

    const quickAccessRaw = Array.isArray(merged.quickAccessOrder) ? merged.quickAccessOrder : [];
    const quickAccessOrder = Array.from(
      new Set(quickAccessRaw.filter((action) => HOME_QUICK_ACCESS_ACTIONS.has(action)))
    );
    const quickAccessWithMissing = [
      ...quickAccessOrder,
      ...HOME_QUICK_ACCESS_ITEMS.map((item) => item.action).filter(
        (action) => !quickAccessOrder.includes(action)
      ),
    ];

    const sidebarQARaw = Array.isArray(merged.sidebarQuickAccessOrder)
      ? merged.sidebarQuickAccessOrder
      : [];
    const sidebarQuickAccessOrder = Array.from(
      new Set(sidebarQARaw.filter((action) => HOME_QUICK_ACCESS_ACTIONS.has(action)))
    );
    const sidebarQAWithMissing = [
      ...sidebarQuickAccessOrder,
      ...HOME_QUICK_ACCESS_ITEMS.map((item) => item.action).filter(
        (action) => !sidebarQuickAccessOrder.includes(action)
      ),
    ];

    const pinnedRaw = Array.isArray(merged.pinnedRecents) ? merged.pinnedRecents : [];
    const pinnedRecents = Array.from(
      new Set(pinnedRaw.filter((value) => typeof value === 'string'))
    );

    merged.hiddenQuickAccessItems = Array.from(
      new Set(
        (merged.hiddenQuickAccessItems || []).filter((action) =>
          HOME_QUICK_ACCESS_ACTIONS.has(action)
        )
      )
    );
    merged.hiddenSidebarQuickAccessItems = Array.from(
      new Set(
        (merged.hiddenSidebarQuickAccessItems || []).filter((action) =>
          HOME_QUICK_ACCESS_ACTIONS.has(action)
        )
      )
    );
    merged.sectionOrder = sectionOrderWithMissing;
    merged.quickAccessOrder = quickAccessWithMissing;
    merged.sidebarQuickAccessOrder = sidebarQAWithMissing;
    merged.pinnedRecents = pinnedRecents;
    return merged;
  }

  function applyHomeSettings(settings: HomeSettings): void {
    if (homeView) {
      homeView.classList.toggle('home-compact', settings.compactCards);
    }

    if (homeQuickAccessSection) {
      homeQuickAccessSection.style.display = settings.showQuickAccess ? 'flex' : 'none';
    }
    if (homeRecentsSection) {
      homeRecentsSection.style.display = settings.showRecents ? 'flex' : 'none';
    }
    if (homeBookmarksSection) {
      homeBookmarksSection.style.display = settings.showBookmarks ? 'flex' : 'none';
    }
    if (homeDrivesSection) {
      homeDrivesSection.style.display = settings.showDrives ? 'flex' : 'none';
    }

    applySectionOrder(settings.sectionOrder);
    renderHomeQuickAccess();
    renderHomeRecents();
    renderHomeBookmarks();
    void renderHomeDrives();
  }

  function applySectionOrder(sectionOrder: string[]): void {
    if (!homeView) return;
    const anchor = homeCustomizeBtn ?? null;
    sectionOrder.forEach((id) => {
      const section =
        id === 'quick-access'
          ? homeQuickAccessSection
          : id === 'recents'
            ? homeRecentsSection
            : id === 'bookmarks'
              ? homeBookmarksSection
              : id === 'drives'
                ? homeDrivesSection
                : null;
      if (section) {
        homeView.insertBefore(section, anchor);
      }
    });
  }

  async function loadHomeSettings(): Promise<void> {
    try {
      const result = await window.electronAPI.getHomeSettings();
      if (result.success && result.settings) {
        currentHomeSettings = normalizeHomeSettings(result.settings);
      } else {
        currentHomeSettings = createDefaultHomeSettings();
      }
    } catch (error) {
      console.error('[HomeSettings] Failed to load:', error);
      currentHomeSettings = createDefaultHomeSettings();
    }

    applyHomeSettings(currentHomeSettings);
  }

  function createHomeItem(options: {
    label: string;
    icon: string;
    subtitle?: string;
    ariaLabel?: string;
    title?: string;
    dataAttr?: { name: string; value: string };
  }): HTMLElement {
    const item = document.createElement('div');
    item.className = 'home-item';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.setAttribute('aria-label', options.ariaLabel || options.label);
    if (options.title) {
      item.title = options.title;
    }
    if (options.dataAttr) {
      item.dataset[options.dataAttr.name] = options.dataAttr.value;
    }

    item.innerHTML = `
      <span class="home-item-icon">${options.icon}</span>
      <span class="home-item-text">
        <span class="home-item-label">${escapeHtml(options.label)}</span>
        ${
          options.subtitle
            ? `<span class="home-item-subtitle">${escapeHtml(options.subtitle)}</span>`
            : ''
        }
      </span>
    `;

    return item;
  }

  function handleHomeItemActivation(target: HTMLElement): void {
    if (target.dataset.quickAction) {
      handleQuickAction(target.dataset.quickAction);
    } else if (target.dataset.bookmarkPath) {
      navigateTo(target.dataset.bookmarkPath);
    } else if (target.dataset.drivePath) {
      navigateTo(target.dataset.drivePath);
    }
  }

  function setupHomeDelegatedListeners(): void {
    const handleClick = (container: HTMLElement | null, handler: (target: HTMLElement) => void) => {
      if (!container) return;
      container.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest(
          '.home-item, .home-drive-card'
        ) as HTMLElement | null;
        if (target) handler(target);
      });
      container.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = (e.target as HTMLElement).closest(
          '.home-item, .home-drive-card'
        ) as HTMLElement | null;
        if (target) {
          e.preventDefault();
          handler(target);
        }
      });
    };

    handleClick(homeQuickAccess, handleHomeItemActivation);
    handleClick(homeBookmarks, handleHomeItemActivation);
    handleClick(homeDrives, handleHomeItemActivation);

    if (homeRecents) {
      homeRecents.addEventListener('click', (e) => {
        const pinBtn = (e.target as HTMLElement).closest('.home-recent-pin') as HTMLElement | null;
        if (pinBtn) {
          e.stopPropagation();
          const item = pinBtn.closest('.home-recent-item') as HTMLElement | null;
          if (item?.dataset.recentPath) {
            void togglePinnedRecent(item.dataset.recentPath);
          }
          return;
        }
        const item = (e.target as HTMLElement).closest('.home-recent-item') as HTMLElement | null;
        if (item?.dataset.recentPath) {
          void openRecentPath(item.dataset.recentPath);
        }
      });
      homeRecents.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const pinBtn = (e.target as HTMLElement).closest('.home-recent-pin') as HTMLElement | null;
        if (pinBtn) return;
        const item = (e.target as HTMLElement).closest('.home-recent-item') as HTMLElement | null;
        if (item?.dataset.recentPath) {
          e.preventDefault();
          void openRecentPath(item.dataset.recentPath);
        }
      });
    }
  }

  function getVisibleHomeQuickAccessItems(): Array<{
    action: string;
    label: string;
    icon: number;
  }> {
    const hiddenSet = new Set(currentHomeSettings.hiddenQuickAccessItems || []);
    const itemsByAction = new Map(HOME_QUICK_ACCESS_ITEMS.map((item) => [item.action, item]));
    const ordered = (currentHomeSettings.quickAccessOrder || []).map((action) =>
      itemsByAction.get(action)
    );
    return ordered.filter((item): item is { action: string; label: string; icon: number } => {
      return !!item && !hiddenSet.has(item.action);
    });
  }

  function getVisibleSidebarQuickAccessItems(): Array<{
    action: string;
    label: string;
    icon: number;
  }> {
    const hiddenSet = new Set(currentHomeSettings.hiddenSidebarQuickAccessItems || []);
    const itemsByAction = new Map(HOME_QUICK_ACCESS_ITEMS.map((item) => [item.action, item]));
    const ordered = (currentHomeSettings.sidebarQuickAccessOrder || []).map((action) =>
      itemsByAction.get(action)
    );
    return ordered.filter((item): item is { action: string; label: string; icon: number } => {
      return !!item && !hiddenSet.has(item.action);
    });
  }

  function renderHomeQuickAccess(): void {
    if (!homeQuickAccess) return;
    homeQuickAccess.innerHTML = '';

    if (!currentHomeSettings.showQuickAccess) return;

    const visibleItems = getVisibleHomeQuickAccessItems();
    if (visibleItems.length === 0) {
      homeQuickAccess.innerHTML = '<div class="home-empty">No quick access items enabled</div>';
      return;
    }

    visibleItems.forEach((item) => {
      const icon = twemojiImg(String.fromCodePoint(item.icon), 'twemoji');
      const homeItem = createHomeItem({
        label: item.label,
        icon,
        ariaLabel: `Open ${item.label}`,
        dataAttr: { name: 'quickAction', value: item.action },
      });
      homeQuickAccess.appendChild(homeItem);
    });
  }

  function getOrderedRecents(): string[] {
    const settings = getSettings();
    const recentFiles = settings.recentFiles || [];
    const pinned = currentHomeSettings.pinnedRecents || [];
    const seen = new Set<string>();
    const ordered: string[] = [];

    pinned.forEach((path) => {
      if (!seen.has(path)) {
        ordered.push(path);
        seen.add(path);
      }
    });

    recentFiles.forEach((path) => {
      if (!seen.has(path)) {
        ordered.push(path);
        seen.add(path);
      }
    });

    return ordered.slice(0, MAX_HOME_RECENTS);
  }

  async function openRecentPath(filePath: string): Promise<void> {
    try {
      const propsResult = await window.electronAPI.getItemProperties(filePath);
      if (propsResult.success && propsResult.properties?.isDirectory) {
        await Promise.resolve(navigateTo(filePath));
        return;
      }
    } catch {}

    if (openPath) {
      await Promise.resolve(openPath(filePath));
      return;
    }

    await window.electronAPI.openFile(filePath);
  }

  async function togglePinnedRecent(filePath: string): Promise<void> {
    const pinned = new Set(currentHomeSettings.pinnedRecents || []);
    if (pinned.has(filePath)) {
      pinned.delete(filePath);
    } else {
      pinned.add(filePath);
    }
    currentHomeSettings = normalizeHomeSettings({
      ...currentHomeSettings,
      pinnedRecents: Array.from(pinned),
    });
    const result = await window.electronAPI.saveHomeSettings(currentHomeSettings);
    if (result.success) {
      renderHomeRecents();
      if (homeSettingsModal && homeSettingsModal.style.display === 'flex') {
        tempHomeSettings = normalizeHomeSettings(currentHomeSettings);
        syncHomeSettingsModal();
      }
    } else {
      showToast('Failed to update pinned items: ' + result.error, 'Error', 'error');
    }
  }

  function renderHomeRecents(): void {
    if (!homeRecents) return;
    homeRecents.innerHTML = '';

    if (!currentHomeSettings.showRecents) return;

    const recents = getOrderedRecents();
    if (recents.length === 0) {
      homeRecents.innerHTML = '<div class="home-empty">No recent items yet</div>';
      return;
    }

    const pinnedSet = new Set(currentHomeSettings.pinnedRecents || []);

    recents.forEach((filePath) => {
      const pathParts = filePath.split(/[/\\]/);
      const name = pathParts[pathParts.length - 1] || filePath;
      const icon = getFileIcon(name);
      const isPinned = pinnedSet.has(filePath);

      const item = document.createElement('div');
      item.className = 'home-recent-item';
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.dataset.recentPath = filePath;
      item.innerHTML = `
        <div class="home-recent-main">
          <span class="home-item-icon">${icon}</span>
          <span class="home-item-text">
            <span class="home-item-label">${escapeHtml(name)}</span>
            <span class="home-item-subtitle">${escapeHtml(filePath)}</span>
          </span>
        </div>
        <button class="home-recent-pin ${isPinned ? 'active' : ''}" aria-label="${
          isPinned ? 'Unpin' : 'Pin'
        }">
          <span class="home-recent-pin-icon" aria-hidden="true"></span>
        </button>
      `;

      homeRecents.appendChild(item);
    });
  }

  function renderHomeBookmarks(): void {
    if (!homeBookmarks) return;
    homeBookmarks.innerHTML = '';

    if (!currentHomeSettings.showBookmarks) return;

    const settings = getSettings();
    if (!settings.bookmarks || settings.bookmarks.length === 0) {
      homeBookmarks.innerHTML = '<div class="home-empty">No bookmarks yet</div>';
      return;
    }

    settings.bookmarks.forEach((bookmarkPath) => {
      const pathParts = bookmarkPath.split(/[/\\]/);
      const name = pathParts[pathParts.length - 1] || bookmarkPath;
      const icon = twemojiImg(String.fromCodePoint(0x2b50), 'twemoji');
      const bookmarkItem = createHomeItem({
        label: name,
        subtitle: bookmarkPath,
        icon,
        ariaLabel: `Open bookmark ${name}`,
        title: bookmarkPath,
        dataAttr: { name: 'bookmarkPath', value: bookmarkPath },
      });
      homeBookmarks.appendChild(bookmarkItem);
    });
  }

  async function getDriveUsage(drive: string): Promise<{ total: number; free: number } | null> {
    const cached = driveUsageCache.get(drive);
    if (cached && Date.now() - cached.timestamp < DRIVE_USAGE_CACHE_TTL_MS) {
      return { total: cached.total, free: cached.free };
    }

    const result = await window.electronAPI.getDiskSpace(drive);
    if (!result.success || typeof result.total !== 'number' || typeof result.free !== 'number') {
      return null;
    }

    driveUsageCache.set(drive, { total: result.total, free: result.free, timestamp: Date.now() });
    return { total: result.total, free: result.free };
  }

  async function renderHomeDrives(drives?: DriveInfo[]): Promise<void> {
    if (!homeDrives) return;

    if (!currentHomeSettings.showDrives) {
      homeDrives.innerHTML = '';
      return;
    }

    if (!drives) {
      homeDrives.innerHTML = '<div class="home-empty">Loading drives...</div>';
    } else {
      homeDrives.innerHTML = '';
    }

    let driveList: DriveInfo[] = drives || [];

    if (!drives) {
      try {
        driveList = await window.electronAPI.getDriveInfo();
      } catch {
        driveList = [];
      }
    }

    if (!driveList || driveList.length === 0) {
      homeDrives.innerHTML = '<div class="home-empty">No drives found</div>';
      return;
    }

    homeDrives.innerHTML = '';

    driveList.forEach((drive) => {
      const driveLabel = drive.label || drive.path;
      const icon = twemojiImg(String.fromCodePoint(0x1f4be), 'twemoji');

      if (!currentHomeSettings.showDiskUsage) {
        const driveItem = createHomeItem({
          label: driveLabel,
          icon,
          ariaLabel: `Open drive ${driveLabel}`,
          title: drive.path,
          dataAttr: { name: 'drivePath', value: drive.path },
        });
        homeDrives.appendChild(driveItem);
        return;
      }

      const card = document.createElement('div');
      card.className = 'home-drive-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.title = drive.path;
      card.dataset.drivePath = drive.path;
      card.innerHTML = `
        <div class="home-drive-header">
          <span class="home-item-icon">${icon}</span>
          <span>${escapeHtml(driveLabel)}</span>
        </div>
        <div class="home-drive-meta">Loading usage...</div>
        <div class="home-drive-bar"><span style="width: 0%"></span></div>
      `;

      const meta = card.querySelector('.home-drive-meta') as HTMLElement | null;
      const bar = card.querySelector('.home-drive-bar span') as HTMLElement | null;

      void (async () => {
        const usage = await getDriveUsage(drive.path);
        if (!usage || !meta || !bar) {
          if (meta) meta.textContent = 'Usage unavailable';
          if (bar) bar.style.width = '0%';
          return;
        }
        const used = Math.max(0, usage.total - usage.free);
        const percent = usage.total > 0 ? (used / usage.total) * 100 : 0;
        meta.textContent = `${formatFileSize(usage.free)} free of ${formatFileSize(usage.total)}`;
        bar.style.width = `${Math.min(100, Math.max(4, percent))}%`;
      })();

      homeDrives.appendChild(card);
    });
  }

  function renderHomeView(): void {
    renderHomeQuickAccess();
    renderHomeRecents();
    renderHomeBookmarks();
    void renderHomeDrives();
  }

  function reorderList(list: string[], fromId: string, toId: string): string[] {
    const fromIndex = list.indexOf(fromId);
    const toIndex = list.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return list;
    const next = [...list];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, fromId);
    return next;
  }

  function renderSectionOrderList(): void {
    if (!homeSectionOrder) return;
    homeSectionOrder.innerHTML = '';

    const ordered = tempHomeSettings.sectionOrder || [];
    ordered.forEach((sectionId) => {
      if (!isHomeSectionId(sectionId)) return;
      const label = HOME_SECTION_LABELS[sectionId];
      if (!label) return;

      const row = document.createElement('div');
      row.className = 'home-section-order-item';
      row.draggable = true;
      row.dataset.section = sectionId;
      row.innerHTML = `
        <span class="home-section-order-handle" aria-hidden="true">:::</span>
        <span class="home-section-order-label">${escapeHtml(label)}</span>
      `;

      row.addEventListener('dragstart', (e) => {
        draggedSectionId = sectionId;
        row.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', sectionId);
        }
      });

      row.addEventListener('dragend', () => {
        draggedSectionId = null;
        row.classList.remove('dragging');
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromId = draggedSectionId || e.dataTransfer?.getData('text/plain');
        if (!fromId || fromId === sectionId) return;
        tempHomeSettings.sectionOrder = reorderList(
          tempHomeSettings.sectionOrder,
          fromId,
          sectionId
        );
        homeSettingsHasUnsavedChanges = true;
        renderSectionOrderList();
      });

      homeSectionOrder.appendChild(row);
    });
  }

  function renderHomeQuickAccessOptions(): void {
    if (!homeQuickAccessOptions) return;
    homeQuickAccessOptions.innerHTML = '';

    const hiddenSet = new Set(tempHomeSettings.hiddenQuickAccessItems);
    const itemsByAction = new Map(HOME_QUICK_ACCESS_ITEMS.map((item) => [item.action, item]));
    const orderedActions = tempHomeSettings.quickAccessOrder || [];
    const orderedItems = orderedActions
      .map((action) => itemsByAction.get(action))
      .filter((item): item is { action: string; label: string; icon: number } => !!item);

    orderedItems.forEach((item) => {
      const option = document.createElement('label');
      option.className = 'home-option';
      option.draggable = true;
      option.innerHTML = `
        <input type="checkbox" data-action="${item.action}" ${
          hiddenSet.has(item.action) ? '' : 'checked'
        }>
        <span class="home-option-icon">${twemojiImg(
          String.fromCodePoint(item.icon),
          'twemoji'
        )}</span>
        <span class="home-option-label">${escapeHtml(item.label)}</span>
      `;

      option.addEventListener('dragstart', (e) => {
        draggedQuickAction = item.action;
        option.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.action);
        }
      });

      option.addEventListener('dragend', () => {
        draggedQuickAction = null;
        option.classList.remove('dragging');
      });

      option.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      option.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromAction = draggedQuickAction || e.dataTransfer?.getData('text/plain');
        if (!fromAction || fromAction === item.action) return;
        tempHomeSettings.quickAccessOrder = reorderList(
          tempHomeSettings.quickAccessOrder,
          fromAction,
          item.action
        );
        homeSettingsHasUnsavedChanges = true;
        renderHomeQuickAccessOptions();
      });

      const checkbox = option.querySelector('input') as HTMLInputElement | null;
      if (checkbox) {
        checkbox.addEventListener('change', () => {
          const action = checkbox.dataset.action || '';
          const updatedHidden = new Set(tempHomeSettings.hiddenQuickAccessItems);
          if (checkbox.checked) {
            updatedHidden.delete(action);
          } else {
            updatedHidden.add(action);
          }
          tempHomeSettings.hiddenQuickAccessItems = Array.from(updatedHidden);
          homeSettingsHasUnsavedChanges = true;
        });
      }

      homeQuickAccessOptions.appendChild(option);
    });
  }

  function renderSidebarQuickAccessOptions(): void {
    if (!sidebarQuickAccessOptions) return;
    sidebarQuickAccessOptions.innerHTML = '';

    const hiddenSet = new Set(tempHomeSettings.hiddenSidebarQuickAccessItems);
    const itemsByAction = new Map(HOME_QUICK_ACCESS_ITEMS.map((item) => [item.action, item]));
    const orderedActions = tempHomeSettings.sidebarQuickAccessOrder || [];
    const orderedItems = orderedActions
      .map((action) => itemsByAction.get(action))
      .filter((item): item is { action: string; label: string; icon: number } => !!item);

    orderedItems.forEach((item) => {
      const option = document.createElement('label');
      option.className = 'home-option';
      option.draggable = true;
      option.innerHTML = `
        <input type="checkbox" data-action="${item.action}" ${
          hiddenSet.has(item.action) ? '' : 'checked'
        }>
        <span class="home-option-icon">${twemojiImg(
          String.fromCodePoint(item.icon),
          'twemoji'
        )}</span>
        <span class="home-option-label">${escapeHtml(item.label)}</span>
      `;

      option.addEventListener('dragstart', (e) => {
        draggedSidebarQuickAction = item.action;
        option.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.action);
        }
      });

      option.addEventListener('dragend', () => {
        draggedSidebarQuickAction = null;
        option.classList.remove('dragging');
      });

      option.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      option.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromAction = draggedSidebarQuickAction || e.dataTransfer?.getData('text/plain');
        if (!fromAction || fromAction === item.action) return;
        tempHomeSettings.sidebarQuickAccessOrder = reorderList(
          tempHomeSettings.sidebarQuickAccessOrder,
          fromAction,
          item.action
        );
        homeSettingsHasUnsavedChanges = true;
        renderSidebarQuickAccessOptions();
      });

      const checkbox = option.querySelector('input') as HTMLInputElement | null;
      if (checkbox) {
        checkbox.addEventListener('change', () => {
          const action = checkbox.dataset.action || '';
          const updatedHidden = new Set(tempHomeSettings.hiddenSidebarQuickAccessItems);
          if (checkbox.checked) {
            updatedHidden.delete(action);
          } else {
            updatedHidden.add(action);
          }
          tempHomeSettings.hiddenSidebarQuickAccessItems = Array.from(updatedHidden);
          homeSettingsHasUnsavedChanges = true;
        });
      }

      sidebarQuickAccessOptions.appendChild(option);
    });
  }

  function syncHomeSettingsModal(): void {
    if (homeToggleQuickAccess) homeToggleQuickAccess.checked = tempHomeSettings.showQuickAccess;
    if (homeToggleRecents) homeToggleRecents.checked = tempHomeSettings.showRecents;
    if (homeToggleBookmarks) homeToggleBookmarks.checked = tempHomeSettings.showBookmarks;
    if (homeToggleDrives) homeToggleDrives.checked = tempHomeSettings.showDrives;
    if (homeToggleDiskUsage) homeToggleDiskUsage.checked = tempHomeSettings.showDiskUsage;
    if (homeToggleCompact) homeToggleCompact.checked = tempHomeSettings.compactCards;
    renderSectionOrderList();
    renderHomeQuickAccessOptions();
    renderSidebarQuickAccessOptions();
  }

  function openHomeSettingsModal(): void {
    if (!homeSettingsModal) return;
    tempHomeSettings = normalizeHomeSettings(currentHomeSettings);
    homeSettingsHasUnsavedChanges = false;
    syncHomeSettingsModal();
    homeSettingsModal.style.display = 'flex';
  }

  async function closeHomeSettingsModal(skipConfirmation = false): Promise<void> {
    if (!homeSettingsModal) return;
    if (!skipConfirmation && homeSettingsHasUnsavedChanges) {
      const confirmed = await showConfirm(
        'You have unsaved changes. Are you sure you want to close the Home editor?',
        'Unsaved Changes',
        'warning'
      );
      if (!confirmed) return;
    }
    homeSettingsModal.style.display = 'none';
    homeSettingsHasUnsavedChanges = false;
  }

  async function saveHomeSettings(): Promise<void> {
    tempHomeSettings = normalizeHomeSettings(tempHomeSettings);
    const result = await window.electronAPI.saveHomeSettings(tempHomeSettings);
    if (result.success) {
      currentHomeSettings = { ...tempHomeSettings };
      applyHomeSettings(currentHomeSettings);
      await closeHomeSettingsModal(true);
      showToast('Home settings saved!', 'Home', 'success');
    } else {
      showToast('Failed to save home settings: ' + result.error, 'Error', 'error');
    }
  }

  function setupHomeSettingsListeners(): void {
    setupHomeDelegatedListeners();
    homeCustomizeBtn?.addEventListener('click', () => openHomeSettingsModal());
    homeSettingsClose?.addEventListener('click', () => closeHomeSettingsModal());
    homeSettingsCancel?.addEventListener('click', () => closeHomeSettingsModal());
    homeSettingsSave?.addEventListener('click', () => saveHomeSettings());

    homeSettingsReset?.addEventListener('click', () => {
      tempHomeSettings = createDefaultHomeSettings();
      homeSettingsHasUnsavedChanges = true;
      syncHomeSettingsModal();
    });

    homeSettingsModal?.addEventListener('click', (e) => {
      if (e.target === homeSettingsModal) {
        closeHomeSettingsModal();
      }
    });

    homeToggleQuickAccess?.addEventListener('change', () => {
      tempHomeSettings.showQuickAccess = homeToggleQuickAccess.checked;
      homeSettingsHasUnsavedChanges = true;
    });

    homeToggleRecents?.addEventListener('change', () => {
      tempHomeSettings.showRecents = homeToggleRecents.checked;
      homeSettingsHasUnsavedChanges = true;
    });

    homeToggleBookmarks?.addEventListener('change', () => {
      tempHomeSettings.showBookmarks = homeToggleBookmarks.checked;
      homeSettingsHasUnsavedChanges = true;
    });

    homeToggleDrives?.addEventListener('change', () => {
      tempHomeSettings.showDrives = homeToggleDrives.checked;
      homeSettingsHasUnsavedChanges = true;
    });

    homeToggleDiskUsage?.addEventListener('change', () => {
      tempHomeSettings.showDiskUsage = homeToggleDiskUsage.checked;
      homeSettingsHasUnsavedChanges = true;
    });

    homeToggleCompact?.addEventListener('change', () => {
      tempHomeSettings.compactCards = homeToggleCompact.checked;
      homeSettingsHasUnsavedChanges = true;
    });

    window.electronAPI.onHomeSettingsChanged((settings) => {
      currentHomeSettings = normalizeHomeSettings(settings);
      applyHomeSettings(currentHomeSettings);
      if (homeSettingsModal && homeSettingsModal.style.display === 'flex') {
        tempHomeSettings = normalizeHomeSettings(currentHomeSettings);
        syncHomeSettingsModal();
      }
    });
  }

  return {
    loadHomeSettings,
    setupHomeSettingsListeners,
    renderHomeView,
    renderHomeRecents,
    renderHomeBookmarks,
    renderHomeQuickAccess,
    renderHomeDrives,
    getHomeSettings: () => currentHomeSettings,
    getVisibleSidebarQuickAccessItems,
    closeHomeSettingsModal,
  };
}
