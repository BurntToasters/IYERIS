import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockQuicklookController = vi.hoisted(() => ({
  initQuicklookUi: vi.fn(),
  showQuickLook: vi.fn(),
  showQuickLookForFile: vi.fn(),
  closeQuickLook: vi.fn(),
  isQuickLookOpen: vi.fn(() => false),
}));

const mockCreateQuicklookController = vi.hoisted(() => vi.fn(() => mockQuicklookController));

const mockCreatePdfViewer = vi.hoisted(() => vi.fn());
const mockLoadPdfJs = vi.hoisted(() => vi.fn());
const mockLoadHighlightJs = vi.hoisted(() => vi.fn());
const mockGetLanguageForExt = vi.hoisted(() => vi.fn(() => null));

vi.mock('./rendererQuicklook.js', () => ({
  createQuicklookController: mockCreateQuicklookController,
}));

vi.mock('./rendererPdfViewer.js', () => ({
  createPdfViewer: mockCreatePdfViewer,
  loadPdfJs: mockLoadPdfJs,
}));

vi.mock('./rendererHighlight.js', () => ({
  loadHighlightJs: mockLoadHighlightJs,
  getLanguageForExt: mockGetLanguageForExt,
}));

vi.mock('./shared.js', () => ({
  escapeHtml: vi.fn((s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')),
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

vi.mock('./rendererDom.js', () => ({
  getById: vi.fn((id: string) => document.getElementById(id)),
}));

vi.mock('./rendererUtils.js', () => ({
  encodeFileUrl: vi.fn((p: string) => `file://${p}`),
  twemojiImg: vi.fn((_code: string, _cls: string) => '<img class="twemoji" />'),
}));

vi.mock('./fileTypes.js', () => ({
  IMAGE_EXTENSIONS: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico']),
  RAW_EXTENSIONS: new Set(['cr2', 'nef', 'arw', 'dng']),
  TEXT_EXTENSIONS: new Set(['txt', 'md', 'json', 'js', 'ts', 'html', 'css', 'xml', 'yml', 'yaml']),
  VIDEO_EXTENSIONS: new Set(['mp4', 'webm', 'mkv', 'avi', 'mov']),
  AUDIO_EXTENSIONS: new Set(['mp3', 'wav', 'ogg', 'flac', 'aac']),
  PDF_EXTENSIONS: new Set(['pdf']),
  ARCHIVE_EXTENSIONS: new Set(['zip', 'tar', 'gz', '7z', 'rar']),
}));

import { createPreviewController } from './rendererPreviews';
import type { FileItem } from './types';

function createDeps() {
  return {
    getSelectedItems: vi.fn(() => new Set<string>()),
    getFileByPath: vi.fn((_path: string): FileItem | undefined => undefined),
    getCurrentSettings: vi.fn(() => ({
      maxPreviewSizeMB: 50,
      enableSyntaxHighlighting: true,
      autoPlayVideos: false,
    })),
    formatFileSize: vi.fn((size: number) => `${size} B`),
    getFileExtension: vi.fn((name: string) => {
      const dot = name.lastIndexOf('.');
      return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    }),
    getFileIcon: vi.fn(() => '<span class="file-icon">📄</span>'),
    openFileEntry: vi.fn(),
    onModalOpen: vi.fn(),
    onModalClose: vi.fn(),
  };
}

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    name: 'test.txt',
    path: '/home/user/test.txt',
    isDirectory: false,
    isFile: true,
    size: 1024,
    modified: new Date('2024-06-15T12:00:00Z'),
    isHidden: false,
    ...overrides,
  };
}

function buildDOM() {
  document.body.innerHTML = `
    <div id="preview-panel" style="display:none">
      <div id="preview-content"></div>
      <button id="preview-toggle-btn"></button>
      <button id="preview-close"></button>
    </div>
  `;
}

let mockElectronAPI: any;

describe('rendererPreviews', () => {
  beforeEach(() => {
    buildDOM();
    mockElectronAPI = {
      getItemProperties: vi.fn().mockResolvedValue({
        success: true,
        properties: {
          name: 'test.txt',
          path: '/home/user/test.txt',
          size: 1024,
          created: '2024-01-01T00:00:00Z',
          modified: '2024-06-15T12:00:00Z',
          accessed: '2024-06-15T12:01:00Z',
          isFile: true,
          isDirectory: false,
        },
      }),
      readFileContent: vi.fn().mockResolvedValue({
        success: true,
        content: 'Hello, world!',
        isTruncated: false,
      }),
      openFile: vi.fn(),
      listArchiveContents: vi.fn().mockResolvedValue({
        success: true,
        entries: [
          { name: 'file1.txt', isDirectory: false, size: 100 },
          { name: 'dir/', isDirectory: true, size: 0 },
        ],
      }),
    };
    (window as any).electronAPI = mockElectronAPI;

    mockCreateQuicklookController.mockClear();
    mockCreateQuicklookController.mockReturnValue(mockQuicklookController);
    mockQuicklookController.initQuicklookUi.mockClear();
    mockQuicklookController.showQuickLook.mockClear();
    mockQuicklookController.showQuickLookForFile.mockClear();
    mockQuicklookController.closeQuickLook.mockClear();
    mockQuicklookController.isQuickLookOpen.mockClear();
    mockCreatePdfViewer.mockReset();
    mockLoadHighlightJs.mockReset();
    mockGetLanguageForExt.mockReset();
    mockGetLanguageForExt.mockReturnValue(null);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  describe('createPreviewController', () => {
    it('creates a controller with all expected methods', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      expect(ctrl).toBeDefined();
      expect(typeof ctrl.initPreviewUi).toBe('function');
      expect(typeof ctrl.updatePreview).toBe('function');
      expect(typeof ctrl.showEmptyPreview).toBe('function');
      expect(typeof ctrl.clearPreview).toBe('function');
      expect(typeof ctrl.togglePreviewPanel).toBe('function');
      expect(typeof ctrl.isPreviewVisible).toBe('function');
      expect(typeof ctrl.showQuickLook).toBe('function');
      expect(typeof ctrl.showQuickLookForFile).toBe('function');
      expect(typeof ctrl.closeQuickLook).toBe('function');
      expect(typeof ctrl.isQuickLookOpen).toBe('function');
    });

    it('calls createQuicklookController with deps', () => {
      const deps = createDeps();
      createPreviewController(deps as any);
      expect(mockCreateQuicklookController).toHaveBeenCalledWith(deps);
    });
  });

  describe('initPreviewUi', () => {
    it('attaches click handler to toggle button', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.initPreviewUi();

      const toggleBtn = document.getElementById('preview-toggle-btn')!;
      expect(toggleBtn).toBeDefined();

      toggleBtn.click();
      expect(ctrl.isPreviewVisible()).toBe(true);
    });

    it('attaches click handler to close button', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.initPreviewUi();

      ctrl.togglePreviewPanel();
      expect(ctrl.isPreviewVisible()).toBe(true);

      const closeBtn = document.getElementById('preview-close')!;
      closeBtn.click();
      expect(ctrl.isPreviewVisible()).toBe(false);
    });

    it('initializes quicklook UI', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.initPreviewUi();
      expect(mockQuicklookController.initQuicklookUi).toHaveBeenCalled();
    });

    it('syncs toggle state on init', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.initPreviewUi();

      const toggleBtn = document.getElementById('preview-toggle-btn')!;
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');

      const panel = document.getElementById('preview-panel')!;
      expect(panel.getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('showEmptyPreview', () => {
    it('renders the empty preview placeholder', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.showEmptyPreview();

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('preview-empty');
      expect(content.innerHTML).toContain('Select a file to preview');
      expect(content.innerHTML).toContain('Press Space for quick look');
    });
  });

  describe('clearPreview', () => {
    it('clears to empty preview', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);

      const content = document.getElementById('preview-content')!;
      content.innerHTML = '<div>something</div>';

      ctrl.clearPreview();
      expect(content.innerHTML).toContain('preview-empty');
    });
  });

  describe('togglePreviewPanel', () => {
    it('shows the panel when hidden', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);

      expect(ctrl.isPreviewVisible()).toBe(false);
      ctrl.togglePreviewPanel();
      expect(ctrl.isPreviewVisible()).toBe(true);

      const panel = document.getElementById('preview-panel')!;
      expect(panel.style.display).toBe('flex');
    });

    it('hides the panel when visible', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);

      ctrl.togglePreviewPanel();
      ctrl.togglePreviewPanel();
      expect(ctrl.isPreviewVisible()).toBe(false);

      const panel = document.getElementById('preview-panel')!;
      expect(panel.style.display).toBe('none');
    });

    it('updates aria attributes on toggle', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);

      ctrl.togglePreviewPanel();
      const toggleBtn = document.getElementById('preview-toggle-btn')!;
      const panel = document.getElementById('preview-panel')!;
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
      expect(panel.getAttribute('aria-hidden')).toBe('false');

      ctrl.togglePreviewPanel();
      expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
      expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
      expect(panel.getAttribute('aria-hidden')).toBe('true');
    });

    it('triggers updatePreview for single selected file when showing', () => {
      const deps = createDeps();
      const file = makeFile();
      deps.getSelectedItems.mockReturnValue(new Set([file.path]));
      deps.getFileByPath.mockReturnValue(file);
      const ctrl = createPreviewController(deps as any);

      ctrl.togglePreviewPanel();

      expect(deps.getFileByPath).toHaveBeenCalledWith(file.path);
    });

    it('does not trigger updatePreview when no selection', () => {
      const deps = createDeps();
      deps.getSelectedItems.mockReturnValue(new Set());
      const ctrl = createPreviewController(deps as any);

      ctrl.togglePreviewPanel();
      expect(deps.getFileByPath).not.toHaveBeenCalled();
    });

    it('does not trigger updatePreview for directory', () => {
      const deps = createDeps();
      const dir = makeFile({ name: 'folder', isDirectory: true, isFile: false });
      deps.getSelectedItems.mockReturnValue(new Set([dir.path]));
      deps.getFileByPath.mockReturnValue(dir);
      const ctrl = createPreviewController(deps as any);

      ctrl.togglePreviewPanel();

      expect(mockElectronAPI.readFileContent).not.toHaveBeenCalled();
    });

    it('does nothing if preview panel element is missing', () => {
      document.body.innerHTML = '';
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);

      ctrl.togglePreviewPanel();
      expect(ctrl.isPreviewVisible()).toBe(false);
    });
  });

  describe('isPreviewVisible', () => {
    it('returns false initially', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      expect(ctrl.isPreviewVisible()).toBe(false);
    });

    it('returns true after toggle', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.togglePreviewPanel();
      expect(ctrl.isPreviewVisible()).toBe(true);
    });
  });

  describe('updatePreview', () => {
    it('shows empty preview for directory', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const dir = makeFile({ name: 'mydir', isDirectory: true, isFile: false });
      ctrl.updatePreview(dir);

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('preview-empty');
    });

    it('shows empty preview for null-ish file', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.updatePreview(null as any);

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('preview-empty');
    });

    it('routes image files to image preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'photo.jpg', path: '/home/user/photo.jpg', size: 100 });
      ctrl.updatePreview(file);

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('Loading image...');

      await vi.waitFor(() => {
        expect(content.innerHTML).toContain('preview-image');
      });
    });

    it('routes text files to text preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'notes.txt', path: '/home/user/notes.txt' });
      ctrl.updatePreview(file);

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('Loading text...');

      await vi.waitFor(() => {
        expect(content.innerHTML).toContain('Hello, world!');
      });
    });

    it('routes video files to video preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'clip.mp4', path: '/home/user/clip.mp4', size: 1000 });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-video');
        expect(content.innerHTML).toContain('<video');
      });
    });

    it('routes audio files to audio preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'song.mp3', path: '/home/user/song.mp3' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-audio');
        expect(content.innerHTML).toContain('<audio');
      });
    });

    it('routes archive files to archive preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'archive.zip', path: '/home/user/archive.zip' });
      ctrl.updatePreview(file);

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('Loading archive contents...');

      await vi.waitFor(() => {
        expect(content.innerHTML).toContain('Archive Contents');
        expect(content.innerHTML).toContain('file1.txt');
      });
    });

    it('routes raw image files to raw image preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'photo.cr2', path: '/home/user/photo.cr2' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('RAW Image');
        expect(content.innerHTML).toContain('Canon');
      });
    });

    it('routes unknown file type to file info preview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'data.xyz', path: '/home/user/data.xyz' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-unsupported');
        expect(content.innerHTML).toContain('Preview not available for this file type');
      });
    });

    it('shows error for exceptions during routing', () => {
      const deps = createDeps();
      deps.getFileExtension.mockImplementation(() => {
        throw new Error('Extension error');
      });
      const ctrl = createPreviewController(deps as any);
      const file = makeFile();
      ctrl.updatePreview(file);

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('preview-error');
      expect(content.innerHTML).toContain('Extension error');
    });
  });

  describe('image preview', () => {
    it('shows file too large error for oversized images', async () => {
      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({ maxPreviewSizeMB: 1 } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'big.jpg',
        path: '/home/user/big.jpg',
        size: 2 * 1024 * 1024,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('File too large to preview');
      });
    });

    it('renders image tag with correct src and alt', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'pic.png', path: '/home/user/pic.png', size: 500 });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('file:///home/user/pic.png');
        expect(content.innerHTML).toContain('alt="pic.png"');
      });
    });
  });

  describe('text preview', () => {
    it('renders text content from readFileContent', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'readme.md', path: '/home/user/readme.md' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('Hello, world!');
        expect(content.innerHTML).toContain('preview-text');
      });
    });

    it('shows truncation notice for truncated content', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: 'Partial content...',
        isTruncated: true,
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'big.ts', path: '/home/user/big.ts' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-truncated');
        expect(content.innerHTML).toContain('50KB');
      });
    });

    it('shows error when readFileContent fails', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: false,
        error: 'Permission denied',
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'secret.txt', path: '/home/user/secret.txt' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-error');
        expect(content.innerHTML).toContain('Permission denied');
      });
    });

    it('applies syntax highlighting when language is detected and enabled', async () => {
      const mockHl = { highlightElement: vi.fn() };
      mockLoadHighlightJs.mockResolvedValue(mockHl);
      mockGetLanguageForExt.mockReturnValue('javascript' as any);

      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({
        maxPreviewSizeMB: 50,
        enableSyntaxHighlighting: true,
      } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'app.js', path: '/home/user/app.js' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('language-javascript');
      });

      await vi.waitFor(() => {
        expect(mockLoadHighlightJs).toHaveBeenCalled();
      });
    });

    it('does not apply highlighting when disabled in settings', async () => {
      mockGetLanguageForExt.mockReturnValue('javascript' as any);

      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({
        maxPreviewSizeMB: 50,
        enableSyntaxHighlighting: false,
      } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'app.js', path: '/home/user/app.js' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('language-javascript');
      });

      expect(mockLoadHighlightJs).not.toHaveBeenCalled();
    });
  });

  describe('video preview', () => {
    it('shows too large error for oversized videos', async () => {
      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({ maxPreviewSizeMB: 10 } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'movie.mp4',
        path: '/home/user/movie.mp4',
        size: 20 * 1024 * 1024,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('Video file too large to preview');
      });
    });

    it('renders video with autoplay when setting enabled', async () => {
      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({
        maxPreviewSizeMB: 50,
        autoPlayVideos: true,
      } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'clip.webm',
        path: '/home/user/clip.webm',
        size: 1000,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('autoplay');
      });
    });

    it('renders video without autoplay when setting disabled', async () => {
      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({
        maxPreviewSizeMB: 50,
        autoPlayVideos: false,
      } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'clip.mp4',
        path: '/home/user/clip.mp4',
        size: 1000,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).not.toContain('autoplay');
      });
    });
  });

  describe('audio preview', () => {
    it('renders audio player with controls', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'track.wav', path: '/home/user/track.wav' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('<audio');
        expect(content.innerHTML).toContain('controls');
        expect(content.innerHTML).toContain('preview-audio-container');
      });
    });
  });

  describe('archive preview', () => {
    it('displays file and folder counts', async () => {
      mockElectronAPI.listArchiveContents.mockResolvedValue({
        success: true,
        entries: [
          { name: 'a.txt', isDirectory: false, size: 100 },
          { name: 'b.txt', isDirectory: false, size: 200 },
          { name: 'subdir/', isDirectory: true, size: 0 },
        ],
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'data.zip', path: '/home/user/data.zip' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('2 files');
        expect(content.innerHTML).toContain('1 folder');
      });
    });

    it('shows singular for single file and folder', async () => {
      mockElectronAPI.listArchiveContents.mockResolvedValue({
        success: true,
        entries: [{ name: 'only.txt', isDirectory: false, size: 50 }],
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'single.zip', path: '/home/user/single.zip' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('1 file,');
        expect(content.innerHTML).toContain('0 folders');
      });
    });

    it('shows truncation message for many entries', async () => {
      const entries = Array.from({ length: 120 }, (_, i) => ({
        name: `file${i}.txt`,
        isDirectory: false,
        size: 10,
      }));
      mockElectronAPI.listArchiveContents.mockResolvedValue({
        success: true,
        entries,
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'big.tar', path: '/home/user/big.tar' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('and 20 more');
      });
    });

    it('shows error when archive listing fails', async () => {
      mockElectronAPI.listArchiveContents.mockResolvedValue({
        success: false,
        error: 'Corrupt archive',
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'bad.zip', path: '/home/user/bad.zip' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-error');
        expect(content.innerHTML).toContain('Corrupt archive');
      });
    });

    it('shows error when listArchiveContents throws', async () => {
      mockElectronAPI.listArchiveContents.mockRejectedValue(new Error('IO failure'));

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'err.zip', path: '/home/user/err.zip' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-error');
        expect(content.innerHTML).toContain('IO failure');
      });
    });
  });

  describe('PDF preview', () => {
    it('shows too large error for oversized PDFs', async () => {
      const deps = createDeps();
      deps.getCurrentSettings.mockReturnValue({ maxPreviewSizeMB: 5 } as any);
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'huge.pdf',
        path: '/home/user/huge.pdf',
        size: 10 * 1024 * 1024,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('PDF file too large to preview');
      });
    });

    it('shows invalid PDF error when header check fails', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: 'NOT-A-PDF',
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'fake.pdf',
        path: '/home/user/fake.pdf',
        size: 1000,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('does not appear to be a valid PDF');
      });
    });

    it('renders PDF viewer on success', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: '%PDF-1.4 dummy',
      });

      const mockViewerElement = document.createElement('div');
      mockViewerElement.className = 'pdf-viewer';
      const mockViewer = {
        element: mockViewerElement,
        destroy: vi.fn(),
        goToPage: vi.fn(),
        getCurrentPage: vi.fn(() => 1),
        getPageCount: vi.fn(() => 5),
      };
      mockCreatePdfViewer.mockResolvedValue(mockViewer);

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'doc.pdf',
        path: '/home/user/doc.pdf',
        size: 1000,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-pdf-container');
        expect(content.innerHTML).toContain('Open in Default App');
      });
    });

    it('shows fallback when createPdfViewer throws', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: '%PDF-1.4 data',
      });
      mockCreatePdfViewer.mockRejectedValue(new Error('PDF render fail'));

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'broken.pdf',
        path: '/home/user/broken.pdf',
        size: 500,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('Failed to render PDF');
        expect(content.innerHTML).toContain('Open in Default App');
      });
    });

    it('fallback open button calls electronAPI.openFile', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: '%PDF-1.4 data',
      });
      mockCreatePdfViewer.mockRejectedValue(new Error('fail'));

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'broken.pdf',
        path: '/home/user/broken.pdf',
        size: 500,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        const btn = content.querySelector('.preview-pdf-open-btn') as HTMLButtonElement;
        expect(btn).toBeTruthy();
        btn.click();
        expect(mockElectronAPI.openFile).toHaveBeenCalledWith('/home/user/broken.pdf');
      });
    });
  });

  describe('raw image preview', () => {
    it('shows RAW image info with brand for NEF', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'photo.nef', path: '/home/user/photo.nef' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('NEF RAW Image');
        expect(content.innerHTML).toContain('Nikon');
      });
    });

    it('shows Camera for unknown RAW extension', async () => {
      const deps = createDeps();

      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'photo.dng', path: '/home/user/photo.dng' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('DNG RAW Image');
        expect(content.innerHTML).toContain('Adobe DNG');
      });
    });

    it('shows note about RAW preview not available', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'shot.arw', path: '/home/user/shot.arw' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('RAW preview not available');
      });
    });
  });

  describe('file info preview (unknown type)', () => {
    it('shows file icon and name', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'mystery.abc', path: '/home/user/mystery.abc' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('mystery.abc');
        expect(content.innerHTML).toContain('preview-unsupported');
      });
      expect(deps.getFileIcon).toHaveBeenCalledWith('mystery.abc');
    });

    it('includes file info section with size and path', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'data.bin',
        path: '/home/user/data.bin',
        size: 2048,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-info');
        expect(content.innerHTML).toContain('/home/user/data.bin');
      });
    });
  });

  describe('quicklook delegation', () => {
    it('delegates showQuickLook to quicklook controller', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.showQuickLook();
      expect(mockQuicklookController.showQuickLook).toHaveBeenCalled();
    });

    it('delegates showQuickLookForFile to quicklook controller', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile();
      ctrl.showQuickLookForFile(file);
      expect(mockQuicklookController.showQuickLookForFile).toHaveBeenCalledWith(file);
    });

    it('delegates closeQuickLook to quicklook controller', () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      ctrl.closeQuickLook();
      expect(mockQuicklookController.closeQuickLook).toHaveBeenCalled();
    });

    it('delegates isQuickLookOpen to quicklook controller', () => {
      mockQuicklookController.isQuickLookOpen.mockReturnValue(true);
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      expect(ctrl.isQuickLookOpen()).toBe(true);
    });
  });

  describe('request ID staleness', () => {
    it('stale requests do not update content after clearPreview', async () => {
      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);

      const file = makeFile({ name: 'slow.txt', path: '/home/user/slow.txt' });
      ctrl.updatePreview(file);

      ctrl.clearPreview();

      await new Promise((r) => setTimeout(r, 50));

      const content = document.getElementById('preview-content')!;
      expect(content.innerHTML).toContain('preview-empty');
      expect(content.innerHTML).not.toContain('Hello, world!');
    });
  });

  describe('generateFileInfo', () => {
    it('includes created date when properties have it', async () => {
      mockElectronAPI.getItemProperties.mockResolvedValue({
        success: true,
        properties: {
          name: 'test.xyz',
          path: '/home/user/test.xyz',
          size: 512,
          created: '2024-01-01T00:00:00Z',
          modified: '2024-06-15T12:00:00Z',
          accessed: '2024-06-15T13:00:00Z',
          isFile: true,
          isDirectory: false,
        },
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'test.xyz', path: '/home/user/test.xyz' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('Created');
        expect(content.innerHTML).toContain('Modified');
        expect(content.innerHTML).toContain('Accessed');
      });
    });

    it('omits created/accessed when properties lack them', async () => {
      mockElectronAPI.getItemProperties.mockResolvedValue({
        success: true,
        properties: {
          name: 'test.xyz',
          path: '/home/user/test.xyz',
          size: 512,
          modified: '2024-06-15T12:00:00Z',
          isFile: true,
          isDirectory: false,
        },
      });

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'nodate.xyz', path: '/home/user/nodate.xyz' });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('Modified');
        expect(content.innerHTML).not.toContain('Created');
        expect(content.innerHTML).not.toContain('Accessed');
      });
    });
  });

  describe('PDF open button in successful render', () => {
    it('open button calls electronAPI.openFile', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: '%PDF-1.4 data',
      });

      const mockViewerElement = document.createElement('div');
      const mockViewer = {
        element: mockViewerElement,
        destroy: vi.fn(),
        goToPage: vi.fn(),
        getCurrentPage: vi.fn(() => 1),
        getPageCount: vi.fn(() => 1),
      };
      mockCreatePdfViewer.mockResolvedValue(mockViewer);

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({
        name: 'doc.pdf',
        path: '/home/user/doc.pdf',
        size: 100,
      });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        const btn = content.querySelector('.preview-pdf-open-btn') as HTMLButtonElement;
        expect(btn).toBeTruthy();
        btn.click();
        expect(mockElectronAPI.openFile).toHaveBeenCalledWith('/home/user/doc.pdf');
      });
    });
  });

  describe('clearPreview with active PDF viewer', () => {
    it('destroys active PDF viewer on clear', async () => {
      mockElectronAPI.readFileContent.mockResolvedValue({
        success: true,
        content: '%PDF-1.4 data',
      });

      const mockViewerElement = document.createElement('div');
      const mockViewer = {
        element: mockViewerElement,
        destroy: vi.fn(),
        goToPage: vi.fn(),
        getCurrentPage: vi.fn(() => 1),
        getPageCount: vi.fn(() => 1),
      };
      mockCreatePdfViewer.mockResolvedValue(mockViewer);

      const deps = createDeps();
      const ctrl = createPreviewController(deps as any);
      const file = makeFile({ name: 'v.pdf', path: '/home/user/v.pdf', size: 100 });
      ctrl.updatePreview(file);

      await vi.waitFor(() => {
        const content = document.getElementById('preview-content')!;
        expect(content.innerHTML).toContain('preview-pdf-container');
      });

      ctrl.clearPreview();
      expect(mockViewer.destroy).toHaveBeenCalled();
    });
  });
});
