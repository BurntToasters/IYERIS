import type { Settings } from './types';
import { escapeHtml } from './shared.js';
import { getFileIcon } from './rendererFileIcons.js';
import { MAX_RECENT_FILES } from './rendererLocalConstants.js';

export interface RecentFilesDeps {
  getCurrentSettings: () => Settings;
  debouncedSaveSettings: () => void;
  openPath: (filePath: string, name: string, isDirectory: boolean) => unknown;
  renderHomeRecents: () => void;
}

export function createRecentFilesController(deps: RecentFilesDeps) {
  function loadRecentFiles(): void {
    const recentList = document.getElementById('recent-list');
    const recentSection = document.getElementById('recent-section');
    if (!recentList || !recentSection) return;

    recentList.replaceChildren();

    const currentSettings = deps.getCurrentSettings();
    if (currentSettings.showRecentFiles === false) {
      recentSection.style.display = 'none';
      return;
    }

    if (!currentSettings.recentFiles || currentSettings.recentFiles.length === 0) {
      recentSection.style.display = 'block';
      recentList.innerHTML = '<div class="sidebar-empty">No recent files yet</div>';
      return;
    }

    recentSection.style.display = 'block';

    currentSettings.recentFiles.forEach((filePath) => {
      const recentItem = document.createElement('div');
      recentItem.className = 'nav-item recent-item';
      const pathParts = filePath.split(/[/\\]/);
      const name = pathParts[pathParts.length - 1] || filePath;
      const icon = getFileIcon(name);

      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      recentItem.innerHTML = `
      <span class="nav-icon">${icon}</span>
      <span class="nav-label" title="${escapeHtml(filePath)}">${escapeHtml(name)}</span>
    `;

      recentItem.addEventListener('click', () => {
        void deps.openPath(filePath, name, false);
      });

      recentList.appendChild(recentItem);
    });
  }

  async function addToRecentFiles(filePath: string): Promise<void> {
    if (!filePath || filePath.startsWith('http://') || filePath.startsWith('https://')) return;

    const currentSettings = deps.getCurrentSettings();
    if (!currentSettings.recentFiles) {
      currentSettings.recentFiles = [];
    }

    currentSettings.recentFiles = currentSettings.recentFiles.filter((f) => f !== filePath);
    currentSettings.recentFiles.unshift(filePath);
    currentSettings.recentFiles = currentSettings.recentFiles.slice(0, MAX_RECENT_FILES);

    deps.debouncedSaveSettings();
    loadRecentFiles();
    deps.renderHomeRecents();
  }

  return { loadRecentFiles, addToRecentFiles };
}
