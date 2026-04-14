// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatchRenameController } from '../rendererBatchRename';

function setupModalDom(): void {
  document.body.innerHTML = `
    <div id="batch-rename-modal" style="display:none">
      <button id="batch-rename-close"></button>
      <select id="batch-rename-mode">
        <option value="find-replace">Find & Replace</option>
        <option value="sequential">Sequential Numbering</option>
        <option value="extension">Change Extension</option>
      </select>
      <div id="batch-rename-fields-find-replace" style="display:flex">
        <input id="batch-rename-find" value="stale-find" />
        <input id="batch-rename-replace" value="stale-replace" />
        <input id="batch-rename-use-regex" type="checkbox" checked />
      </div>
      <div id="batch-rename-fields-sequential" style="display:none">
        <input id="batch-rename-prefix" value="stale-prefix" />
        <input id="batch-rename-start" value="9" />
      </div>
      <div id="batch-rename-fields-extension" style="display:none">
        <input id="batch-rename-new-ext" value="stale-ext" />
      </div>
      <div id="batch-rename-preview-list"></div>
      <button id="batch-rename-cancel"></button>
      <button id="batch-rename-apply"></button>
    </div>
  `;
}

const defaultFiles = [
  { name: 'alpha.txt', path: '/workspace/alpha.txt', isDirectory: false },
  { name: 'beta.txt', path: '/workspace/beta.txt', isDirectory: false },
];

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    getSelectedItems: vi.fn(() => new Set(defaultFiles.map((file) => file.path))),
    getAllFiles: vi.fn(() => [...defaultFiles]),
    showToast: vi.fn(),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    refresh: vi.fn(),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('rendererBatchRename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupModalDom();

    (window as any).tauriAPI = {
      batchRename: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it('shows info toast when fewer than two items are selected', () => {
    const deps = createDeps({
      getSelectedItems: vi.fn(() => new Set(['/workspace/alpha.txt'])),
    });
    const controller = createBatchRenameController(deps as any);

    controller.showBatchRenameModal();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Select at least 2 items to batch rename',
      'Batch Rename',
      'info'
    );
  });

  it('shows info toast when selected paths do not resolve to at least two files', () => {
    const deps = createDeps({
      getSelectedItems: vi.fn(() => new Set(['/workspace/alpha.txt', '/workspace/missing.txt'])),
      getAllFiles: vi.fn(() => [
        { name: 'alpha.txt', path: '/workspace/alpha.txt', isDirectory: false },
      ]),
    });
    const controller = createBatchRenameController(deps as any);

    controller.showBatchRenameModal();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Select at least 2 items to batch rename',
      'Batch Rename',
      'info'
    );
    expect(deps.activateModal).not.toHaveBeenCalled();
  });

  it('opens modal, resets fields, and renders initial preview', () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);

    controller.showBatchRenameModal();

    const modal = document.getElementById('batch-rename-modal') as HTMLElement;
    const modeSelect = document.getElementById('batch-rename-mode') as HTMLSelectElement;
    const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
    const replaceInput = document.getElementById('batch-rename-replace') as HTMLInputElement;
    const regexToggle = document.getElementById('batch-rename-use-regex') as HTMLInputElement;
    const prefixInput = document.getElementById('batch-rename-prefix') as HTMLInputElement;
    const startInput = document.getElementById('batch-rename-start') as HTMLInputElement;
    const extensionInput = document.getElementById('batch-rename-new-ext') as HTMLInputElement;
    const findReplaceFields = document.getElementById(
      'batch-rename-fields-find-replace'
    ) as HTMLElement;
    const sequentialFields = document.getElementById(
      'batch-rename-fields-sequential'
    ) as HTMLElement;
    const extensionFields = document.getElementById('batch-rename-fields-extension') as HTMLElement;
    const previewList = document.getElementById('batch-rename-preview-list') as HTMLElement;

    expect(deps.activateModal).toHaveBeenCalledWith(modal);
    expect(modeSelect.value).toBe('find-replace');
    expect(findInput.value).toBe('');
    expect(replaceInput.value).toBe('');
    expect(regexToggle.checked).toBe(false);
    expect(prefixInput.value).toBe('File_{N}');
    expect(startInput.value).toBe('1');
    expect(extensionInput.value).toBe('');

    expect(findReplaceFields.style.display).toBe('flex');
    expect(sequentialFields.style.display).toBe('none');
    expect(extensionFields.style.display).toBe('none');

    expect(previewList.innerHTML).toContain('alpha.txt');
    expect(previewList.innerHTML).toContain('beta.txt');
  });

  it('updates preview for sequential and extension modes through listeners', () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const modeSelect = document.getElementById('batch-rename-mode') as HTMLSelectElement;
    const prefixInput = document.getElementById('batch-rename-prefix') as HTMLInputElement;
    const startInput = document.getElementById('batch-rename-start') as HTMLInputElement;
    const extensionInput = document.getElementById('batch-rename-new-ext') as HTMLInputElement;
    const sequentialFields = document.getElementById(
      'batch-rename-fields-sequential'
    ) as HTMLElement;
    const extensionFields = document.getElementById('batch-rename-fields-extension') as HTMLElement;
    const previewList = document.getElementById('batch-rename-preview-list') as HTMLElement;

    modeSelect.value = 'sequential';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    prefixInput.value = 'Item_{N}';
    startInput.value = '10';
    prefixInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(sequentialFields.style.display).toBe('flex');
    expect(previewList.innerHTML).toContain('Item_10.txt');
    expect(previewList.innerHTML).toContain('Item_11.txt');

    modeSelect.value = 'extension';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    extensionInput.value = 'md';
    extensionInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(extensionFields.style.display).toBe('flex');
    expect(previewList.innerHTML).toContain('alpha.md');
    expect(previewList.innerHTML).toContain('beta.md');
  });

  it('shows unsafe regex errors in preview', () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
    const regexToggle = document.getElementById('batch-rename-use-regex') as HTMLInputElement;
    const previewList = document.getElementById('batch-rename-preview-list') as HTMLElement;

    findInput.value = 'a*+';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    regexToggle.checked = true;
    regexToggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(previewList.textContent).toContain('Invalid or unsafe regex pattern');
  });

  it('shows no-changes toast when apply has nothing to rename', () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const applyBtn = document.getElementById('batch-rename-apply') as HTMLButtonElement;
    applyBtn.click();

    expect(deps.showToast).toHaveBeenCalledWith('No changes to apply', 'Batch Rename', 'info');
  });

  it('blocks apply when duplicate names would be produced', () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const modeSelect = document.getElementById('batch-rename-mode') as HTMLSelectElement;
    const prefixInput = document.getElementById('batch-rename-prefix') as HTMLInputElement;
    const applyBtn = document.getElementById('batch-rename-apply') as HTMLButtonElement;

    modeSelect.value = 'sequential';
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    prefixInput.value = 'Same';
    prefixInput.dispatchEvent(new Event('input', { bubbles: true }));

    applyBtn.click();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Duplicate name "Same.txt" would be created',
      'Batch Rename Error',
      'error'
    );
    expect(window.tauriAPI.batchRename).not.toHaveBeenCalled();
  });

  it('applies rename successfully and refreshes state', async () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
    const replaceInput = document.getElementById('batch-rename-replace') as HTMLInputElement;
    const applyBtn = document.getElementById('batch-rename-apply') as HTMLButtonElement;

    findInput.value = 'a';
    replaceInput.value = 'A';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));

    applyBtn.click();

    await vi.waitFor(() => {
      expect(window.tauriAPI.batchRename).toHaveBeenCalledTimes(1);
    });

    expect(window.tauriAPI.batchRename).toHaveBeenCalledWith([
      { oldPath: '/workspace/alpha.txt', newName: 'AlphA.txt' },
      { oldPath: '/workspace/beta.txt', newName: 'betA.txt' },
    ]);
    expect(deps.deactivateModal).toHaveBeenCalledWith(
      document.getElementById('batch-rename-modal') as HTMLElement
    );
    expect(deps.showToast).toHaveBeenCalledWith('Renamed 2 item(s)', 'Batch Rename', 'success');
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(deps.updateUndoRedoState).toHaveBeenCalledTimes(1);
  });

  it('shows backend failure toast when batch rename result fails', async () => {
    (window.tauriAPI.batchRename as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'rename failed',
    });

    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
    const replaceInput = document.getElementById('batch-rename-replace') as HTMLInputElement;
    const applyBtn = document.getElementById('batch-rename-apply') as HTMLButtonElement;

    findInput.value = 'a';
    replaceInput.value = 'A';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));

    applyBtn.click();

    await vi.waitFor(() => {
      expect(deps.showToast).toHaveBeenCalledWith('rename failed', 'Error', 'error');
    });
  });

  it('shows thrown-error toast when batch rename throws', async () => {
    (window.tauriAPI.batchRename as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ipc gone')
    );

    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    const findInput = document.getElementById('batch-rename-find') as HTMLInputElement;
    const replaceInput = document.getElementById('batch-rename-replace') as HTMLInputElement;
    const applyBtn = document.getElementById('batch-rename-apply') as HTMLButtonElement;

    findInput.value = 'a';
    replaceInput.value = 'A';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));

    applyBtn.click();

    await vi.waitFor(() => {
      const calls = (deps.showToast as ReturnType<typeof vi.fn>).mock.calls;
      const failedCall = calls.find((call) => String(call[0]).includes('Batch rename failed:'));
      expect(failedCall).toBeTruthy();
      expect(String(failedCall?.[0])).toContain('ipc gone');
    });
  });

  it('hides modal from close and cancel actions', () => {
    const deps = createDeps();
    const controller = createBatchRenameController(deps as any);
    controller.initListeners();
    controller.showBatchRenameModal();

    (document.getElementById('batch-rename-close') as HTMLButtonElement).click();
    (document.getElementById('batch-rename-cancel') as HTMLButtonElement).click();

    expect(deps.deactivateModal).toHaveBeenCalledTimes(2);
  });
});
