// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared.js', () => ({
  escapeHtml: vi.fn((s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  ignoreError: () => {},
}));

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: vi.fn((_code: string, _cls: string) => '<img class="twemoji" />'),
}));

import { createPropertiesDialogController } from '../rendererPropertiesDialog';

function makeDeps() {
  return {
    showToast: vi.fn(),
    onModalOpen: vi.fn(),
    onModalClose: vi.fn(),
  };
}

function makeFileProps() {
  return {
    name: 'test.txt',
    path: '/home/user/test.txt',
    size: 1024,
    created: '2024-01-01T00:00:00Z',
    modified: '2024-06-15T12:30:00Z',
    accessed: '2024-06-15T12:31:00Z',
    isFile: true,
    isDirectory: false,
  };
}

function makeDirProps() {
  return {
    name: 'my-folder',
    path: '/home/user/my-folder',
    size: 4096,
    created: '2024-01-01T00:00:00Z',
    modified: '2024-06-15T12:30:00Z',
    accessed: '2024-06-15T12:31:00Z',
    isFile: false,
    isDirectory: true,
  };
}

function buildDOM() {
  document.body.innerHTML = `
    <div id="properties-modal" style="display:none"></div>
    <div id="properties-content"></div>
    <button id="properties-close"></button>
    <button id="properties-ok"></button>
  `;
}

let mockTauriAPI: any;

