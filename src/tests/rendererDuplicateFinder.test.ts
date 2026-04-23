// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDuplicateFinderController } from '../rendererDuplicateFinder';

function setupModalDom(): void {
  document.body.innerHTML = `
    <div id="duplicate-finder-modal" style="display:none">
      <button id="duplicate-finder-close"></button>
      <div id="duplicate-finder-root"></div>
      <input id="duplicate-finder-min-size" value="1" />
      <input id="duplicate-finder-include-hidden" type="checkbox" />
      <button id="duplicate-finder-scan-btn"></button>
      <div id="duplicate-finder-status"></div>
      <div id="duplicate-finder-summary"></div>
      <div id="duplicate-finder-groups"></div>
      <button id="duplicate-finder-select-all"></button>
      <button id="duplicate-finder-select-none"></button>
      <button id="duplicate-finder-export-btn"></button>
      <button id="duplicate-finder-delete-btn"></button>
      <button id="duplicate-finder-cancel"></button>
    </div>
  `;
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentPath: vi.fn(() => '/workspace'),
    isHomeViewPath: vi.fn((pathValue: string) => pathValue === 'home-view'),
    formatFileSize: vi.fn((size: number) => `${size} B`),
    showToast: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    onModalOpen: vi.fn(),
    onModalClose: vi.fn(),
    refresh: vi.fn(),
    navigateTo: vi.fn(),
    ...overrides,
  };
}

const sampleGroups = [
  {
    size: 100,
    hash: 'aaa',
    paths: ['/workspace/docs/keep.txt', '/workspace/docs/dup1.txt', '/workspace/docs/dup2.txt'],
  },
  {
    size: 50,
    hash: 'bbb',
    paths: ['/workspace/media/keep.png', '/workspace/media/dup.png'],
  },
];

