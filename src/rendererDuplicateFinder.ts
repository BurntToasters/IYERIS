import type { DuplicateGroup } from './types';
import { escapeHtml, getErrorMessage } from './shared.js';
import { isPermissionDeniedError } from './rendererClipboard.js';
import { rendererPath as path } from './rendererUtils.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';
type ConfirmType = 'warning' | 'question' | 'error';

type DuplicateFinderDeps = {
  getCurrentPath: () => string;
  isHomeViewPath: (pathValue: string) => boolean;
  formatFileSize: (size: number) => string;
  showToast: (message: string, title: string, type: ToastType) => void;
  showConfirm: (message: string, title: string, type: ConfirmType) => Promise<boolean>;
  onModalOpen: (modal: HTMLElement) => void;
  onModalClose: (modal: HTMLElement) => void;
  refresh: (reason?: string) => void;
  navigateTo: (pathValue: string) => Promise<void> | void;
};

function groupKey(group: DuplicateGroup): string {
  return `${group.size}:${group.hash}`;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function createDuplicateFinderController(deps: DuplicateFinderDeps) {
  let modal: HTMLElement | null = null;
  let rootPathValue: HTMLElement | null = null;
  let minSizeInput: HTMLInputElement | null = null;
  let includeHiddenToggle: HTMLInputElement | null = null;
  let scanBtn: HTMLButtonElement | null = null;
  let statusEl: HTMLElement | null = null;
  let summaryEl: HTMLElement | null = null;
  let groupsEl: HTMLElement | null = null;
  let selectAllBtn: HTMLButtonElement | null = null;
  let selectNoneBtn: HTMLButtonElement | null = null;
  let exportBtn: HTMLButtonElement | null = null;
  let deleteBtn: HTMLButtonElement | null = null;
  let closeBtn: HTMLButtonElement | null = null;
  let cancelBtn: HTMLButtonElement | null = null;

  let initialized = false;
  let scanRequestId = 0;
  let scanInProgress = false;
  let deleteInProgress = false;

  let currentRootPath = '';
  let currentMinSizeMb = 1;
  let currentIncludeHidden = false;

  let groups: DuplicateGroup[] = [];
  let selectedGroupKeys = new Set<string>();

  function ensureElements(): boolean {
    if (!modal) modal = document.getElementById('duplicate-finder-modal');
    if (!rootPathValue) rootPathValue = document.getElementById('duplicate-finder-root');
    if (!minSizeInput)
      minSizeInput = document.getElementById(
        'duplicate-finder-min-size'
      ) as HTMLInputElement | null;
    if (!includeHiddenToggle) {
      includeHiddenToggle = document.getElementById(
        'duplicate-finder-include-hidden'
      ) as HTMLInputElement | null;
    }
    if (!scanBtn)
      scanBtn = document.getElementById('duplicate-finder-scan-btn') as HTMLButtonElement | null;
    if (!statusEl) statusEl = document.getElementById('duplicate-finder-status');
    if (!summaryEl) summaryEl = document.getElementById('duplicate-finder-summary');
    if (!groupsEl) groupsEl = document.getElementById('duplicate-finder-groups');
    if (!selectAllBtn) {
      selectAllBtn = document.getElementById(
        'duplicate-finder-select-all'
      ) as HTMLButtonElement | null;
    }
    if (!selectNoneBtn) {
      selectNoneBtn = document.getElementById(
        'duplicate-finder-select-none'
      ) as HTMLButtonElement | null;
    }
    if (!exportBtn) {
      exportBtn = document.getElementById(
        'duplicate-finder-export-btn'
      ) as HTMLButtonElement | null;
    }
    if (!deleteBtn) {
      deleteBtn = document.getElementById(
        'duplicate-finder-delete-btn'
      ) as HTMLButtonElement | null;
    }
    if (!closeBtn) {
      closeBtn = document.getElementById('duplicate-finder-close') as HTMLButtonElement | null;
    }
    if (!cancelBtn) {
      cancelBtn = document.getElementById('duplicate-finder-cancel') as HTMLButtonElement | null;
    }

    return !!(
      modal &&
      rootPathValue &&
      minSizeInput &&
      includeHiddenToggle &&
      scanBtn &&
      statusEl &&
      summaryEl &&
      groupsEl &&
      selectAllBtn &&
      selectNoneBtn &&
      exportBtn &&
      deleteBtn &&
      closeBtn &&
      cancelBtn
    );
  }

  function setStatus(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  }

  function getSelectedGroups(): DuplicateGroup[] {
    if (groups.length === 0) return [];
    return groups.filter((group) => selectedGroupKeys.has(groupKey(group)));
  }

  function getDuplicatePathsForGroups(selectedGroups: DuplicateGroup[]): string[] {
    const paths: string[] = [];
    for (const group of selectedGroups) {
      if (group.paths.length > 1) {
        paths.push(...group.paths.slice(1));
      }
    }
    return paths;
  }

  function computeReclaimableBytes(selectedGroups: DuplicateGroup[]): number {
    return selectedGroups.reduce((total, group) => {
      return total + group.size * Math.max(0, group.paths.length - 1);
    }, 0);
  }

  function syncSummaryAndActions(): void {
    if (!summaryEl || !exportBtn || !deleteBtn || !selectAllBtn || !selectNoneBtn) return;

    const selectedGroups = getSelectedGroups();
    const selectedDuplicatePaths = getDuplicatePathsForGroups(selectedGroups);

    const totalDuplicateFiles = groups.reduce((total, group) => {
      return total + Math.max(0, group.paths.length - 1);
    }, 0);
    const totalReclaimable = computeReclaimableBytes(groups);
    const selectedReclaimable = computeReclaimableBytes(selectedGroups);

    if (groups.length === 0) {
      summaryEl.textContent = 'Run a scan to see duplicate groups.';
    } else {
      summaryEl.textContent = `${selectedGroups.length}/${groups.length} groups selected • ${selectedDuplicatePaths.length}/${totalDuplicateFiles} duplicate files • ${deps.formatFileSize(selectedReclaimable)} selected reclaim (${deps.formatFileSize(totalReclaimable)} total)`;
    }

    const hasSelectedGroups = selectedGroups.length > 0;
    exportBtn.disabled = !hasSelectedGroups || scanInProgress || deleteInProgress;
    deleteBtn.disabled = selectedDuplicatePaths.length === 0 || scanInProgress || deleteInProgress;
    selectAllBtn.disabled = groups.length === 0 || scanInProgress || deleteInProgress;
    selectNoneBtn.disabled = groups.length === 0 || scanInProgress || deleteInProgress;
  }

  function renderGroups(): void {
    if (!groupsEl) return;

    if (groups.length === 0) {
      groupsEl.innerHTML = `<div class="duplicate-finder-empty">No duplicate groups found.</div>`;
      syncSummaryAndActions();
      return;
    }

    const cardsHtml = groups
      .map((group, groupIndex) => {
        const key = groupKey(group);
        const checked = selectedGroupKeys.has(key) ? 'checked' : '';
        const reclaimable = group.size * Math.max(0, group.paths.length - 1);

        const pathsHtml = group.paths
          .map((filePath, pathIndex) => {
            const role = pathIndex === 0 ? 'Keep' : 'Duplicate';
            const roleClass = pathIndex === 0 ? 'keeper' : 'duplicate';
            return `<li class="duplicate-finder-path-row ${roleClass}">
              <span class="duplicate-finder-path-role">${role}</span>
              <span class="duplicate-finder-path" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
              <button type="button" class="modal-button compact duplicate-finder-open-folder" data-group-index="${groupIndex}" data-path-index="${pathIndex}">Open Folder</button>
            </li>`;
          })
          .join('');

        return `<div class="duplicate-finder-group-card" data-group-key="${escapeHtml(key)}">
          <label class="duplicate-finder-group-header">
            <input type="checkbox" class="duplicate-finder-group-checkbox" data-group-key="${escapeHtml(key)}" ${checked} />
            <span class="duplicate-finder-group-title">Group ${groupIndex + 1}</span>
            <span class="duplicate-finder-group-meta">${group.paths.length} files • ${deps.formatFileSize(group.size)} each • Reclaim ${deps.formatFileSize(reclaimable)}</span>
          </label>
          <ul class="duplicate-finder-path-list">${pathsHtml}</ul>
        </div>`;
      })
      .join('');

    groupsEl.innerHTML = cardsHtml;
    syncSummaryAndActions();
  }

  function closeDuplicateFinderModal(): void {
    if (!modal) return;
    modal.style.display = 'none';
    deps.onModalClose(modal);
  }

  function buildReport(selectedGroups: DuplicateGroup[], minSizeBytes: number): string {
    const duplicateFileCount = selectedGroups.reduce((total, group) => {
      return total + Math.max(0, group.paths.length - 1);
    }, 0);
    const reclaimableBytes = computeReclaimableBytes(selectedGroups);

    const lines: string[] = [
      `Duplicate scan root: ${currentRootPath}`,
      `Minimum file size: ${deps.formatFileSize(minSizeBytes)}`,
      `Include hidden files: ${currentIncludeHidden ? 'yes' : 'no'}`,
      `Selected groups: ${selectedGroups.length}`,
      `Selected duplicate files: ${duplicateFileCount}`,
      `Potential space savings: ${deps.formatFileSize(reclaimableBytes)}`,
      '',
    ];

    for (const [index, group] of selectedGroups.entries()) {
      const reclaimable = group.size * Math.max(0, group.paths.length - 1);
      lines.push(
        `Group ${index + 1}: ${group.paths.length} files × ${deps.formatFileSize(group.size)} (reclaim ${deps.formatFileSize(reclaimable)})`
      );
      for (const [pathIndex, filePath] of group.paths.entries()) {
        lines.push(`  ${pathIndex === 0 ? '[keep] ' : '[dup]  '}${filePath}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  function removeDeletedPaths(pathsToRemove: string[]): void {
    if (pathsToRemove.length === 0) return;
    const removed = new Set(pathsToRemove);
    groups = groups
      .map((group) => ({
        ...group,
        paths: group.paths.filter((groupPath) => !removed.has(groupPath)),
      }))
      .filter((group) => group.paths.length > 1);

    const validKeys = new Set(groups.map((group) => groupKey(group)));
    selectedGroupKeys = new Set([...selectedGroupKeys].filter((key) => validKeys.has(key)));
    if (selectedGroupKeys.size === 0 && groups.length > 0) {
      selectedGroupKeys = new Set(groups.map((group) => groupKey(group)));
    }
  }

  async function exportSelectedGroups(): Promise<void> {
    const selectedGroups = getSelectedGroups();
    if (selectedGroups.length === 0) {
      deps.showToast('Select at least one duplicate group to export', 'Duplicate Finder', 'info');
      return;
    }

    if (!minSizeInput) return;
    const minSizeMb = clampNonNegative(Number.parseFloat(minSizeInput.value || '0'));
    const minSizeBytes = Math.floor(minSizeMb * 1024 * 1024);

    try {
      await window.tauriAPI.writeToSystemClipboard(buildReport(selectedGroups, minSizeBytes));
      deps.showToast('Duplicate report copied to clipboard', 'Duplicate Finder', 'success');
    } catch (error) {
      deps.showToast(getErrorMessage(error), 'Duplicate Finder', 'error');
    }
  }

  async function deleteSelectedDuplicates(): Promise<void> {
    const selectedGroups = getSelectedGroups();
    const candidatePaths = getDuplicatePathsForGroups(selectedGroups);
    if (candidatePaths.length === 0) {
      deps.showToast('No duplicate files selected for deletion', 'Duplicate Finder', 'info');
      return;
    }

    const reclaimable = computeReclaimableBytes(selectedGroups);
    const confirmed = await deps.showConfirm(
      `Move ${candidatePaths.length} duplicate file(s) to Trash/Recycle Bin?\nPotential reclaim: ${deps.formatFileSize(reclaimable)}`,
      'Delete Duplicates',
      'warning'
    );
    if (!confirmed) return;

    deleteInProgress = true;
    setStatus('Deleting selected duplicate files...', 'info');
    syncSummaryAndActions();

    try {
      const DELETE_BATCH_SIZE = 20;
      const settledResults: Array<PromiseSettledResult<{ success: boolean; error?: string }>> = [];

      for (let index = 0; index < candidatePaths.length; index += DELETE_BATCH_SIZE) {
        const batch = candidatePaths.slice(index, index + DELETE_BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map((filePath) => window.tauriAPI.trashItem(filePath))
        );
        settledResults.push(...batchResults);
      }

      const successPaths: string[] = [];
      const permissionFailedPaths: string[] = [];
      const otherFailures: string[] = [];

      for (let index = 0; index < settledResults.length; index++) {
        const result = settledResults[index]!;
        const sourcePath = candidatePaths[index]!;

        if (result.status === 'fulfilled') {
          if (result.value.success) {
            successPaths.push(sourcePath);
          } else if (isPermissionDeniedError(result.value.error)) {
            permissionFailedPaths.push(sourcePath);
          } else {
            otherFailures.push(sourcePath);
          }
        } else {
          otherFailures.push(sourcePath);
        }
      }

      if (permissionFailedPaths.length > 0) {
        const elevateConfirmed = await deps.showConfirm(
          `${permissionFailedPaths.length} file(s) require administrator privileges. Attempt elevated deletion for those files?`,
          'Elevated Delete',
          'warning'
        );

        if (elevateConfirmed) {
          const elevatedResult = await window.tauriAPI.elevatedDeleteBatch(permissionFailedPaths);
          if (elevatedResult.success) {
            successPaths.push(...permissionFailedPaths);
          } else {
            deps.showToast(
              elevatedResult.error || 'Elevated delete failed',
              'Duplicate Finder',
              'error'
            );
            otherFailures.push(...permissionFailedPaths);
          }
        } else {
          otherFailures.push(...permissionFailedPaths);
        }
      }

      if (successPaths.length > 0) {
        removeDeletedPaths(successPaths);
        renderGroups();
        deps.refresh('duplicate-finder-delete');
        deps.showToast(
          `${successPaths.length} duplicate file(s) moved to Trash/Recycle Bin`,
          'Duplicate Finder',
          'success'
        );
      }

      if (otherFailures.length > 0) {
        deps.showToast(
          `${otherFailures.length} duplicate file(s) could not be deleted`,
          'Duplicate Finder',
          'error'
        );
      }

      if (groups.length === 0) {
        setStatus('All detected duplicate groups have been resolved.', 'success');
      } else {
        setStatus('Duplicate selection updated.', 'success');
      }
    } catch (error) {
      deps.showToast(getErrorMessage(error), 'Duplicate Finder', 'error');
      setStatus('Delete operation failed.', 'error');
    } finally {
      deleteInProgress = false;
      syncSummaryAndActions();
    }
  }

  async function runDuplicateScan(): Promise<void> {
    if (!ensureElements() || !minSizeInput || !includeHiddenToggle || !scanBtn) return;
    if (scanInProgress || deleteInProgress) return;

    const parsedMinSizeMb = Number.parseFloat(minSizeInput.value || '0');
    if (!Number.isFinite(parsedMinSizeMb) || parsedMinSizeMb < 0) {
      deps.showToast('Enter a valid minimum size (MB)', 'Duplicate Finder', 'warning');
      minSizeInput.focus();
      return;
    }

    currentMinSizeMb = clampNonNegative(parsedMinSizeMb);
    currentIncludeHidden = includeHiddenToggle.checked;

    const minSizeBytes = Math.floor(currentMinSizeMb * 1024 * 1024);
    const requestId = ++scanRequestId;
    scanInProgress = true;
    scanBtn.disabled = true;
    setStatus('Scanning for duplicate files...', 'info');
    syncSummaryAndActions();

    try {
      const result = await window.tauriAPI.findDuplicateFiles(
        currentRootPath,
        minSizeBytes,
        currentIncludeHidden
      );
      if (requestId !== scanRequestId) return;

      if (!result.success) {
        groups = [];
        selectedGroupKeys.clear();
        renderGroups();
        setStatus(result.error || 'Duplicate scan failed', 'error');
        deps.showToast(result.error || 'Duplicate scan failed', 'Duplicate Finder', 'error');
        return;
      }

      groups = result.groups || [];
      selectedGroupKeys = new Set(groups.map((group) => groupKey(group)));
      renderGroups();

      const duplicateFileCount = groups.reduce((total, group) => {
        return total + Math.max(0, group.paths.length - 1);
      }, 0);
      const reclaimableBytes = computeReclaimableBytes(groups);

      if (groups.length === 0) {
        setStatus('No duplicate files were found for this scan.', 'success');
        deps.showToast('No duplicates found', 'Duplicate Finder', 'success');
      } else {
        setStatus(
          `Found ${groups.length} groups • ${duplicateFileCount} duplicate files • ${deps.formatFileSize(reclaimableBytes)} reclaimable`,
          'success'
        );
      }
    } catch (error) {
      if (requestId !== scanRequestId) return;
      groups = [];
      selectedGroupKeys.clear();
      renderGroups();
      setStatus('Duplicate scan failed', 'error');
      deps.showToast(getErrorMessage(error), 'Duplicate Finder', 'error');
    } finally {
      if (requestId === scanRequestId) {
        scanInProgress = false;
        scanBtn.disabled = false;
        syncSummaryAndActions();
      }
    }
  }

  function handleGroupSelectionToggle(target: HTMLInputElement): void {
    const key = target.dataset.groupKey;
    if (!key) return;

    if (target.checked) {
      selectedGroupKeys.add(key);
    } else {
      selectedGroupKeys.delete(key);
    }
    syncSummaryAndActions();
  }

  function selectAllGroups(): void {
    selectedGroupKeys = new Set(groups.map((group) => groupKey(group)));
    groupsEl
      ?.querySelectorAll<HTMLInputElement>('.duplicate-finder-group-checkbox')
      .forEach((checkbox) => {
        checkbox.checked = true;
      });
    syncSummaryAndActions();
  }

  function selectNoGroups(): void {
    selectedGroupKeys.clear();
    groupsEl
      ?.querySelectorAll<HTMLInputElement>('.duplicate-finder-group-checkbox')
      .forEach((checkbox) => {
        checkbox.checked = false;
      });
    syncSummaryAndActions();
  }

  function openContainingFolder(groupIndex: number, pathIndex: number): void {
    const group = groups[groupIndex];
    const filePath = group?.paths[pathIndex];
    if (!filePath) return;

    const parentPath = path.dirname(filePath);
    void deps.navigateTo(parentPath);
    closeDuplicateFinderModal();
  }

  function bindListeners(): void {
    if (initialized || !modal || !scanBtn || !closeBtn || !cancelBtn || !groupsEl) return;
    initialized = true;

    closeBtn.addEventListener('click', closeDuplicateFinderModal);
    cancelBtn.addEventListener('click', closeDuplicateFinderModal);

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeDuplicateFinderModal();
      }
    });

    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDuplicateFinderModal();
      }
    });

    scanBtn.addEventListener('click', () => {
      void runDuplicateScan();
    });

    selectAllBtn?.addEventListener('click', selectAllGroups);
    selectNoneBtn?.addEventListener('click', selectNoGroups);
    exportBtn?.addEventListener('click', () => {
      void exportSelectedGroups();
    });
    deleteBtn?.addEventListener('click', () => {
      void deleteSelectedDuplicates();
    });

    groupsEl.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains('duplicate-finder-group-checkbox')) return;
      handleGroupSelectionToggle(target);
    });

    groupsEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLButtonElement>('.duplicate-finder-open-folder');
      if (!button) return;

      const groupIndex = Number.parseInt(button.dataset.groupIndex || '', 10);
      const pathIndex = Number.parseInt(button.dataset.pathIndex || '', 10);
      if (!Number.isFinite(groupIndex) || !Number.isFinite(pathIndex)) return;
      openContainingFolder(groupIndex, pathIndex);
    });
  }

  async function openDuplicateFinderModal(): Promise<void> {
    if (!ensureElements() || !modal || !rootPathValue || !minSizeInput || !includeHiddenToggle) {
      deps.showToast('Duplicate Finder modal is unavailable', 'Duplicate Finder', 'error');
      return;
    }

    const basePath = deps.getCurrentPath();
    if (!basePath || deps.isHomeViewPath(basePath)) {
      deps.showToast('Open a folder first to scan for duplicates', 'Duplicate Finder', 'info');
      return;
    }

    bindListeners();

    currentRootPath = basePath;
    rootPathValue.textContent = basePath;
    minSizeInput.value = String(currentMinSizeMb);
    includeHiddenToggle.checked = currentIncludeHidden;

    groups = [];
    selectedGroupKeys.clear();
    renderGroups();
    setStatus('Ready to scan.', 'info');

    modal.style.display = 'flex';
    deps.onModalOpen(modal);

    await runDuplicateScan();
  }

  return {
    openDuplicateFinderModal,
    closeDuplicateFinderModal,
    runDuplicateScan,
  };
}
