import { escapeHtml } from './shared.js';
import { rendererPath as path } from './rendererUtils.js';

type BatchRenameDeps = {
  getSelectedItems: () => Set<string>;
  getAllFiles: () => Array<{ name: string; path: string; isDirectory: boolean }>;
  showToast: (
    message: string,
    title: string,
    type: 'success' | 'error' | 'info' | 'warning'
  ) => void;
  activateModal: (el: HTMLElement) => void;
  deactivateModal: (el: HTMLElement) => void;
  refresh: () => void;
  updateUndoRedoState: () => Promise<void>;
};

type RenameMode = 'find-replace' | 'sequential' | 'extension';

interface RenamePreviewItem {
  oldName: string;
  newName: string;
  oldPath: string;
  changed: boolean;
  error?: string;
}

export function createBatchRenameController(deps: BatchRenameDeps) {
  let currentMode: RenameMode = 'find-replace';
  let selectedFiles: Array<{ name: string; path: string }> = [];

  function showBatchRenameModal() {
    const selected = deps.getSelectedItems();
    if (selected.size < 2) {
      deps.showToast('Select at least 2 items to batch rename', 'Batch Rename', 'info');
      return;
    }

    const allFiles = deps.getAllFiles();
    selectedFiles = allFiles
      .filter((f) => selected.has(f.name))
      .map((f) => ({ name: f.name, path: f.path }));

    if (selectedFiles.length < 2) {
      deps.showToast('Select at least 2 items to batch rename', 'Batch Rename', 'info');
      return;
    }

    const modal = document.getElementById('batch-rename-modal');
    if (!modal) return;

    currentMode = 'find-replace';
    resetFields();
    updateFieldVisibility();
    updatePreview();
    deps.activateModal(modal);
  }

  function hideBatchRenameModal() {
    const modal = document.getElementById('batch-rename-modal');
    if (modal) deps.deactivateModal(modal);
  }

  function resetFields() {
    const find = document.getElementById('batch-rename-find') as HTMLInputElement | null;
    const replace = document.getElementById('batch-rename-replace') as HTMLInputElement | null;
    const useRegex = document.getElementById('batch-rename-use-regex') as HTMLInputElement | null;
    const prefix = document.getElementById('batch-rename-prefix') as HTMLInputElement | null;
    const start = document.getElementById('batch-rename-start') as HTMLInputElement | null;
    const newExt = document.getElementById('batch-rename-new-ext') as HTMLInputElement | null;
    const modeSelect = document.getElementById('batch-rename-mode') as HTMLSelectElement | null;

    if (find) find.value = '';
    if (replace) replace.value = '';
    if (useRegex) useRegex.checked = false;
    if (prefix) prefix.value = 'File_{N}';
    if (start) start.value = '1';
    if (newExt) newExt.value = '';
    if (modeSelect) modeSelect.value = 'find-replace';
  }

  function updateFieldVisibility() {
    const findReplace = document.getElementById('batch-rename-fields-find-replace');
    const sequential = document.getElementById('batch-rename-fields-sequential');
    const extension = document.getElementById('batch-rename-fields-extension');

    if (findReplace) findReplace.style.display = currentMode === 'find-replace' ? 'flex' : 'none';
    if (sequential) sequential.style.display = currentMode === 'sequential' ? 'flex' : 'none';
    if (extension) extension.style.display = currentMode === 'extension' ? 'flex' : 'none';
  }

  function computePreview(): RenamePreviewItem[] {
    const items: RenamePreviewItem[] = [];

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      let newName = file.name;
      let error: string | undefined;

      try {
        if (currentMode === 'find-replace') {
          const findInput = document.getElementById('batch-rename-find') as HTMLInputElement | null;
          const replaceInput = document.getElementById(
            'batch-rename-replace'
          ) as HTMLInputElement | null;
          const useRegex = document.getElementById(
            'batch-rename-use-regex'
          ) as HTMLInputElement | null;

          const findText = findInput?.value || '';
          const replaceText = replaceInput?.value || '';

          if (findText) {
            if (useRegex?.checked) {
              try {
                const regex = new RegExp(findText, 'g');
                newName = file.name.replace(regex, replaceText);
              } catch {
                error = 'Invalid regex';
              }
            } else {
              newName = file.name.split(findText).join(replaceText);
            }
          }
        } else if (currentMode === 'sequential') {
          const prefixInput = document.getElementById(
            'batch-rename-prefix'
          ) as HTMLInputElement | null;
          const startInput = document.getElementById(
            'batch-rename-start'
          ) as HTMLInputElement | null;

          const pattern = prefixInput?.value || 'File_{N}';
          const startNum = parseInt(startInput?.value || '1', 10) || 1;
          const num = startNum + i;

          const ext = path.extname(file.name);
          newName = pattern.replace(/\{N\}/g, String(num)) + ext;
        } else if (currentMode === 'extension') {
          const newExtInput = document.getElementById(
            'batch-rename-new-ext'
          ) as HTMLInputElement | null;
          let newExt = newExtInput?.value || '';

          if (newExt && !newExt.startsWith('.')) {
            newExt = '.' + newExt;
          }

          if (newExt) {
            const baseName = path.basename(file.name, path.extname(file.name));
            newName = baseName + newExt;
          }
        }
      } catch {
        error = 'Error computing name';
      }

      if (!newName || newName.trim() === '') {
        error = 'Name cannot be empty';
      }

      items.push({
        oldName: file.name,
        newName: error ? file.name : newName,
        oldPath: file.path,
        changed: !error && newName !== file.name,
        error,
      });
    }

    return items;
  }

  function updatePreview() {
    const previewList = document.getElementById('batch-rename-preview-list');
    if (!previewList) return;

    const items = computePreview();

    if (items.length === 0) {
      previewList.innerHTML = '<div class="batch-rename-preview-empty">No items selected</div>';
      return;
    }

    const html = items
      .map((item) => {
        const newClass = item.error
          ? 'batch-rename-preview-new error'
          : item.changed
            ? 'batch-rename-preview-new changed'
            : 'batch-rename-preview-new';
        const newLabel = item.error ? escapeHtml(item.error) : escapeHtml(item.newName);

        return `<div class="batch-rename-preview-row">
        <span class="batch-rename-preview-old">${escapeHtml(item.oldName)}</span>
        <span class="batch-rename-preview-arrow">→</span>
        <span class="${newClass}">${newLabel}</span>
      </div>`;
      })
      .join('');

    previewList.innerHTML = html;
  }

  async function applyBatchRename() {
    const items = computePreview();
    const toRename = items.filter((i) => i.changed && !i.error);

    if (toRename.length === 0) {
      deps.showToast('No changes to apply', 'Batch Rename', 'info');
      return;
    }

    const newNames = new Set<string>();
    for (const item of toRename) {
      if (newNames.has(item.newName.toLowerCase())) {
        deps.showToast(
          `Duplicate name "${item.newName}" would be created`,
          'Batch Rename Error',
          'error'
        );
        return;
      }
      newNames.add(item.newName.toLowerCase());
    }

    try {
      const result = await window.electronAPI.batchRename(
        toRename.map((i) => ({ oldPath: i.oldPath, newName: i.newName }))
      );

      if (!result.success) {
        deps.showToast(result.error || 'Batch rename failed', 'Error', 'error');
        return;
      }

      hideBatchRenameModal();
      deps.showToast(`Renamed ${toRename.length} item(s)`, 'Batch Rename', 'success');
      deps.refresh();
      await deps.updateUndoRedoState();
    } catch {
      deps.showToast('Batch rename failed', 'Error', 'error');
    }
  }

  function initListeners() {
    const modeSelect = document.getElementById('batch-rename-mode') as HTMLSelectElement | null;
    const closeBtn = document.getElementById('batch-rename-close');
    const cancelBtn = document.getElementById('batch-rename-cancel');
    const applyBtn = document.getElementById('batch-rename-apply');

    modeSelect?.addEventListener('change', () => {
      currentMode = modeSelect.value as RenameMode;
      updateFieldVisibility();
      updatePreview();
    });

    closeBtn?.addEventListener('click', hideBatchRenameModal);
    cancelBtn?.addEventListener('click', hideBatchRenameModal);
    applyBtn?.addEventListener('click', () => void applyBatchRename());

    const inputIds = [
      'batch-rename-find',
      'batch-rename-replace',
      'batch-rename-prefix',
      'batch-rename-start',
      'batch-rename-new-ext',
    ];

    for (const id of inputIds) {
      const el = document.getElementById(id);
      el?.addEventListener('input', updatePreview);
    }

    const useRegex = document.getElementById('batch-rename-use-regex');
    useRegex?.addEventListener('change', updatePreview);
  }

  return {
    showBatchRenameModal,
    hideBatchRenameModal,
    initListeners,
  };
}