describe('rendererPropertiesDialog', () => {
  beforeEach(() => {
    buildDOM();
    mockTauriAPI = {
      calculateFolderSize: vi.fn().mockResolvedValue({
        success: true,
        result: {
          totalSize: 2048000,
          fileCount: 42,
          folderCount: 5,
          fileTypes: [
            { extension: '.txt', count: 10, size: 1024000 },
            { extension: '.js', count: 32, size: 1024000 },
          ],
        },
      }),
      cancelFolderSizeCalculation: vi.fn().mockResolvedValue(undefined),
      onFolderSizeProgress: vi.fn(() => vi.fn()),
      calculateChecksum: vi.fn().mockResolvedValue({
        success: true,
        result: {
          md5: 'abc123def456',
          sha256: 'deadbeef0123456789abcdef',
          sha512: 'sha512value',
          blake3: 'blake3value',
          crc32: 'crc32value',
        },
      }),
      cancelChecksumCalculation: vi.fn().mockResolvedValue(undefined),
      onChecksumProgress: vi.fn(() => vi.fn()),
      writeToSystemClipboard: vi.fn().mockResolvedValue(undefined),
    };
    (window as any).tauriAPI = mockTauriAPI;

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as any).tauriAPI;
  });

  describe('showPropertiesDialog - file', () => {
    it('renders file properties and shows modal', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      const modal = document.getElementById('properties-modal')!;
      expect(modal.style.display).toBe('flex');
      expect(deps.onModalOpen).toHaveBeenCalledWith(modal);

      const content = document.getElementById('properties-content')!;
      expect(content.innerHTML).toContain('test.txt');
      expect(content.innerHTML).toContain('File');
      expect(content.innerHTML).toContain('/home/user/test.txt');
      expect(content.innerHTML).toContain('1,024 bytes');
    });

    it('renders checksum section for files', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      expect(document.getElementById('calculate-checksum-btn')).not.toBeNull();
      expect(document.getElementById('checksum-progress-row')).not.toBeNull();
    });

    it('does not render folder size section for files', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      expect(document.getElementById('calculate-folder-size-btn')).toBeNull();
    });

    it('calculates checksums when button clicked', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();

      await vi.waitFor(() => {
        expect(document.getElementById('checksum-md5-value')!.textContent).toBe('abc123def456');
      });
      expect(document.getElementById('checksum-sha256-value')!.textContent).toBe(
        'deadbeef0123456789abcdef'
      );
      expect(document.getElementById('checksum-sha512-value')!.textContent).toBe('sha512value');
      expect(document.getElementById('checksum-blake3-value')!.textContent).toBe('blake3value');
      expect(document.getElementById('checksum-crc32-value')!.textContent).toBe('crc32value');
      expect(document.getElementById('checksum-md5-row')!.style.display).toBe('flex');
      expect(document.getElementById('checksum-sha256-row')!.style.display).toBe('flex');
      expect(document.getElementById('checksum-sha512-row')!.style.display).toBe('flex');
      expect(document.getElementById('checksum-blake3-row')!.style.display).toBe('flex');
      expect(document.getElementById('checksum-crc32-row')!.style.display).toBe('flex');
    });

    it('requests all checksum algorithms', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(mockTauriAPI.calculateChecksum).toHaveBeenCalled();
      });

      expect(mockTauriAPI.calculateChecksum).toHaveBeenCalledWith(
        '/home/user/test.txt',
        expect.stringMatching(/^checksum_/),
        ['md5', 'sha256', 'sha512', 'blake3', 'crc32']
      );
    });

    it('hides calculate button during checksum calculation', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      const btn = document.getElementById('calculate-checksum-btn')!;
      btn.click();

      expect(btn.style.display).toBe('none');
      await vi.waitFor(() => {
        expect(mockTauriAPI.calculateChecksum).toHaveBeenCalled();
      });
    });

    it('shows error toast on checksum failure', async () => {
      mockTauriAPI.calculateChecksum.mockResolvedValue({
        success: false,
        error: 'File locked',
      });
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('File locked', 'Error', 'error');
      });
    });

    it('suppresses toast for cancelled checksum', async () => {
      mockTauriAPI.calculateChecksum.mockResolvedValue({
        success: false,
        error: 'Calculation cancelled',
      });
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(mockTauriAPI.calculateChecksum).toHaveBeenCalled();
      });
      expect(deps.showToast).not.toHaveBeenCalled();
    });

    it('shows error toast on checksum exception', async () => {
      mockTauriAPI.calculateChecksum.mockRejectedValue(new Error('Network error'));
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Network error', 'Error', 'error');
      });
    });

    it('cancels checksum calculation', async () => {
      let resolveChecksum: any;
      mockTauriAPI.calculateChecksum.mockReturnValue(
        new Promise((r) => {
          resolveChecksum = r;
        })
      );

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      document.getElementById('cancel-checksum-btn')!.click();

      expect(mockTauriAPI.cancelChecksumCalculation).toHaveBeenCalled();
      expect(document.getElementById('checksum-progress-row')!.style.display).toBe('none');
      expect(document.getElementById('calculate-checksum-btn')!.style.display).toBe('inline-flex');

      resolveChecksum!({ success: false, error: 'Calculation cancelled' });
    });

    it('copies MD5 to clipboard', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(document.getElementById('checksum-md5-value')!.textContent).toBe('abc123def456');
      });

      document.getElementById('copy-md5-btn')!.click();
      expect(window.tauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('abc123def456');
      expect(deps.showToast).toHaveBeenCalledWith('MD5 copied to clipboard', 'Copied', 'success');
    });

    it('copies SHA-256 to clipboard', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(document.getElementById('checksum-sha256-value')!.textContent).toBeTruthy();
      });

      document.getElementById('copy-sha256-btn')!.click();
      expect(window.tauriAPI.writeToSystemClipboard).toHaveBeenCalledWith(
        'deadbeef0123456789abcdef'
      );
      expect(deps.showToast).toHaveBeenCalledWith(
        'SHA-256 copied to clipboard',
        'Copied',
        'success'
      );
    });

    it('copies SHA-512 to clipboard', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(document.getElementById('checksum-sha512-value')!.textContent).toBe('sha512value');
      });

      document.getElementById('copy-sha512-btn')!.click();
      expect(window.tauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('sha512value');
      expect(deps.showToast).toHaveBeenCalledWith(
        'SHA-512 copied to clipboard',
        'Copied',
        'success'
      );
    });

    it('copies BLAKE3 to clipboard', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(document.getElementById('checksum-blake3-value')!.textContent).toBe('blake3value');
      });

      document.getElementById('copy-blake3-btn')!.click();
      expect(window.tauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('blake3value');
      expect(deps.showToast).toHaveBeenCalledWith(
        'BLAKE3 copied to clipboard',
        'Copied',
        'success'
      );
    });

    it('copies CRC32 to clipboard', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      await vi.waitFor(() => {
        expect(document.getElementById('checksum-crc32-value')!.textContent).toBe('crc32value');
      });

      document.getElementById('copy-crc32-btn')!.click();
      expect(window.tauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('crc32value');
      expect(deps.showToast).toHaveBeenCalledWith('CRC32 copied to clipboard', 'Copied', 'success');
    });
  });

  describe('showPropertiesDialog - directory', () => {
    it('renders folder properties with calculate size section', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      const content = document.getElementById('properties-content')!;
      expect(content.innerHTML).toContain('Folder');
      expect(content.innerHTML).toContain('my-folder');
      expect(document.getElementById('calculate-folder-size-btn')).not.toBeNull();
      expect(document.getElementById('folder-size-info')!.textContent).toBe('Not calculated');
    });

    it('does not render checksum section for directories', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      expect(document.getElementById('calculate-checksum-btn')).toBeNull();
    });

    it('calculates folder size and displays results', async () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      document.getElementById('calculate-folder-size-btn')!.click();

      await vi.waitFor(() => {
        const info = document.getElementById('folder-size-info')!.textContent;
        expect(info).toContain('42 files');
        expect(info).toContain('5 folders');
      });

      expect(document.getElementById('folder-stats-row')!.style.display).toBe('flex');
      const statsContent = document.getElementById('folder-stats-content')!;
      expect(statsContent.innerHTML).toContain('.txt');
      expect(statsContent.innerHTML).toContain('.js');
    });

    it('handles folder size error', async () => {
      mockTauriAPI.calculateFolderSize.mockResolvedValue({
        success: false,
        error: 'Permission denied',
      });

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      document.getElementById('calculate-folder-size-btn')!.click();

      await vi.waitFor(() => {
        expect(document.getElementById('folder-size-info')!.textContent).toContain(
          'Error: Permission denied'
        );
      });
    });

    it('suppresses error message for cancelled calculation', async () => {
      mockTauriAPI.calculateFolderSize.mockResolvedValue({
        success: false,
        error: 'Calculation cancelled',
      });

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      document.getElementById('calculate-folder-size-btn')!.click();

      await vi.waitFor(() => {
        expect(mockTauriAPI.calculateFolderSize).toHaveBeenCalled();
      });

      const info = document.getElementById('folder-size-info')!.textContent;
      expect(info).not.toContain('Error');
    });

    it('handles folder size exception', async () => {
      mockTauriAPI.calculateFolderSize.mockRejectedValue(new Error('Disk failure'));

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      document.getElementById('calculate-folder-size-btn')!.click();

      await vi.waitFor(() => {
        expect(document.getElementById('folder-size-info')!.textContent).toContain(
          'Error: Disk failure'
        );
      });
    });

    it('cancels folder size calculation', async () => {
      let resolveCalc: any;
      mockTauriAPI.calculateFolderSize.mockReturnValue(
        new Promise((r) => {
          resolveCalc = r;
        })
      );

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      document.getElementById('calculate-folder-size-btn')!.click();
      document.getElementById('cancel-folder-size-btn')!.click();

      expect(mockTauriAPI.cancelFolderSizeCalculation).toHaveBeenCalled();
      expect(document.getElementById('folder-size-info')!.textContent).toBe(
        'Calculation cancelled'
      );
      expect(document.getElementById('folder-size-progress-row')!.style.display).toBe('none');
      expect(document.getElementById('calculate-folder-size-btn')!.style.display).toBe(
        'inline-flex'
      );

      resolveCalc!({ success: false, error: 'Calculation cancelled' });
    });

    it('handles folder with no fileTypes in result', async () => {
      mockTauriAPI.calculateFolderSize.mockResolvedValue({
        success: true,
        result: { totalSize: 1024, fileCount: 1, folderCount: 0, fileTypes: [] },
      });

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeDirProps() as any);

      document.getElementById('calculate-folder-size-btn')!.click();

      await vi.waitFor(() => {
        expect(document.getElementById('folder-size-info')!.textContent).toContain('1 files');
      });
      expect(document.getElementById('folder-stats-row')!.style.display).toBe('none');
    });
  });

  describe('close modal', () => {
    it('closes via close button', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('properties-close')!.click();
      expect(document.getElementById('properties-modal')!.style.display).toBe('none');
      expect(deps.onModalClose).toHaveBeenCalled();
    });

    it('closes via OK button', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('properties-ok')!.click();
      expect(document.getElementById('properties-modal')!.style.display).toBe('none');
      expect(deps.onModalClose).toHaveBeenCalled();
    });

    it('closes on backdrop click', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      const modal = document.getElementById('properties-modal')!;
      modal.click();
      expect(modal.style.display).toBe('none');
    });

    it('does not close when clicking inside content', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      const content = document.getElementById('properties-content')!;
      const modal = document.getElementById('properties-modal')!;

      modal.onclick!({ target: content } as any);
      expect(modal.style.display).toBe('flex');
    });
  });

  describe('missing DOM elements', () => {
    it('returns early when modal is missing', () => {
      document.getElementById('properties-modal')!.remove();
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);
      expect(deps.onModalOpen).not.toHaveBeenCalled();
    });

    it('returns early when content is missing', () => {
      document.getElementById('properties-content')!.remove();
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);
      expect(deps.onModalOpen).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('cancels active operations when called', async () => {
      let resolveChecksum: any;
      mockTauriAPI.calculateChecksum.mockReturnValue(
        new Promise((r) => {
          resolveChecksum = r;
        })
      );

      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      document.getElementById('calculate-checksum-btn')!.click();
      ctrl.cleanup();

      expect(mockTauriAPI.cancelChecksumCalculation).toHaveBeenCalled();
      resolveChecksum!({ success: false, error: 'cancelled' });
    });

    it('clears previous active cleanup on second show', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.showPropertiesDialog(makeFileProps() as any);

      ctrl.showPropertiesDialog(makeFileProps() as any);

      expect(deps.onModalOpen).toHaveBeenCalledTimes(2);
    });

    it('is safe to call when nothing is active', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      ctrl.cleanup();
    });
  });

  describe('zero-size formatting', () => {
    it('handles zero-byte file', () => {
      const deps = makeDeps();
      const ctrl = createPropertiesDialogController(deps);
      const props = makeFileProps();
      props.size = 0;
      ctrl.showPropertiesDialog(props as any);

      const content = document.getElementById('properties-content')!;
      expect(content.innerHTML).toContain('0 bytes');
    });
  });
});
