import type { Settings, DriveInfo } from './types';
import type { ToastType } from './rendererToasts.js';
import { escapeHtml, getErrorMessage, devLog } from './shared.js';
import { clearHtml } from './rendererDom.js';
import { twemojiImg } from './rendererUtils.js';
import { HOME_QUICK_ACCESS_ITEMS, HOME_VIEW_PATH } from './home.js';
import { SPECIAL_DIRECTORY_ACTIONS } from './rendererLocalConstants.js';
import { drivesList, folderTree } from './rendererElements.js';
import { t } from './i18n.js';

interface QuickAccessItem {
  action: string;
  icon: string;
  label: string;
}

export interface SidebarDeps {
  getCurrentSettings: () => Settings;
  navigateTo: (path: string) => void;
  showToast: (message: string, title: string, type: ToastType) => void;
  getVisibleSidebarQuickAccessItems: () => QuickAccessItem[];
  renderHomeDrives: (drives: DriveInfo[]) => void;
  cacheDriveInfo: (drives: DriveInfo[]) => void;
  renderFolderTree: (drivePaths: string[]) => void;
}

export function createSidebarController(deps: SidebarDeps) {
  function renderSidebarQuickAccess(): void {
    const grid = document.getElementById('sidebar-quick-access-grid');
    if (!grid) return;

    grid.replaceChildren();

    const homeDiv = document.createElement('div');
    homeDiv.className = 'nav-item quick-action';
    homeDiv.dataset.action = 'home';
    homeDiv.setAttribute('role', 'button');
    homeDiv.tabIndex = 0;
    homeDiv.setAttribute('aria-label', 'Navigate to Home');
    // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
    homeDiv.innerHTML = `
    <span class="nav-icon" aria-hidden="true">${twemojiImg('home', 'twemoji')}</span>
    <span class="nav-label">Home</span>
  `;
    homeDiv.addEventListener('click', () => handleQuickAction('home'));
    homeDiv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleQuickAction('home');
      }
    });
    grid.appendChild(homeDiv);

    const visibleItems = deps.getVisibleSidebarQuickAccessItems();
    const itemsByAction = new Map(HOME_QUICK_ACCESS_ITEMS.map((item) => [item.action, item]));

    visibleItems.forEach((item) => {
      const itemData = itemsByAction.get(item.action);
      if (!itemData) return;

      const div = document.createElement('div');
      div.className = 'nav-item quick-action';
      div.dataset.action = item.action;
      div.setAttribute('role', 'button');
      div.tabIndex = 0;
      div.setAttribute('aria-label', `Navigate to ${item.label}`);

      const icon = twemojiImg(item.icon, 'twemoji');
      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      div.innerHTML = `
      <span class="nav-icon" aria-hidden="true">${icon}</span>
      <span class="nav-label">${escapeHtml(item.label)}</span>
    `;

      div.addEventListener('click', () => handleQuickAction(item.action));
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleQuickAction(item.action);
        }
      });

      grid.appendChild(div);
    });
  }

  async function handleQuickAction(action?: string | null): Promise<void> {
    if (!action) return;

    try {
      if (action === 'home') {
        deps.navigateTo(HOME_VIEW_PATH);
        return;
      }

      if (action === 'userhome') {
        const homePath = await window.tauriAPI.getHomeDirectory();
        if (homePath) {
          deps.navigateTo(homePath);
        } else {
          deps.showToast(t('sidebar.openHomeFailed'), t('sidebar.quickAccess'), 'error');
        }
        return;
      }

      const specialAction = SPECIAL_DIRECTORY_ACTIONS[action];
      if (specialAction) {
        const result = await window.tauriAPI.getSpecialDirectory(specialAction.key);
        if (!result.success) {
          deps.showToast(
            result.error || t('sidebar.openSpecialFailed', { label: specialAction.label }),
            t('sidebar.quickAccess'),
            'error'
          );
          return;
        }
        deps.navigateTo(result.path);
        return;
      }

      if (action === 'browse') {
        const result = await window.tauriAPI.selectFolder();
        if (result.success) {
          deps.navigateTo(result.path);
        }
        return;
      }

      if (action === 'trash') {
        const result = await window.tauriAPI.openTrash();
        if (!result.success) {
          deps.showToast(result.error || t('sidebar.openTrashFailed'), t('common.error'), 'error');
          return;
        }
        deps.showToast(t('sidebar.openingTrash'), t('common.info'), 'info');
      }
    } catch (error) {
      deps.showToast(getErrorMessage(error), t('sidebar.quickAccess'), 'error');
    }
  }

  async function loadDrives(): Promise<void> {
    if (!drivesList) return;
    try {
      const drives = await window.tauriAPI.getDriveInfo();
      deps.cacheDriveInfo(drives);
      clearHtml(drivesList);

      drives.forEach((drive) => {
        const driveLabel = drive.label || drive.path;
        const driveItem = document.createElement('div');
        driveItem.className = 'nav-item';
        driveItem.title = drive.path;
        // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
        driveItem.innerHTML = `
      <span class="nav-icon">${twemojiImg('save', 'twemoji')}</span>
      <span class="nav-label">${escapeHtml(driveLabel)}</span>
    `;
        driveItem.addEventListener('click', () => deps.navigateTo(drive.path));
        drivesList.appendChild(driveItem);
      });

      const drivePaths = drives.map((drive) => drive.path);
      void deps.renderHomeDrives(drives);

      if (deps.getCurrentSettings().showFolderTree !== false) {
        deps.renderFolderTree(drivePaths);
      } else if (folderTree) {
        clearHtml(folderTree);
      }
    } catch (error) {
      devLog('Drives', 'Failed to load drives', error);
      deps.showToast(getErrorMessage(error), 'Drives', 'error');
    }
  }

  return { renderSidebarQuickAccess, handleQuickAction, loadDrives };
}