describe('rendererDuplicateFinder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupModalDom();

    (window as any).tauriAPI = {
      findDuplicateFiles: vi.fn().mockResolvedValue({ success: true, groups: sampleGroups }),
      writeToSystemClipboard: vi.fn().mockResolvedValue(undefined),
      trashItem: vi.fn().mockResolvedValue({ success: true }),
      elevatedDeleteBatch: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it('shows info toast when no folder is open', async () => {
    const deps = createDeps({ getCurrentPath: vi.fn(() => 'home-view') });
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Open a folder first to scan for duplicates',
      'Duplicate Finder',
      'info'
    );
    expect((document.getElementById('duplicate-finder-modal') as HTMLElement).style.display).toBe(
      'none'
    );
  });

  it('opens modal and renders duplicate groups from scan', async () => {
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    expect(deps.onModalOpen).toHaveBeenCalled();
    expect(window.tauriAPI.findDuplicateFiles).toHaveBeenCalledWith('/workspace', 1048576, false);

    const groupsEl = document.getElementById('duplicate-finder-groups') as HTMLElement;
    expect(groupsEl.innerHTML).toContain('Group 1');
    expect(groupsEl.innerHTML).toContain('Group 2');

    const exportBtn = document.getElementById('duplicate-finder-export-btn') as HTMLButtonElement;
    const deleteBtn = document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);
    expect(deleteBtn.disabled).toBe(false);
  });

  it('exports selected groups to clipboard', async () => {
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    (document.getElementById('duplicate-finder-export-btn') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(window.tauriAPI.writeToSystemClipboard).toHaveBeenCalled();
    });

    const report = (window.tauriAPI.writeToSystemClipboard as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(report).toContain('Duplicate scan root: /workspace');
    expect(report).toContain('Group 1');
  });

  it('deletes only duplicate paths and refreshes view', async () => {
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    (document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(window.tauriAPI.trashItem).toHaveBeenCalledTimes(3);
    });

    expect(window.tauriAPI.trashItem).toHaveBeenCalledWith('/workspace/docs/dup1.txt');
    expect(window.tauriAPI.trashItem).toHaveBeenCalledWith('/workspace/docs/dup2.txt');
    expect(window.tauriAPI.trashItem).toHaveBeenCalledWith('/workspace/media/dup.png');
    expect(window.tauriAPI.trashItem).not.toHaveBeenCalledWith('/workspace/docs/keep.txt');
    expect(window.tauriAPI.trashItem).not.toHaveBeenCalledWith('/workspace/media/keep.png');

    expect(deps.refresh).toHaveBeenCalledWith('duplicate-finder-delete');

    const groupsEl = document.getElementById('duplicate-finder-groups') as HTMLElement;
    expect(groupsEl.innerHTML).toContain('No duplicate groups found.');
  });

  it('opens containing folder from group row action', async () => {
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    const firstOpenBtn = document.querySelector(
      '.duplicate-finder-open-folder'
    ) as HTMLButtonElement | null;
    expect(firstOpenBtn).toBeTruthy();
    firstOpenBtn?.click();

    expect(deps.navigateTo).toHaveBeenCalledWith('/workspace/docs');
    expect(deps.onModalClose).toHaveBeenCalled();
  });

  it('shows error toast when modal elements are unavailable', async () => {
    document.body.innerHTML = '';
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Duplicate Finder modal is unavailable',
      'Duplicate Finder',
      'error'
    );
  });

  it('shows warning when minimum size input is invalid', async () => {
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();
    const minInput = document.getElementById('duplicate-finder-min-size') as HTMLInputElement;
    minInput.value = '-1';

    await ctrl.runDuplicateScan();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Enter a valid minimum size (MB)',
      'Duplicate Finder',
      'warning'
    );
    expect(window.tauriAPI.findDuplicateFiles).toHaveBeenCalledTimes(1);
  });

  it('shows scan failure state when backend returns error', async () => {
    (window.tauriAPI.findDuplicateFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'scan failed',
    });
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    const status = document.getElementById('duplicate-finder-status') as HTMLElement;
    expect(status.textContent).toBe('scan failed');
    expect(status.dataset.tone).toBe('error');
    expect(deps.showToast).toHaveBeenCalledWith('scan failed', 'Duplicate Finder', 'error');
  });

  it('handles scan exceptions and surfaces error status', async () => {
    (window.tauriAPI.findDuplicateFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('scan boom')
    );
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    const status = document.getElementById('duplicate-finder-status') as HTMLElement;
    expect(status.textContent).toBe('Duplicate scan failed');
    expect(status.dataset.tone).toBe('error');
    expect(deps.showToast).toHaveBeenCalledWith('scan boom', 'Duplicate Finder', 'error');
  });

  it('shows info toast when exporting with no selected groups', async () => {
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();
    (document.getElementById('duplicate-finder-select-none') as HTMLButtonElement).click();
    const exportBtn = document.getElementById('duplicate-finder-export-btn') as HTMLButtonElement;
    exportBtn.disabled = false;
    exportBtn.click();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Select at least one duplicate group to export',
      'Duplicate Finder',
      'info'
    );
    expect(window.tauriAPI.writeToSystemClipboard).not.toHaveBeenCalled();
  });

  it('shows error toast when clipboard export fails', async () => {
    (window.tauriAPI.writeToSystemClipboard as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('clipboard fail')
    );
    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();
    (document.getElementById('duplicate-finder-export-btn') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(deps.showToast).toHaveBeenCalledWith('clipboard fail', 'Duplicate Finder', 'error');
    });
  });

  it('does not delete files when delete confirmation is cancelled', async () => {
    const deps = createDeps({
      showConfirm: vi.fn().mockResolvedValue(false),
    });
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();
    (document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement).click();
    await Promise.resolve();

    expect(window.tauriAPI.trashItem).not.toHaveBeenCalled();
  });

  it('uses elevated delete for permission-denied paths', async () => {
    (window.tauriAPI.trashItem as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: false, error: 'Access is denied' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'EPERM' });
    (window.tauriAPI.elevatedDeleteBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
    });

    const deps = createDeps({
      showConfirm: vi.fn().mockResolvedValue(true),
    });
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();
    (document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(window.tauriAPI.elevatedDeleteBatch).toHaveBeenCalledWith([
        '/workspace/docs/dup1.txt',
        '/workspace/media/dup.png',
      ]);
    });

    expect(deps.refresh).toHaveBeenCalledWith('duplicate-finder-delete');
    expect(deps.showToast).toHaveBeenCalledWith(
      '3 duplicate file(s) moved to Trash/Recycle Bin',
      'Duplicate Finder',
      'success'
    );
  });

  it('reports failures when elevated delete fails', async () => {
    (window.tauriAPI.trashItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'permission denied',
    });
    (window.tauriAPI.elevatedDeleteBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'elevated failed',
    });

    const deps = createDeps({
      showConfirm: vi.fn().mockResolvedValue(true),
    });
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();
    (document.getElementById('duplicate-finder-delete-btn') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(deps.showToast).toHaveBeenCalledWith('elevated failed', 'Duplicate Finder', 'error');
    });

    expect(deps.showToast).toHaveBeenCalledWith(
      '3 duplicate file(s) could not be deleted',
      'Duplicate Finder',
      'error'
    );
  });

  it('surfaces no-duplicates status for empty scan result', async () => {
    (window.tauriAPI.findDuplicateFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      groups: [],
    });

    const deps = createDeps();
    const ctrl = createDuplicateFinderController(deps as any);

    await ctrl.openDuplicateFinderModal();

    const status = document.getElementById('duplicate-finder-status') as HTMLElement;
    expect(status.textContent).toBe('No duplicate files were found for this scan.');
    expect(status.dataset.tone).toBe('success');
    expect(deps.showToast).toHaveBeenCalledWith(
      'No duplicates found',
      'Duplicate Finder',
      'success'
    );
  });
});
