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
});
