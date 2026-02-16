// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockArchiveSuffixes = vi.hoisted(() => [
  '.zip',
  '.7z',
  '.rar',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.iso',
  '.cab',
  '.arj',
  '.lzh',
  '.wim',
  '.tgz',
  '.tar.gz',
]);

vi.mock('../fileTypes.js', () => ({
  ARCHIVE_SUFFIXES: mockArchiveSuffixes,
}));

vi.mock('../shared.js', () => ({
  getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('../rendererUtils.js', () => ({
  normalizeWindowsPath: (value: string) => value.replace(/\//g, '\\'),
  rendererPath: {
    basename: (filePath: string, ext?: string): string => {
      const name = filePath.split(/[\\/]/).pop() || '';
      if (ext && name.endsWith(ext)) return name.slice(0, -ext.length);
      return name;
    },
    dirname: (filePath: string): string => {
      const normalized = filePath.replace(/\\/g, '/');
      const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
      if (!trimmed || trimmed === '/') return '/';
      const idx = trimmed.lastIndexOf('/');
      return idx <= 0 ? '/' : trimmed.slice(0, idx);
    },
    extname: (filePath: string): string => {
      const name = filePath.split(/[\\/]/).pop() || '';
      const dotIndex = name.lastIndexOf('.');
      return dotIndex === -1 ? '' : name.slice(dotIndex);
    },
    join: (...parts: string[]): string => {
      return parts.join('/').replace(/\/+/g, '/');
    },
  },
}));

import { isArchivePath, createCompressExtractController } from '../rendererCompressExtract';

function createDeps() {
  return {
    getCurrentPath: vi.fn().mockReturnValue('/home/user/documents'),
    getSelectedItems: vi.fn().mockReturnValue(new Set<string>()),
    getAllFiles: vi.fn().mockReturnValue([]),
    showToast: vi.fn() as ReturnType<typeof vi.fn>,
    showConfirm: vi.fn().mockResolvedValue(true),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    addToRecentFiles: vi.fn(),
    generateOperationId: vi.fn().mockReturnValue('op-1'),
    addOperation: vi.fn(),
    getOperation: vi.fn().mockReturnValue({ aborted: false }),
    updateOperation: vi.fn(),
    removeOperation: vi.fn(),
    isWindowsPlatform: vi.fn().mockReturnValue(false),
  };
}

function setupElectronAPI(overrides: Record<string, unknown> = {}) {
  const api = {
    compressFiles: vi.fn().mockResolvedValue({ success: true }),
    extractArchive: vi.fn().mockResolvedValue({ success: true }),
    onCompressProgress: vi.fn().mockReturnValue(vi.fn()),
    onExtractProgress: vi.fn().mockReturnValue(vi.fn()),
    openFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (window as unknown as Record<string, unknown>).electronAPI = api;
  return api;
}

describe('isArchivePath', () => {
  it('returns true for .zip files', () => {
    expect(isArchivePath('archive.zip')).toBe(true);
  });

  it('returns true for .7z files', () => {
    expect(isArchivePath('archive.7z')).toBe(true);
  });

  it('returns true for .rar files', () => {
    expect(isArchivePath('archive.rar')).toBe(true);
  });

  it('returns true for .tar files', () => {
    expect(isArchivePath('archive.tar')).toBe(true);
  });

  it('returns true for .gz files', () => {
    expect(isArchivePath('archive.gz')).toBe(true);
  });

  it('returns true for .bz2 files', () => {
    expect(isArchivePath('archive.bz2')).toBe(true);
  });

  it('returns true for .xz files', () => {
    expect(isArchivePath('archive.xz')).toBe(true);
  });

  it('returns true for .iso files', () => {
    expect(isArchivePath('archive.iso')).toBe(true);
  });

  it('returns true for .cab files', () => {
    expect(isArchivePath('archive.cab')).toBe(true);
  });

  it('returns true for .arj files', () => {
    expect(isArchivePath('archive.arj')).toBe(true);
  });

  it('returns true for .lzh files', () => {
    expect(isArchivePath('archive.lzh')).toBe(true);
  });

  it('returns true for .wim files', () => {
    expect(isArchivePath('archive.wim')).toBe(true);
  });

  it('returns true for .tgz files', () => {
    expect(isArchivePath('archive.tgz')).toBe(true);
  });

  it('returns true for .tar.gz files', () => {
    expect(isArchivePath('archive.tar.gz')).toBe(true);
  });

  it('returns true for uppercase extensions', () => {
    expect(isArchivePath('ARCHIVE.ZIP')).toBe(true);
    expect(isArchivePath('FILE.TAR.GZ')).toBe(true);
  });

  it('returns true for mixed case extensions', () => {
    expect(isArchivePath('archive.Zip')).toBe(true);
    expect(isArchivePath('archive.7Z')).toBe(true);
  });

  it('returns false for non-archive files', () => {
    expect(isArchivePath('readme.txt')).toBe(false);
    expect(isArchivePath('photo.png')).toBe(false);
    expect(isArchivePath('document.pdf')).toBe(false);
    expect(isArchivePath('video.mp4')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isArchivePath('')).toBe(false);
  });

  it('returns true for full paths', () => {
    expect(isArchivePath('/home/user/archive.zip')).toBe(true);
    expect(isArchivePath('/var/backups/data.tar.gz')).toBe(true);
  });
});

describe('createCompressExtractController', () => {
  let deps: ReturnType<typeof createDeps>;
  let api: ReturnType<typeof setupElectronAPI>;

  beforeEach(() => {
    deps = createDeps();
    api = setupElectronAPI();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleCompress', () => {
    it('shows error toast when no items are selected', async () => {
      deps.getSelectedItems.mockReturnValue(new Set());
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();
      expect(deps.showToast).toHaveBeenCalledWith('No items selected', 'Error', 'error');
    });

    it('compresses a single selected file as zip by default', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(api.compressFiles).toHaveBeenCalledWith(
        ['/home/user/documents/file.txt'],
        '/home/user/documents/file.zip',
        'zip',
        'op-1',
        undefined
      );
      expect(deps.showToast).toHaveBeenCalledWith(
        'Created file.zip',
        'Compressed Successfully',
        'success'
      );
      expect(deps.navigateTo).toHaveBeenCalledWith('/home/user/documents');
    });

    it('uses custom name when provided', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('zip', 'custom.zip');

      expect(api.compressFiles).toHaveBeenCalledWith(
        ['/home/user/documents/a.txt'],
        '/home/user/documents/custom.zip',
        'zip',
        'op-1',
        undefined
      );
    });

    it('names archive after folder when multiple items selected', async () => {
      deps.getSelectedItems.mockReturnValue(
        new Set(['/home/user/documents/a.txt', '/home/user/documents/b.txt'])
      );
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('zip');

      expect(api.compressFiles).toHaveBeenCalledWith(
        expect.any(Array),
        '/home/user/documents/documents_2_items.zip',
        'zip',
        'op-1',
        undefined
      );
    });

    it('uses 7z extension for 7z format', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('7z');

      expect(api.compressFiles).toHaveBeenCalledWith(
        expect.any(Array),
        '/home/user/documents/file.7z',
        '7z',
        'op-1',
        undefined
      );
    });

    it('uses tar extension for tar format', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('tar');

      expect(api.compressFiles).toHaveBeenCalledWith(
        expect.any(Array),
        '/home/user/documents/file.tar',
        'tar',
        'op-1',
        undefined
      );
    });

    it('uses tar.gz extension for tar.gz format', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('tar.gz');

      expect(api.compressFiles).toHaveBeenCalledWith(
        expect.any(Array),
        '/home/user/documents/file.tar.gz',
        'tar.gz',
        'op-1',
        undefined
      );
    });

    it('falls back to .zip extension for unknown format', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('unknown');

      expect(api.compressFiles).toHaveBeenCalledWith(
        expect.any(Array),
        '/home/user/documents/file.zip',
        'unknown',
        'op-1',
        undefined
      );
    });

    it('passes advancedOptions to compressFiles', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const opts = { compressionLevel: 9 };
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress('zip', 'out.zip', opts);

      expect(api.compressFiles).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(String),
        'zip',
        'op-1',
        opts
      );
    });

    it('shows error toast on compression failure result', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      api.compressFiles.mockResolvedValue({ success: false, error: 'disk full' });
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.showToast).toHaveBeenCalledWith('disk full', 'Error', 'error');
    });

    it('shows generic error when result.error is empty', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      api.compressFiles.mockResolvedValue({ success: false });
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.showToast).toHaveBeenCalledWith('Compression failed', 'Error', 'error');
    });

    it('shows error toast when compressFiles throws', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      api.compressFiles.mockRejectedValue(new Error('network error'));
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.showToast).toHaveBeenCalledWith('network error', 'Compression Error', 'error');
      expect(deps.removeOperation).toHaveBeenCalledWith('op-1');
    });

    it('registers and cleans up compress progress handler', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      const cleanup = vi.fn();
      api.onCompressProgress.mockReturnValue(cleanup);
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(api.onCompressProgress).toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
    });

    it('progress handler updates operation', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onCompressProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });

      api.compressFiles.mockImplementation(async () => {
        capturedHandler({
          operationId: 'op-1',
          current: 1,
          total: 5,
          name: 'test.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.updateOperation).toHaveBeenCalledWith('op-1', 1, 5, 'test.txt');
    });

    it('progress handler ignores different operationIds', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onCompressProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });
      api.compressFiles.mockImplementation(async () => {
        capturedHandler({
          operationId: 'different-op',
          current: 1,
          total: 5,
          name: 'test.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.updateOperation).not.toHaveBeenCalled();
    });

    it('progress handler skips update when operation is aborted', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      deps.getOperation.mockReturnValue({ aborted: true });
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onCompressProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });
      api.compressFiles.mockImplementation(async () => {
        capturedHandler({
          operationId: 'op-1',
          current: 1,
          total: 5,
          name: 'test.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.updateOperation).not.toHaveBeenCalled();
    });

    it('aborts early when operation is aborted before compressFiles call', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      deps.getOperation.mockReturnValue({ aborted: true });

      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(api.compressFiles).not.toHaveBeenCalled();
      expect(deps.removeOperation).toHaveBeenCalledWith('op-1');
    });

    it('progress handler skips update when getOperation returns undefined', async () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/file.txt']));
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onCompressProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });

      let callCount = 0;
      deps.getOperation.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { aborted: false };
        return undefined;
      });
      api.compressFiles.mockImplementation(async () => {
        capturedHandler({
          operationId: 'op-1',
          current: 1,
          total: 5,
          name: 'test.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      await ctrl.handleCompress();

      expect(deps.updateOperation).not.toHaveBeenCalled();
    });
  });

  describe('showCompressOptionsModal', () => {
    function createCompressModalDOM() {
      document.body.innerHTML = `
        <div id="compress-options-modal" style="display:none">
          <input id="compress-archive-name" type="text" />
          <select id="compress-format">
            <option value="zip">zip</option>
            <option value="7z">7z</option>
            <option value="tar">tar</option>
            <option value="tar.gz">tar.gz</option>
          </select>
          <select id="compress-level">
            <option value="0">Store</option>
            <option value="5" selected>Normal</option>
            <option value="9">Ultra</option>
          </select>
          <select id="compress-method">
            <option value="LZMA2">LZMA2</option>
          </select>
          <div id="compress-method-field"></div>
          <select id="compress-dictionary"></select>
          <div id="compress-dictionary-field"></div>
          <select id="compress-solid"></select>
          <div id="compress-solid-field"></div>
          <select id="compress-threads"></select>
          <div id="compress-threads-field"></div>
          <input id="compress-password" type="password" />
          <input id="compress-password-confirm" type="password" />
          <button id="compress-password-toggle"></button>
          <fieldset id="compress-encryption-fieldset"></fieldset>
          <select id="compress-encryption-method">
            <option value="AES256">AES256</option>
          </select>
          <div id="compress-encryption-method-field"></div>
          <input id="compress-encrypt-names" type="checkbox" />
          <div id="compress-encrypt-names-field"></div>
          <select id="compress-split">
            <option value="">None</option>
          </select>
          <div id="compress-split-field"></div>
          <span id="compress-preview-path"></span>
          <button id="compress-options-confirm">OK</button>
          <button id="compress-options-cancel">Cancel</button>
          <button id="compress-options-close">X</button>
        </div>
      `;
    }

    it('does nothing when modal element is missing', () => {
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showCompressOptionsModal();
      expect(deps.activateModal).not.toHaveBeenCalled();
    });

    it('shows error when no items selected', () => {
      createCompressModalDOM();
      deps.getSelectedItems.mockReturnValue(new Set());
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showCompressOptionsModal();
      expect(deps.showToast).toHaveBeenCalledWith('No items selected', 'Error', 'error');
    });

    it('opens modal for a single selected item', () => {
      createCompressModalDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/photo.jpg']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showCompressOptionsModal();

      const modal = document.getElementById('compress-options-modal') as HTMLElement;
      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;

      expect(modal.style.display).toBe('flex');
      expect(nameInput.value).toBe('photo.7z');
      expect(deps.activateModal).toHaveBeenCalledWith(modal);
    });

    it('opens modal for multiple selected items', () => {
      createCompressModalDOM();
      deps.getSelectedItems.mockReturnValue(
        new Set(['/home/user/documents/a.txt', '/home/user/documents/b.txt'])
      );
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      expect(nameInput.value).toBe('documents_2_items.7z');
    });

    it('resets all fields when opening', () => {
      createCompressModalDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/data.csv']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      const levelSelect = document.getElementById('compress-level') as HTMLSelectElement;
      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const encryptNamesCheck = document.getElementById(
        'compress-encrypt-names'
      ) as HTMLInputElement;

      expect(formatSelect.value).toBe('7z');
      expect(levelSelect.value).toBe('5');
      expect(passwordInput.value).toBe('');
      expect(passwordInput.type).toBe('password');
      expect(encryptNamesCheck.checked).toBe(false);
    });

    it('strips compound extensions from single file name', () => {
      createCompressModalDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/backup.tar.gz']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      expect(nameInput.value).toBe('backup.7z');
    });
  });

  describe('hideCompressOptionsModal', () => {
    it('hides the modal and deactivates it', () => {
      document.body.innerHTML = `
        <div id="compress-options-modal" style="display:flex"></div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.hideCompressOptionsModal();

      const modal = document.getElementById('compress-options-modal') as HTMLElement;
      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalledWith(modal);
    });

    it('does nothing when modal is missing', () => {
      const ctrl = createCompressExtractController(deps as any);
      ctrl.hideCompressOptionsModal();
      expect(deps.deactivateModal).not.toHaveBeenCalled();
    });
  });

  describe('showExtractModal', () => {
    function createExtractModalDOM() {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
    }

    it('does nothing when modal elements are missing', () => {
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/path/to/archive.zip');
      expect(deps.activateModal).not.toHaveBeenCalled();
    });

    it('opens the extract modal and populates fields', () => {
      createExtractModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');

      const modal = document.getElementById('extract-modal') as HTMLElement;
      const message = document.getElementById('extract-modal-message') as HTMLElement;
      const input = document.getElementById('extract-destination-input') as HTMLInputElement;

      expect(modal.style.display).toBe('flex');
      expect(message.textContent).toBe('Extract archive.zip?');
      expect(input.value).toBe('/home/user');
      expect(deps.activateModal).toHaveBeenCalledWith(modal);
    });

    it('uses provided archiveName in the message', () => {
      createExtractModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip', 'My Archive');

      const message = document.getElementById('extract-modal-message') as HTMLElement;
      expect(message.textContent).toBe('Extract My Archive?');
    });

    it('shows extract preview path', () => {
      createExtractModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/data.tar.gz');

      const preview = document.getElementById('extract-preview-path') as HTMLElement;
      expect(preview.textContent).toContain('data');
    });
  });

  describe('hideExtractModal', () => {
    it('hides the extract modal', () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex"></div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.hideExtractModal();

      const modal = document.getElementById('extract-modal') as HTMLElement;
      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalledWith(modal);
    });

    it('does nothing when modal is missing', () => {
      const ctrl = createCompressExtractController(deps as any);
      ctrl.hideExtractModal();
      expect(deps.deactivateModal).not.toHaveBeenCalled();
    });
  });

  describe('openPathWithArchivePrompt', () => {
    it('does nothing for empty path', async () => {
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openPathWithArchivePrompt('');
      expect(api.openFile).not.toHaveBeenCalled();
    });

    it('shows extract modal for archive file', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openPathWithArchivePrompt('/home/user/data.zip');

      const modal = document.getElementById('extract-modal') as HTMLElement;
      expect(modal.style.display).toBe('flex');
      expect(api.openFile).not.toHaveBeenCalled();
    });

    it('opens non-archive files directly and tracks recent', async () => {
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openPathWithArchivePrompt('/home/user/readme.txt');

      expect(api.openFile).toHaveBeenCalledWith('/home/user/readme.txt');
      expect(deps.addToRecentFiles).toHaveBeenCalledWith('/home/user/readme.txt');
    });

    it('opens non-archive files without tracking when trackRecent is false', async () => {
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openPathWithArchivePrompt('/home/user/readme.txt', undefined, false);

      expect(api.openFile).toHaveBeenCalledWith('/home/user/readme.txt');
      expect(deps.addToRecentFiles).not.toHaveBeenCalled();
    });

    it('passes fileName to showExtractModal', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openPathWithArchivePrompt('/home/user/data.zip', 'MyZip');

      const message = document.getElementById('extract-modal-message') as HTMLElement;
      expect(message.textContent).toBe('Extract MyZip?');
    });
  });

  describe('openFileEntry', () => {
    it('navigates to directory for directory items', async () => {
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openFileEntry({
        name: 'subdir',
        path: '/home/user/documents/subdir',
        isDirectory: true,
        isFile: false,
        size: 0,
        modified: new Date(),
        isHidden: false,
      });

      expect(deps.navigateTo).toHaveBeenCalledWith('/home/user/documents/subdir');
      expect(api.openFile).not.toHaveBeenCalled();
    });

    it('opens archive file entry with extract modal', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openFileEntry({
        name: 'data.zip',
        path: '/home/user/documents/data.zip',
        isDirectory: false,
        isFile: true,
        size: 1024,
        modified: new Date(),
        isHidden: false,
      });

      const modal = document.getElementById('extract-modal') as HTMLElement;
      expect(modal.style.display).toBe('flex');
    });

    it('opens non-archive file entry normally', async () => {
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.openFileEntry({
        name: 'readme.md',
        path: '/home/user/documents/readme.md',
        isDirectory: false,
        isFile: true,
        size: 500,
        modified: new Date(),
        isHidden: false,
      });

      expect(api.openFile).toHaveBeenCalledWith('/home/user/documents/readme.md');
    });
  });

  describe('confirmExtractModal', () => {
    it('does nothing when input element is missing', async () => {
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.confirmExtractModal();
      expect(api.extractArchive).not.toHaveBeenCalled();
    });

    it('does nothing when no archive path is set', async () => {
      document.body.innerHTML = `
        <input id="extract-destination-input" type="text" value="/dest" />
      `;
      const ctrl = createCompressExtractController(deps as any);
      await ctrl.confirmExtractModal();
      expect(api.extractArchive).not.toHaveBeenCalled();
    });

    it('shows warning when destination is empty', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);

      ctrl.showExtractModal('/home/user/archive.zip');

      (document.getElementById('extract-destination-input') as HTMLInputElement).value = '   ';
      await ctrl.confirmExtractModal();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Choose a destination folder',
        'Missing Destination',
        'warning'
      );
    });

    it('extracts archive successfully', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(api.extractArchive).toHaveBeenCalledWith(
        '/home/user/archive.zip',
        expect.stringContaining('archive'),
        'op-1'
      );
      expect(deps.showToast).toHaveBeenCalledWith(
        expect.stringContaining('Extracted to'),
        'Extraction Complete',
        'success'
      );
    });

    it('tracks recent files after successful extraction by default', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.addToRecentFiles).toHaveBeenCalledWith('/home/user/archive.zip');
    });

    it('does not track recent files when trackRecent is false', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip', undefined, false);
      await ctrl.confirmExtractModal();

      expect(deps.addToRecentFiles).not.toHaveBeenCalled();
    });

    it('refreshes current directory after extraction if dest matches current path', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user/documents" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      deps.getCurrentPath.mockReturnValue('/home/user/documents');
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/documents/archive.zip');

      (document.getElementById('extract-destination-input') as HTMLInputElement).value =
        '/home/user/documents';
      await ctrl.confirmExtractModal();

      expect(deps.navigateTo).toHaveBeenCalledWith('/home/user/documents');
    });

    it('shows error when extraction fails', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      api.extractArchive.mockResolvedValue({
        success: false,
        error: 'corrupted archive',
      });
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.showToast).toHaveBeenCalledWith('corrupted archive', 'Error', 'error');
    });

    it('shows generic error when extraction fails without error message', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      api.extractArchive.mockResolvedValue({ success: false });
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.showToast).toHaveBeenCalledWith('Extraction failed', 'Error', 'error');
    });

    it('handles extraction exception', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      api.extractArchive.mockRejectedValue(new Error('permission denied'));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.showToast).toHaveBeenCalledWith('permission denied', 'Extraction Error', 'error');
      expect(deps.removeOperation).toHaveBeenCalledWith('op-1');
    });

    it('shows error for unsupported archive format', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);

      ctrl.showExtractModal('/home/user/readme.txt');
      await ctrl.confirmExtractModal();

      expect(deps.showToast).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported archive format'),
        'Error',
        'error'
      );
    });

    it('aborts early when operation is already aborted before extract call', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      deps.getOperation.mockReturnValue({ aborted: true });
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(api.extractArchive).not.toHaveBeenCalled();
      expect(deps.removeOperation).toHaveBeenCalledWith('op-1');
    });

    it('handles empty destination in handleExtract', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');

      (document.getElementById('extract-destination-input') as HTMLInputElement).value = '   ';
      await ctrl.confirmExtractModal();

      expect(deps.showToast).toHaveBeenCalledWith(
        'Choose a destination folder',
        'Missing Destination',
        'warning'
      );
    });
  });

  describe('updateExtractPreview', () => {
    it('does nothing when preview element is missing', () => {
      const ctrl = createCompressExtractController(deps as any);
      ctrl.updateExtractPreview('/some/path');
    });

    it('clears preview when baseFolder is empty', () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      ctrl.updateExtractPreview('');

      const preview = document.getElementById('extract-preview-path') as HTMLElement;
      expect(preview.textContent).toBe('');
    });

    it('shows preview path when baseFolder is given', () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      ctrl.updateExtractPreview('/home/user/dest');

      const preview = document.getElementById('extract-preview-path') as HTMLElement;
      expect(preview.textContent).toContain('archive');
    });

    it('does nothing when no archive path is set', () => {
      document.body.innerHTML = `<span id="extract-preview-path"></span>`;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.updateExtractPreview('/some/path');

      const preview = document.getElementById('extract-preview-path') as HTMLElement;

      expect(preview.textContent).toBe('');
    });
  });

  describe('setupCompressOptionsModal', () => {
    function createFullCompressModalDOM() {
      document.body.innerHTML = `
        <div id="compress-options-modal" style="display:none">
          <input id="compress-archive-name" type="text" value="test.7z" />
          <select id="compress-format">
            <option value="zip">zip</option>
            <option value="7z" selected>7z</option>
            <option value="tar">tar</option>
            <option value="tar.gz">tar.gz</option>
          </select>
          <select id="compress-level">
            <option value="0">Store</option>
            <option value="5" selected>Normal</option>
            <option value="9">Ultra</option>
          </select>
          <select id="compress-method">
            <option value="LZMA2">LZMA2</option>
            <option value="LZMA">LZMA</option>
          </select>
          <div id="compress-method-field"></div>
          <select id="compress-dictionary"><option value="">Auto</option></select>
          <div id="compress-dictionary-field"></div>
          <select id="compress-solid"><option value="">Auto</option></select>
          <div id="compress-solid-field"></div>
          <select id="compress-threads"><option value="">Auto</option></select>
          <div id="compress-threads-field"></div>
          <input id="compress-password" type="password" />
          <input id="compress-password-confirm" type="password" />
          <button id="compress-password-toggle"></button>
          <fieldset id="compress-encryption-fieldset"></fieldset>
          <select id="compress-encryption-method">
            <option value="AES256">AES256</option>
          </select>
          <div id="compress-encryption-method-field"></div>
          <input id="compress-encrypt-names" type="checkbox" />
          <div id="compress-encrypt-names-field"></div>
          <select id="compress-split"><option value="">None</option></select>
          <div id="compress-split-field"></div>
          <span id="compress-preview-path"></span>
          <button id="compress-options-confirm">OK</button>
          <button id="compress-options-cancel">Cancel</button>
          <button id="compress-options-close">X</button>
        </div>
      `;
    }

    it('does nothing when modal is missing', () => {
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
    });

    it('sets up event listeners on modal elements', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();
      const modal = document.getElementById('compress-options-modal') as HTMLElement;
      expect(modal.style.display).toBe('flex');

      const cancelBtn = document.getElementById('compress-options-cancel') as HTMLElement;
      cancelBtn.click();
      expect(modal.style.display).toBe('none');
    });

    it('close button hides the modal', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();
      const modal = document.getElementById('compress-options-modal') as HTMLElement;

      const closeBtn = document.getElementById('compress-options-close') as HTMLElement;
      closeBtn.click();
      expect(modal.style.display).toBe('none');
    });

    it('clicking modal backdrop hides the modal', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();
      const modal = document.getElementById('compress-options-modal') as HTMLElement;

      modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(modal.style.display).toBe('none');
    });

    it('clicking inside modal content does not hide the modal', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();
      const modal = document.getElementById('compress-options-modal') as HTMLElement;
      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;

      nameInput.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(modal.style.display).toBe('flex');
    });

    it('format change updates the file name extension', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;

      formatSelect.value = 'zip';
      formatSelect.dispatchEvent(new Event('change'));

      expect(nameInput.value).toContain('.zip');
    });

    it('format change to tar.gz updates extension', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;

      formatSelect.value = 'tar.gz';
      formatSelect.dispatchEvent(new Event('change'));

      expect(nameInput.value).toContain('.tar.gz');
    });

    it('name input change updates preview path', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      const preview = document.getElementById('compress-preview-path') as HTMLElement;

      nameInput.value = 'myarchive.7z';
      nameInput.dispatchEvent(new Event('input'));

      expect(preview.textContent).toContain('myarchive.7z');
    });

    it('password toggle switches input type', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const passwordConfirm = document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement;
      const toggle = document.getElementById('compress-password-toggle') as HTMLElement;

      expect(passwordInput.type).toBe('password');
      toggle.click();
      expect(passwordInput.type).toBe('text');
      expect(passwordConfirm.type).toBe('text');
      expect(toggle.title).toBe('Hide password');

      toggle.click();
      expect(passwordInput.type).toBe('password');
      expect(passwordConfirm.type).toBe('password');
      expect(toggle.title).toBe('Show password');
    });

    it('Escape key hides the modal', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();
      const modal = document.getElementById('compress-options-modal') as HTMLElement;

      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(modal.style.display).toBe('none');
    });

    it('Enter key triggers confirm (on non-select elements)', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();
      const modal = document.getElementById('compress-options-modal') as HTMLElement;
      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      });
      nameInput.dispatchEvent(event);

      expect(deps.addOperation).toHaveBeenCalled();
    });

    it('Enter key on a SELECT element does not trigger confirm', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      const prevCallCount = deps.addOperation.mock.calls.length;

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      });
      formatSelect.dispatchEvent(event);

      expect(deps.addOperation.mock.calls.length).toBe(prevCallCount);
    });

    it('Shift+Enter does not trigger confirm', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      const prevCallCount = deps.addOperation.mock.calls.length;

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
      });
      nameInput.dispatchEvent(event);

      expect(deps.addOperation.mock.calls.length).toBe(prevCallCount);
    });

    it('level select change sets userChoseStore dataset', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      const levelSelect = document.getElementById('compress-level') as HTMLSelectElement;

      levelSelect.value = '0';
      levelSelect.dispatchEvent(new Event('change'));
      expect(levelSelect.dataset.userChoseStore).toBe('1');

      levelSelect.value = '5';
      levelSelect.dispatchEvent(new Event('change'));
      expect(levelSelect.dataset.userChoseStore).toBe('');
    });

    it('method select change triggers visibility update', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const methodSelect = document.getElementById('compress-method') as HTMLSelectElement;
      methodSelect.dispatchEvent(new Event('change'));

      const dictionaryField = document.getElementById('compress-dictionary-field') as HTMLElement;
      expect(dictionaryField).toBeTruthy();
    });

    it('confirm button triggers compression', () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      expect(deps.addOperation).toHaveBeenCalled();
    });
  });

  describe('confirmCompressOptions', () => {
    function createFullCompressModalDOM() {
      document.body.innerHTML = `
        <div id="compress-options-modal" style="display:none">
          <input id="compress-archive-name" type="text" value="test.7z" />
          <select id="compress-format">
            <option value="zip">zip</option>
            <option value="7z" selected>7z</option>
            <option value="tar">tar</option>
            <option value="tar.gz">tar.gz</option>
          </select>
          <select id="compress-level">
            <option value="0">Store</option>
            <option value="5" selected>Normal</option>
            <option value="9">Ultra</option>
          </select>
          <select id="compress-method">
            <option value="LZMA2">LZMA2</option>
            <option value="LZMA">LZMA</option>
            <option value="PPMd">PPMd</option>
          </select>
          <div id="compress-method-field"></div>
          <select id="compress-dictionary"><option value="">Auto</option><option value="64m">64m</option></select>
          <div id="compress-dictionary-field"></div>
          <select id="compress-solid"><option value="">Auto</option><option value="4g">4g</option></select>
          <div id="compress-solid-field"></div>
          <select id="compress-threads"><option value="">Auto</option><option value="4">4</option></select>
          <div id="compress-threads-field"></div>
          <input id="compress-password" type="password" />
          <input id="compress-password-confirm" type="password" />
          <button id="compress-password-toggle"></button>
          <fieldset id="compress-encryption-fieldset"></fieldset>
          <select id="compress-encryption-method">
            <option value="AES256">AES256</option>
            <option value="ZipCrypto">ZipCrypto</option>
          </select>
          <div id="compress-encryption-method-field"></div>
          <input id="compress-encrypt-names" type="checkbox" />
          <div id="compress-encrypt-names-field"></div>
          <select id="compress-split"><option value="">None</option><option value="100m">100m</option></select>
          <div id="compress-split-field"></div>
          <span id="compress-preview-path"></span>
          <button id="compress-options-confirm">OK</button>
          <button id="compress-options-cancel">Cancel</button>
          <button id="compress-options-close">X</button>
        </div>
      `;
    }

    it('warns when archive name is empty', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      nameInput.value = '   ';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Enter an archive name',
          'Missing Name',
          'warning'
        );
      });
    });

    it('appends correct extension if missing', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      nameInput.value = 'myarchive';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.stringContaining('myarchive.7z'),
          '7z',
          'op-1',
          undefined
        );
      });
    });

    it('warns on password mismatch', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const passwordConfirm = document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement;
      passwordInput.value = 'pass123';
      passwordConfirm.value = 'pass456';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Passwords do not match',
          'Password Mismatch',
          'warning'
        );
      });
    });

    it('passes password in advancedOptions for 7z format', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const passwordConfirm = document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement;
      passwordInput.value = 'secret';
      passwordConfirm.value = 'secret';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ password: 'secret' })
        );
      });
    });

    it('passes encryptFileNames for 7z with password and encrypt names checked', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const passwordConfirm = document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement;
      const encryptNames = document.getElementById('compress-encrypt-names') as HTMLInputElement;
      passwordInput.value = 'secret';
      passwordConfirm.value = 'secret';
      encryptNames.checked = true;

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({
            password: 'secret',
            encryptFileNames: true,
          })
        );
      });
    });

    it('passes encryptionMethod for zip with password', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      formatSelect.value = 'zip';
      formatSelect.dispatchEvent(new Event('change'));

      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const passwordConfirm = document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement;
      passwordInput.value = 'pass';
      passwordConfirm.value = 'pass';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          'zip',
          'op-1',
          expect.objectContaining({
            password: 'pass',
            encryptionMethod: 'AES256',
          })
        );
      });
    });

    it('passes compressionLevel when not default', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const levelSelect = document.getElementById('compress-level') as HTMLSelectElement;
      levelSelect.value = '9';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ compressionLevel: 9 })
        );
      });
    });

    it('passes method when not default for format', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const methodSelect = document.getElementById('compress-method') as HTMLSelectElement;
      methodSelect.value = 'PPMd';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ method: 'PPMd' })
        );
      });
    });

    it('includes solidBlockSize for 7z format', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const solidSelect = document.getElementById('compress-solid') as HTMLSelectElement;
      solidSelect.value = '4g';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ solidBlockSize: '4g' })
        );
      });
    });

    it('includes cpuThreads when selected', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const threadsSelect = document.getElementById('compress-threads') as HTMLSelectElement;
      threadsSelect.value = '4';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ cpuThreads: '4' })
        );
      });
    });

    it('includes splitVolume when selected', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const splitSelect = document.getElementById('compress-split') as HTMLSelectElement;
      splitSelect.value = '100m';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ splitVolume: '100m' })
        );
      });
    });

    it('does not pass advancedOptions for tar format', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      formatSelect.value = 'tar';
      formatSelect.dispatchEvent(new Event('change'));

      const passwordInput = document.getElementById('compress-password') as HTMLInputElement;
      const passwordConfirm = document.getElementById(
        'compress-password-confirm'
      ) as HTMLInputElement;
      passwordInput.value = 'secret';
      passwordConfirm.value = 'secret';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          'tar',
          'op-1',
          undefined
        );
      });
    });

    it('replaces slashes in archive name', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      nameInput.value = 'my/archive\\name.7z';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.stringContaining('my_archive_name.7z'),
          '7z',
          'op-1',
          undefined
        );
      });
    });

    it('passes dictionarySize for 7z format', async () => {
      createFullCompressModalDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      ctrl.showCompressOptionsModal();

      const dictionarySelect = document.getElementById('compress-dictionary') as HTMLSelectElement;
      dictionarySelect.value = '64m';

      const confirmBtn = document.getElementById('compress-options-confirm') as HTMLElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(api.compressFiles).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(String),
          '7z',
          'op-1',
          expect.objectContaining({ dictionarySize: '64m' })
        );
      });
    });
  });

  describe('updateCompressOptionsVisibility (via format changes)', () => {
    function createVisibilityDOM() {
      document.body.innerHTML = `
        <div id="compress-options-modal" style="display:none">
          <input id="compress-archive-name" type="text" value="test.7z" />
          <select id="compress-format">
            <option value="zip">zip</option>
            <option value="7z" selected>7z</option>
            <option value="tar">tar</option>
            <option value="tar.gz">tar.gz</option>
          </select>
          <select id="compress-level">
            <option value="0">Store</option>
            <option value="5" selected>Normal</option>
            <option value="9">Ultra</option>
          </select>
          <select id="compress-method"></select>
          <div id="compress-method-field"></div>
          <select id="compress-dictionary"><option value="">Auto</option></select>
          <div id="compress-dictionary-field"></div>
          <select id="compress-solid"><option value="">Auto</option></select>
          <div id="compress-solid-field"></div>
          <select id="compress-threads"><option value="">Auto</option></select>
          <div id="compress-threads-field"></div>
          <input id="compress-password" type="password" />
          <input id="compress-password-confirm" type="password" />
          <button id="compress-password-toggle"></button>
          <fieldset id="compress-encryption-fieldset"></fieldset>
          <select id="compress-encryption-method">
            <option value="AES256">AES256</option>
          </select>
          <div id="compress-encryption-method-field"></div>
          <input id="compress-encrypt-names" type="checkbox" />
          <div id="compress-encrypt-names-field"></div>
          <select id="compress-split"><option value="">None</option></select>
          <div id="compress-split-field"></div>
          <span id="compress-preview-path"></span>
          <button id="compress-options-confirm">OK</button>
          <button id="compress-options-cancel">Cancel</button>
          <button id="compress-options-close">X</button>
        </div>
      `;
    }

    it('shows 7z-specific fields for 7z format', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const solidField = document.getElementById('compress-solid-field') as HTMLElement;
      const encryptNamesField = document.getElementById(
        'compress-encrypt-names-field'
      ) as HTMLElement;
      const encryptionFieldset = document.getElementById(
        'compress-encryption-fieldset'
      ) as HTMLElement;

      expect(solidField.hidden).toBe(false);
      expect(encryptNamesField.hidden).toBe(false);
      expect(encryptionFieldset.hidden).toBe(false);
    });

    it('hides advanced fields for tar format', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      formatSelect.value = 'tar';
      formatSelect.dispatchEvent(new Event('change'));

      const methodField = document.getElementById('compress-method-field') as HTMLElement;
      const encryptionFieldset = document.getElementById(
        'compress-encryption-fieldset'
      ) as HTMLElement;
      const splitField = document.getElementById('compress-split-field') as HTMLElement;
      const levelSelect = document.getElementById('compress-level') as HTMLSelectElement;

      expect(methodField.hidden).toBe(true);
      expect(encryptionFieldset.hidden).toBe(true);
      expect(splitField.hidden).toBe(true);
      expect(levelSelect.disabled).toBe(true);
      expect(levelSelect.value).toBe('0');
    });

    it('shows zip-specific methods', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      formatSelect.value = 'zip';
      formatSelect.dispatchEvent(new Event('change'));

      const methodSelect = document.getElementById('compress-method') as HTMLSelectElement;
      const options = Array.from(methodSelect.options).map((o) => o.value);
      expect(options).toContain('Deflate');
      expect(options).toContain('BZip2');
    });

    it('restores level from 0 to 5 when switching away from tar (without userChoseStore)', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      const levelSelect = document.getElementById('compress-level') as HTMLSelectElement;

      formatSelect.value = 'tar';
      formatSelect.dispatchEvent(new Event('change'));
      expect(levelSelect.value).toBe('0');

      formatSelect.value = '7z';
      formatSelect.dispatchEvent(new Event('change'));
      expect(levelSelect.value).toBe('5');
    });

    it('keeps level at 0 when user explicitly chose store', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      const levelSelect = document.getElementById('compress-level') as HTMLSelectElement;

      levelSelect.value = '0';
      levelSelect.dispatchEvent(new Event('change'));
      expect(levelSelect.dataset.userChoseStore).toBe('1');

      formatSelect.value = 'zip';
      formatSelect.dispatchEvent(new Event('change'));
    });

    it('hides encryption method field for non-zip format', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const encryptionMethodField = document.getElementById(
        'compress-encryption-method-field'
      ) as HTMLElement;
      expect(encryptionMethodField.hidden).toBe(true);
    });

    it('shows encryption method field for zip format', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      formatSelect.value = 'zip';
      formatSelect.dispatchEvent(new Event('change'));

      const encryptionMethodField = document.getElementById(
        'compress-encryption-method-field'
      ) as HTMLElement;
      expect(encryptionMethodField.hidden).toBe(false);
    });

    it('hides threads field for tar format', () => {
      createVisibilityDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();
      ctrl.showCompressOptionsModal();

      const formatSelect = document.getElementById('compress-format') as HTMLSelectElement;
      formatSelect.value = 'tar';
      formatSelect.dispatchEvent(new Event('change'));

      const threadsField = document.getElementById('compress-threads-field') as HTMLElement;
      expect(threadsField.hidden).toBe(true);
    });
  });

  describe('updateCompressPreviewPath', () => {
    function createPreviewDOM() {
      document.body.innerHTML = `
        <div id="compress-options-modal">
          <input id="compress-archive-name" type="text" value="" />
          <select id="compress-format">
            <option value="7z" selected>7z</option>
          </select>
          <span id="compress-preview-path"></span>
        </div>
      `;
    }

    it('shows default archive name when input is empty', () => {
      createPreviewDOM();
      deps.getSelectedItems.mockReturnValue(new Set(['/home/user/documents/a.txt']));
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      nameInput.value = '';
      nameInput.dispatchEvent(new Event('input'));

      const preview = document.getElementById('compress-preview-path') as HTMLElement;
      expect(preview.textContent).toContain('Archive.7z');
    });

    it('sanitizes slashes in preview name', () => {
      createPreviewDOM();
      const ctrl = createCompressExtractController(deps as any);
      ctrl.setupCompressOptionsModal();

      const nameInput = document.getElementById('compress-archive-name') as HTMLInputElement;
      nameInput.value = 'my/test\\name.7z';
      nameInput.dispatchEvent(new Event('input'));

      const preview = document.getElementById('compress-preview-path') as HTMLElement;
      expect(preview.textContent).toContain('my_test_name.7z');
    });
  });

  describe('joinFilePath on Windows platform', () => {
    it('uses backslashes for Windows paths in extract preview', () => {
      deps.isWindowsPlatform.mockReturnValue(true);
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('C:\\Users\\test\\archive.zip');
      ctrl.updateExtractPreview('C:\\Users\\test');

      const preview = document.getElementById('extract-preview-path') as HTMLElement;
      expect(preview.textContent).toContain('\\');
      expect(preview.textContent).toContain('archive');
    });

    it('handles forward slashes in Windows context', () => {
      deps.isWindowsPlatform.mockReturnValue(true);
      document.body.innerHTML = `
        <div id="extract-modal" style="display:none">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('C:/Users/test/data.7z');
      ctrl.updateExtractPreview('C:/Users/test');

      const preview = document.getElementById('extract-preview-path') as HTMLElement;
      expect(preview.textContent).toContain('data');
    });
  });

  describe('handleExtract progress handler', () => {
    it('registers and cleans up extract progress handler', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const cleanup = vi.fn();
      api.onExtractProgress.mockReturnValue(cleanup);
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(api.onExtractProgress).toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
    });

    it('extract progress handler updates operation', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onExtractProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });
      api.extractArchive.mockImplementation(async () => {
        capturedHandler({
          operationId: 'op-1',
          current: 3,
          total: 10,
          name: 'file.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.updateOperation).toHaveBeenCalledWith('op-1', 3, 10, 'file.txt');
    });

    it('extract progress handler ignores different operationIds', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onExtractProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });
      api.extractArchive.mockImplementation(async () => {
        capturedHandler({
          operationId: 'other-op',
          current: 1,
          total: 5,
          name: 'a.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.updateOperation).not.toHaveBeenCalled();
    });

    it('extract progress handler skips update when aborted', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      let callCount = 0;
      deps.getOperation.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { aborted: false };
        return { aborted: true };
      });
      let capturedHandler: (...args: any[]) => any = () => {};
      api.onExtractProgress.mockImplementation((handler: (...args: any[]) => any) => {
        capturedHandler = handler;
        return vi.fn();
      });
      api.extractArchive.mockImplementation(async () => {
        capturedHandler({
          operationId: 'op-1',
          current: 1,
          total: 5,
          name: 'a.txt',
        });
        return { success: true };
      });

      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/archive.zip');
      await ctrl.confirmExtractModal();

      expect(deps.updateOperation).not.toHaveBeenCalled();
    });
  });

  describe('getArchiveBaseName (tested indirectly through extract)', () => {
    it('strips .tar.gz from archive name in extract path', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/backup.tar.gz');
      await ctrl.confirmExtractModal();

      expect(api.extractArchive).toHaveBeenCalledWith(
        '/home/user/backup.tar.gz',
        expect.stringContaining('backup'),
        'op-1'
      );

      const destPath = api.extractArchive.mock.calls[0][1] as string;
      expect(destPath).not.toContain('.tar.gz');
    });

    it('strips .zip from archive name in extract path', async () => {
      document.body.innerHTML = `
        <div id="extract-modal" style="display:flex">
          <span id="extract-modal-message"></span>
          <input id="extract-destination-input" type="text" value="/home/user" />
          <span id="extract-preview-path"></span>
        </div>
      `;
      const ctrl = createCompressExtractController(deps as any);
      ctrl.showExtractModal('/home/user/data.zip');
      await ctrl.confirmExtractModal();

      const destPath = api.extractArchive.mock.calls[0][1] as string;
      expect(destPath).not.toContain('.zip');
      expect(destPath).toContain('data');
    });
  });
});
