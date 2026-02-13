import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockCreatePdfViewer = vi.hoisted(() => vi.fn());
const mockLoadHighlightJs = vi.hoisted(() => vi.fn());
const mockGetLanguageForExt = vi.hoisted(() => vi.fn());
const mockEscapeHtml = vi.hoisted(() => vi.fn((t: string) => t));
const mockGetById = vi.hoisted(() => vi.fn());
const mockEncodeFileUrl = vi.hoisted(() => vi.fn((p: string) => `file://${p}`));
const mockTwemojiImg = vi.hoisted(() => vi.fn((_e: string, _c: string) => '<img class="twemoji">'));

const mockImageExtensions = vi.hoisted(() => new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']));
const mockTextExtensions = vi.hoisted(() => new Set(['txt', 'md', 'js', 'ts', 'json', 'css']));
const mockVideoExtensions = vi.hoisted(() => new Set(['mp4', 'webm', 'mkv']));
const mockAudioExtensions = vi.hoisted(() => new Set(['mp3', 'wav', 'ogg']));
const mockPdfExtensions = vi.hoisted(() => new Set(['pdf']));
const mockVideoMimeTypes = vi.hoisted(
  () => ({ mp4: 'video/mp4', webm: 'video/webm' }) as Record<string, string>
);
const mockAudioMimeTypes = vi.hoisted(
  () => ({ mp3: 'audio/mpeg', wav: 'audio/wav' }) as Record<string, string>
);

vi.mock('./rendererPdfViewer.js', () => ({
  createPdfViewer: mockCreatePdfViewer,
}));

vi.mock('./rendererHighlight.js', () => ({
  loadHighlightJs: mockLoadHighlightJs,
  getLanguageForExt: mockGetLanguageForExt,
}));

vi.mock('./shared.js', () => ({
  escapeHtml: mockEscapeHtml,
}));

vi.mock('./rendererDom.js', () => ({
  getById: mockGetById,
}));

vi.mock('./rendererUtils.js', () => ({
  encodeFileUrl: mockEncodeFileUrl,
  twemojiImg: mockTwemojiImg,
}));

vi.mock('./fileTypes.js', () => ({
  IMAGE_EXTENSIONS: mockImageExtensions,
  TEXT_EXTENSIONS: mockTextExtensions,
  VIDEO_EXTENSIONS: mockVideoExtensions,
  AUDIO_EXTENSIONS: mockAudioExtensions,
  PDF_EXTENSIONS: mockPdfExtensions,
  VIDEO_MIME_TYPES: mockVideoMimeTypes,
  AUDIO_MIME_TYPES: mockAudioMimeTypes,
}));

import { createQuicklookController, type QuicklookDeps } from './rendererQuicklook';
import type { FileItem, Settings } from './types';

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    name: 'test.txt',
    path: '/home/user/test.txt',
    isDirectory: false,
    isFile: true,
    size: 1024,
    modified: new Date('2025-06-15T12:00:00Z'),
    isHidden: false,
    ...overrides,
  };
}

function createDeps(overrides: Partial<QuicklookDeps> = {}): QuicklookDeps {
  return {
    getSelectedItems: vi.fn().mockReturnValue(new Set<string>()),
    getFileByPath: vi.fn().mockReturnValue(undefined),
    getCurrentSettings: vi.fn().mockReturnValue({
      maxThumbnailSizeMB: 10,
      autoPlayVideos: false,
      enableSyntaxHighlighting: true,
    } as Partial<Settings>),
    formatFileSize: vi.fn((s: number) => `${s} B`),
    getFileExtension: vi.fn((name: string) => {
      const dot = name.lastIndexOf('.');
      return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
    }),
    getFileIcon: vi.fn(() => '<span class="icon">📄</span>'),
    openFileEntry: vi.fn(),
    onModalOpen: vi.fn(),
    onModalClose: vi.fn(),
    ...overrides,
  };
}

function setupDom() {
  const modal = document.createElement('div');
  modal.id = 'quicklook-modal';
  modal.style.display = 'none';

  const content = document.createElement('div');
  content.id = 'quicklook-content';

  const title = document.createElement('div');
  title.id = 'quicklook-title';

  const info = document.createElement('div');
  info.id = 'quicklook-info';

  const closeBtn = document.createElement('button');
  closeBtn.id = 'quicklook-close';

  const openBtn = document.createElement('button');
  openBtn.id = 'quicklook-open';

  document.body.appendChild(modal);
  document.body.appendChild(content);
  document.body.appendChild(title);
  document.body.appendChild(info);
  document.body.appendChild(closeBtn);
  document.body.appendChild(openBtn);

  mockGetById.mockImplementation((id: string) => document.getElementById(id));

  return { modal, content, title, info, closeBtn, openBtn };
}

function cleanupDom() {
  document.body.innerHTML = '';
}

describe('createQuicklookController', () => {
  let deps: QuicklookDeps;
  let dom: ReturnType<typeof setupDom>;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = setupDom();
    deps = createDeps();
    (window as any).electronAPI = {
      readFileContent: vi.fn().mockResolvedValue({ success: true, content: 'hello' }),
      openFile: vi.fn(),
    };
    mockLoadHighlightJs.mockResolvedValue(null);
    mockGetLanguageForExt.mockReturnValue(null);
  });

  afterEach(() => {
    cleanupDom();
    delete (window as any).electronAPI;
  });

  describe('initQuicklookUi', () => {
    it('sets up close button click handler', () => {
      const ctrl = createQuicklookController(deps as any);
      ctrl.initQuicklookUi();

      dom.modal.style.display = 'flex';
      dom.closeBtn.click();
      expect(dom.modal.style.display).toBe('none');
    });

    it('sets up modal backdrop click to close', async () => {
      const ctrl = createQuicklookController(deps as any);
      ctrl.initQuicklookUi();

      const file = makeFile();
      await ctrl.showQuickLookForFile(file);
      expect(dom.modal.style.display).toBe('flex');

      dom.modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dom.modal.style.display).toBe('none');
    });

    it('does not close when clicking inside modal content', async () => {
      const ctrl = createQuicklookController(deps as any);
      ctrl.initQuicklookUi();

      const file = makeFile();
      await ctrl.showQuickLookForFile(file);
      expect(dom.modal.style.display).toBe('flex');

      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: dom.content });
      dom.modal.dispatchEvent(event);

      expect(dom.modal.style.display).toBe('flex');
    });

    it('sets up open button to open file and close quicklook', async () => {
      const ctrl = createQuicklookController(deps as any);
      ctrl.initQuicklookUi();

      const file = makeFile();
      await ctrl.showQuickLookForFile(file);

      dom.openBtn.click();
      expect(deps.openFileEntry).toHaveBeenCalledWith(file);
      expect(dom.modal.style.display).toBe('none');
    });

    it('open button does nothing when no file is selected', () => {
      const ctrl = createQuicklookController(deps as any);
      ctrl.initQuicklookUi();

      dom.openBtn.click();
      expect(deps.openFileEntry).not.toHaveBeenCalled();
    });

    it('does not throw when elements are missing', () => {
      mockGetById.mockReturnValue(null);
      const ctrl = createQuicklookController(deps as any);
      expect(() => ctrl.initQuicklookUi()).not.toThrow();
    });
  });

  describe('isQuickLookOpen', () => {
    it('returns false when modal is hidden', () => {
      const ctrl = createQuicklookController(deps as any);
      expect(ctrl.isQuickLookOpen()).toBe(false);
    });

    it('returns true when modal is displayed', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await ctrl.showQuickLookForFile(file);
      expect(ctrl.isQuickLookOpen()).toBe(true);
    });

    it('returns false after closeQuickLook', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await ctrl.showQuickLookForFile(file);
      ctrl.closeQuickLook();
      expect(ctrl.isQuickLookOpen()).toBe(false);
    });

    it('returns false when modal element is missing', () => {
      mockGetById.mockReturnValue(null);
      const ctrl = createQuicklookController(deps as any);
      expect(ctrl.isQuickLookOpen()).toBe(false);
    });
  });

  describe('closeQuickLook', () => {
    it('hides the modal and calls onModalClose', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await ctrl.showQuickLookForFile(file);

      ctrl.closeQuickLook();
      expect(dom.modal.style.display).toBe('none');
      expect(deps.onModalClose).toHaveBeenCalledWith(dom.modal);
    });

    it('destroys pdf viewer if present', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await ctrl.showQuickLookForFile(file);

      const mockDestroy = vi.fn();
      (dom.modal as any).__pdfViewer = { destroy: mockDestroy };

      ctrl.closeQuickLook();
      expect(mockDestroy).toHaveBeenCalled();
      expect((dom.modal as any).__pdfViewer).toBeNull();
    });

    it('does not throw when elements are missing', () => {
      mockGetById.mockReturnValue(null);
      const ctrl = createQuicklookController(deps as any);
      expect(() => ctrl.closeQuickLook()).not.toThrow();
    });
  });

  describe('showQuickLook', () => {
    it('does nothing when no items are selected', async () => {
      const ctrl = createQuicklookController(deps as any);
      (deps.getSelectedItems as ReturnType<typeof vi.fn>).mockReturnValue(new Set());
      await ctrl.showQuickLook();
      expect(dom.modal.style.display).toBe('none');
    });

    it('does nothing when multiple items are selected', async () => {
      const ctrl = createQuicklookController(deps as any);
      (deps.getSelectedItems as ReturnType<typeof vi.fn>).mockReturnValue(new Set(['/a', '/b']));
      await ctrl.showQuickLook();
      expect(dom.modal.style.display).toBe('none');
    });

    it('does nothing when file not found', async () => {
      const ctrl = createQuicklookController(deps as any);
      (deps.getSelectedItems as ReturnType<typeof vi.fn>).mockReturnValue(
        new Set(['/home/user/test.txt'])
      );
      (deps.getFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      await ctrl.showQuickLook();
      expect(dom.modal.style.display).toBe('none');
    });

    it('opens quicklook for a single selected file', async () => {
      const file = makeFile();
      const ctrl = createQuicklookController(deps as any);
      (deps.getSelectedItems as ReturnType<typeof vi.fn>).mockReturnValue(new Set([file.path]));
      (deps.getFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
      await ctrl.showQuickLook();
      expect(dom.modal.style.display).toBe('flex');
    });
  });

  describe('showQuickLookForFile', () => {
    it('does nothing for directories', async () => {
      const ctrl = createQuicklookController(deps as any);
      const dir = makeFile({ name: 'folder', isDirectory: true });
      await ctrl.showQuickLookForFile(dir);
      expect(dom.modal.style.display).toBe('none');
    });

    it('does not throw when elements are missing', async () => {
      mockGetById.mockReturnValue(null);
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await expect(ctrl.showQuickLookForFile(file)).resolves.toBeUndefined();
    });

    it('blurs active element before showing', async () => {
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      btn.focus();
      const blurSpy = vi.spyOn(btn, 'blur');

      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await ctrl.showQuickLookForFile(file);

      expect(blurSpy).toHaveBeenCalled();
    });

    it('calls onModalOpen when showing', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile();
      await ctrl.showQuickLookForFile(file);
      expect(deps.onModalOpen).toHaveBeenCalledWith(dom.modal);
    });

    it('sets the quicklook title to file name', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file = makeFile({ name: 'report.txt' });
      await ctrl.showQuickLookForFile(file);
      expect(dom.title.textContent).toBe('report.txt');
    });

    describe('image preview', () => {
      it('shows image for image extensions', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'photo.png', path: '/home/user/photo.png', size: 5000 });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img');
        expect(img).not.toBeNull();
        expect(img!.alt).toBe('photo.png');
        expect(img!.className).toContain('quicklook-zoomable');
      });

      it('shows error for images exceeding max thumbnail size', async () => {
        (deps.getCurrentSettings as ReturnType<typeof vi.fn>).mockReturnValue({
          maxThumbnailSizeMB: 1,
        });
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({
          name: 'big.png',
          path: '/home/user/big.png',
          size: 2 * 1024 * 1024,
        });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('Image too large to preview');
      });

      it('uses default 10MB limit when maxThumbnailSizeMB is not set', async () => {
        (deps.getCurrentSettings as ReturnType<typeof vi.fn>).mockReturnValue({});
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({
          name: 'medium.jpg',
          path: '/home/user/medium.jpg',
          size: 5 * 1024 * 1024,
        });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img');
        expect(img).not.toBeNull();
      });

      it('toggles zoom on image click', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'photo.png', path: '/home/user/photo.png', size: 5000 });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img')!;
        img.click();
        expect(img.classList.contains('zoomed')).toBe(true);
        expect(img.style.cursor).toBe('zoom-out');

        img.click();
        expect(img.classList.contains('zoomed')).toBe(false);
        expect(img.style.cursor).toBe('zoom-in');
      });

      it('updates info with dimensions on image load', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'photo.png', path: '/home/user/photo.png', size: 5000 });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img')!;
        Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
        Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
        img.dispatchEvent(new Event('load'));

        expect(dom.info.textContent).toContain('800 × 600');
      });

      it('shows error when image fails to load', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'broken.png', path: '/home/user/broken.png', size: 100 });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img')!;
        img.dispatchEvent(new Event('error'));

        expect(dom.content.innerHTML).toContain('Failed to load image');
      });

      it('ignores load event if quicklook was closed/changed', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'photo.png', path: '/home/user/photo.png', size: 5000 });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img')!;

        const file2 = makeFile({ name: 'other.png', path: '/home/user/other.png', size: 200 });
        await ctrl.showQuickLookForFile(file2);

        Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
        Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
        img.dispatchEvent(new Event('load'));
      });

      it('ignores error event if quicklook was closed/changed', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'photo.png', path: '/home/user/photo.png', size: 5000 });
        await ctrl.showQuickLookForFile(file);

        const img = dom.content.querySelector('img')!;

        ctrl.closeQuickLook();

        img.dispatchEvent(new Event('error'));

        expect(dom.content.innerHTML).not.toContain('Failed to load image');
      });
    });

    describe('video preview', () => {
      it('shows video element for video extensions', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'clip.mp4', path: '/home/user/clip.mp4' });
        await ctrl.showQuickLookForFile(file);

        const video = dom.content.querySelector('video');
        expect(video).not.toBeNull();
        expect(video!.controls).toBe(true);
        expect(video!.className).toContain('preview-video');

        const source = video!.querySelector('source');
        expect(source).not.toBeNull();
        expect(source!.type).toBe('video/mp4');
      });

      it('respects autoPlayVideos setting', async () => {
        (deps.getCurrentSettings as ReturnType<typeof vi.fn>).mockReturnValue({
          autoPlayVideos: true,
        });
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'clip.webm', path: '/home/user/clip.webm' });
        await ctrl.showQuickLookForFile(file);

        const video = dom.content.querySelector('video')!;
        expect(video.autoplay).toBe(true);
      });

      it('uses wildcard mime type for unknown video extension', async () => {
        const ctrl = createQuicklookController(deps as any);
        mockVideoExtensions.add('avi');
        const file = makeFile({ name: 'clip.avi', path: '/home/user/clip.avi' });
        await ctrl.showQuickLookForFile(file);

        const source = dom.content.querySelector('source')!;
        expect(source.type).toBe('video/*');
        mockVideoExtensions.delete('avi');
      });

      it('sets quicklook info text', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'clip.mp4', path: '/home/user/clip.mp4' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.info.textContent).toBeTruthy();
      });
    });

    describe('audio preview', () => {
      it('shows audio element for audio extensions', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'song.mp3', path: '/home/user/song.mp3' });
        await ctrl.showQuickLookForFile(file);

        const audio = dom.content.querySelector('audio');
        expect(audio).not.toBeNull();
        expect(audio!.controls).toBe(true);
        expect(audio!.className).toContain('preview-audio');

        const source = audio!.querySelector('source');
        expect(source).not.toBeNull();
        expect(source!.type).toBe('audio/mpeg');
      });

      it('creates audio container with icon', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'song.mp3', path: '/home/user/song.mp3' });
        await ctrl.showQuickLookForFile(file);

        const container = dom.content.querySelector('.preview-audio-container');
        expect(container).not.toBeNull();
        const icon = dom.content.querySelector('.preview-audio-icon');
        expect(icon).not.toBeNull();
      });

      it('respects autoPlayVideos setting for audio', async () => {
        (deps.getCurrentSettings as ReturnType<typeof vi.fn>).mockReturnValue({
          autoPlayVideos: true,
        });
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'song.wav', path: '/home/user/song.wav' });
        await ctrl.showQuickLookForFile(file);

        const audio = dom.content.querySelector('audio')!;
        expect(audio.autoplay).toBe(true);
      });

      it('uses wildcard mime type for unknown audio extension', async () => {
        const ctrl = createQuicklookController(deps as any);
        mockAudioExtensions.add('flac');
        const file = makeFile({ name: 'song.flac', path: '/home/user/song.flac' });
        await ctrl.showQuickLookForFile(file);

        const source = dom.content.querySelector('source')!;
        expect(source.type).toBe('audio/*');
        mockAudioExtensions.delete('flac');
      });
    });

    describe('PDF preview', () => {
      it('reads file header to validate PDF', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: true, content: '%PDF-1.4 header' });

        const mockViewer = {
          element: document.createElement('div'),
          destroy: vi.fn(),
          goToPage: vi.fn(),
          getPageCount: vi.fn(),
          getCurrentPage: vi.fn(),
          zoomIn: vi.fn(),
          zoomOut: vi.fn(),
          resetZoom: vi.fn(),
          getZoom: vi.fn(),
        };
        mockCreatePdfViewer.mockResolvedValue(mockViewer);

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'doc.pdf', path: '/home/user/doc.pdf' });
        await ctrl.showQuickLookForFile(file);

        expect((window as any).electronAPI.readFileContent).toHaveBeenCalledWith(file.path, 16);
        expect(mockCreatePdfViewer).toHaveBeenCalled();
      });

      it('shows error when file is not a valid PDF', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: true, content: 'not-a-pdf' });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'fake.pdf', path: '/home/user/fake.pdf' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('does not appear to be a valid PDF');
        expect(mockCreatePdfViewer).not.toHaveBeenCalled();
      });

      it('shows error when readFileContent fails for PDF', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: false, error: 'read error' });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'doc.pdf', path: '/home/user/doc.pdf' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('does not appear to be a valid PDF');
      });

      it('shows error when createPdfViewer throws', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: true, content: '%PDF-1.4' });
        mockCreatePdfViewer.mockRejectedValue(new Error('PDF render failed'));

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'doc.pdf', path: '/home/user/doc.pdf' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('Failed to render PDF');
      });

      it('sets PDF info text with prefix', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: true, content: '%PDF-1.4' });

        const mockViewer = {
          element: document.createElement('div'),
          destroy: vi.fn(),
          goToPage: vi.fn(),
          getPageCount: vi.fn(),
          getCurrentPage: vi.fn(),
          zoomIn: vi.fn(),
          zoomOut: vi.fn(),
          resetZoom: vi.fn(),
          getZoom: vi.fn(),
        };
        mockCreatePdfViewer.mockResolvedValue(mockViewer);

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'doc.pdf', path: '/home/user/doc.pdf' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.info.textContent).toContain('PDF');
      });

      it('stores pdf viewer on modal element for cleanup', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: true, content: '%PDF-1.4' });

        const mockViewer = {
          element: document.createElement('div'),
          destroy: vi.fn(),
          goToPage: vi.fn(),
          getPageCount: vi.fn(),
          getCurrentPage: vi.fn(),
          zoomIn: vi.fn(),
          zoomOut: vi.fn(),
          resetZoom: vi.fn(),
          getZoom: vi.fn(),
        };
        mockCreatePdfViewer.mockResolvedValue(mockViewer);

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'doc.pdf', path: '/home/user/doc.pdf' });
        await ctrl.showQuickLookForFile(file);

        expect((dom.modal as any).__pdfViewer).toBe(mockViewer);
      });

      it('destroys viewer if quicklook changed during PDF load', async () => {
        (window as any).electronAPI.readFileContent = vi
          .fn()
          .mockResolvedValue({ success: true, content: '%PDF-1.4' });

        const mockViewer = {
          element: document.createElement('div'),
          destroy: vi.fn(),
          goToPage: vi.fn(),
          getPageCount: vi.fn(),
          getCurrentPage: vi.fn(),
          zoomIn: vi.fn(),
          zoomOut: vi.fn(),
          resetZoom: vi.fn(),
          getZoom: vi.fn(),
        };

        let resolveCreatePdf: (value: any) => void;
        const createPdfPromise = new Promise((res) => {
          resolveCreatePdf = res;
        });
        mockCreatePdfViewer.mockReturnValue(createPdfPromise);

        const ctrl = createQuicklookController(deps as any);
        const file1 = makeFile({ name: 'doc1.pdf', path: '/home/user/doc1.pdf' });
        const showPromise = ctrl.showQuickLookForFile(file1);

        await new Promise((r) => setTimeout(r, 0));

        const file2 = makeFile({ name: 'other.bin', path: '/home/user/other.bin' });
        await ctrl.showQuickLookForFile(file2);

        resolveCreatePdf!(mockViewer);
        await showPromise;

        expect(mockViewer.destroy).toHaveBeenCalled();
      });

      it('aborts if quicklook changed during header read', async () => {
        let resolveRead: (value: any) => void;
        const readPromise = new Promise((res) => {
          resolveRead = res;
        });
        (window as any).electronAPI.readFileContent = vi.fn().mockReturnValue(readPromise);

        const ctrl = createQuicklookController(deps as any);
        const file1 = makeFile({ name: 'doc1.pdf', path: '/home/user/doc1.pdf' });
        const showPromise = ctrl.showQuickLookForFile(file1);

        const file2 = makeFile({ name: 'other.bin', path: '/home/user/other.bin' });
        await ctrl.showQuickLookForFile(file2);

        resolveRead!({ success: true, content: '%PDF-1.4' });
        await showPromise;

        expect(mockCreatePdfViewer).not.toHaveBeenCalled();
      });
    });

    describe('text preview', () => {
      it('shows text content with pre/code block', async () => {
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'const x = 1;',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'script.js', path: '/home/user/script.js' });
        await ctrl.showQuickLookForFile(file);

        expect((window as any).electronAPI.readFileContent).toHaveBeenCalledWith(
          file.path,
          100 * 1024
        );
        expect(dom.content.querySelector('pre')).not.toBeNull();
        expect(dom.content.querySelector('code')).not.toBeNull();
      });

      it('shows truncation warning when file is truncated', async () => {
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'truncated content',
          isTruncated: true,
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'big.txt', path: '/home/user/big.txt' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('preview-truncated');
        expect(dom.content.innerHTML).toContain('100KB');
      });

      it('does not show truncation warning when not truncated', async () => {
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'short content',
          isTruncated: false,
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'small.txt', path: '/home/user/small.txt' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).not.toContain('preview-truncated');
      });

      it('shows error when readFileContent fails', async () => {
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: false,
          error: 'Access denied',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'locked.txt', path: '/home/user/locked.txt' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('Failed to load text');
      });

      it('applies syntax highlighting when language is detected and setting is on', async () => {
        const mockHighlightElement = vi.fn();
        mockLoadHighlightJs.mockResolvedValue({ highlightElement: mockHighlightElement });
        mockGetLanguageForExt.mockReturnValue('javascript');
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'const x = 1;',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'app.js', path: '/home/user/app.js' });
        await ctrl.showQuickLookForFile(file);

        await vi.waitFor(() => {
          expect(mockHighlightElement).toHaveBeenCalled();
        });
      });

      it('does not apply syntax highlighting when setting is off', async () => {
        mockGetLanguageForExt.mockReturnValue('javascript');
        (deps.getCurrentSettings as ReturnType<typeof vi.fn>).mockReturnValue({
          enableSyntaxHighlighting: false,
        });
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'const x = 1;',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'app.js', path: '/home/user/app.js' });
        await ctrl.showQuickLookForFile(file);

        expect(mockLoadHighlightJs).not.toHaveBeenCalled();
      });

      it('does not apply syntax highlighting when language is null', async () => {
        mockGetLanguageForExt.mockReturnValue(null);
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'plain text',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'notes.txt', path: '/home/user/notes.txt' });
        await ctrl.showQuickLookForFile(file);

        expect(mockLoadHighlightJs).not.toHaveBeenCalled();
      });

      it('sets language class on code block when language detected', async () => {
        mockGetLanguageForExt.mockReturnValue('typescript');
        (deps.getCurrentSettings as ReturnType<typeof vi.fn>).mockReturnValue({
          enableSyntaxHighlighting: false,
        });
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'const x: number = 1;',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'app.ts', path: '/home/user/app.ts' });
        await ctrl.showQuickLookForFile(file);

        const code = dom.content.querySelector('code');
        expect(code!.className).toContain('language-typescript');
      });

      it('handles loadHighlightJs returning null gracefully', async () => {
        mockLoadHighlightJs.mockResolvedValue(null);
        mockGetLanguageForExt.mockReturnValue('javascript');
        (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
          success: true,
          content: 'const x = 1;',
        });

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'app.js', path: '/home/user/app.js' });
        await ctrl.showQuickLookForFile(file);

        await new Promise((r) => setTimeout(r, 10));
      });

      it('aborts text preview if quicklook changed during read', async () => {
        let resolveRead: (value: any) => void;
        const readPromise = new Promise((res) => {
          resolveRead = res;
        });
        (window as any).electronAPI.readFileContent = vi.fn().mockReturnValue(readPromise);

        const ctrl = createQuicklookController(deps as any);
        const file1 = makeFile({ name: 'first.txt', path: '/home/user/first.txt' });
        const showPromise = ctrl.showQuickLookForFile(file1);

        const file2 = makeFile({ name: 'second.png', path: '/home/user/second.png', size: 100 });
        await ctrl.showQuickLookForFile(file2);

        resolveRead!({ success: true, content: 'old content' });
        await showPromise;

        expect(dom.content.innerHTML).not.toContain('old content');
      });
    });

    describe('unsupported file types', () => {
      it('shows preview-not-available message for unknown extensions', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'data.xyz', path: '/home/user/data.xyz' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('Preview not available');
        expect(dom.content.innerHTML).toContain('preview-unsupported');
        expect(deps.getFileIcon).toHaveBeenCalledWith(file.name);
      });

      it('shows file icon for unsupported types', async () => {
        (deps.getFileIcon as ReturnType<typeof vi.fn>).mockReturnValue('<span>🗂️</span>');
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'data.bin', path: '/home/user/data.bin' });
        await ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('<span>🗂️</span>');
      });

      it('sets quicklook info text', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'data.bin', path: '/home/user/data.bin', size: 2048 });
        await ctrl.showQuickLookForFile(file);

        expect(dom.info.textContent).toContain('2048 B');
      });
    });

    describe('quickInfo helper', () => {
      it('includes formatted size and date', async () => {
        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({
          name: 'unknown.xyz',
          size: 4096,
          modified: new Date('2025-01-15T00:00:00Z'),
        });
        await ctrl.showQuickLookForFile(file);

        expect(deps.formatFileSize).toHaveBeenCalledWith(4096);
        expect(dom.info.textContent).toContain('4096 B');
        expect(dom.info.textContent).toContain('\u2022');
      });
    });

    describe('loading indicator', () => {
      it('shows loading html before content is ready', async () => {
        let resolveRead: (value: any) => void;
        const readPromise = new Promise((res) => {
          resolveRead = res;
        });
        (window as any).electronAPI.readFileContent = vi.fn().mockReturnValue(readPromise);

        const ctrl = createQuicklookController(deps as any);
        const file = makeFile({ name: 'doc.md', path: '/home/user/doc.md' });
        const showPromise = ctrl.showQuickLookForFile(file);

        expect(dom.content.innerHTML).toContain('Loading');
        expect(dom.content.innerHTML).toContain('spinner');

        resolveRead!({ success: true, content: '# Hello' });
        await showPromise;
      });
    });
  });

  describe('state management across operations', () => {
    it('opening and closing multiple times works correctly', async () => {
      const ctrl = createQuicklookController(deps as any);
      const file1 = makeFile({ name: 'a.txt', path: '/a.txt' });
      const file2 = makeFile({ name: 'b.txt', path: '/b.txt' });

      await ctrl.showQuickLookForFile(file1);
      expect(ctrl.isQuickLookOpen()).toBe(true);

      ctrl.closeQuickLook();
      expect(ctrl.isQuickLookOpen()).toBe(false);

      await ctrl.showQuickLookForFile(file2);
      expect(ctrl.isQuickLookOpen()).toBe(true);
      expect(dom.title.textContent).toBe('b.txt');

      ctrl.closeQuickLook();
      expect(ctrl.isQuickLookOpen()).toBe(false);
    });

    it('switching between different file types updates content', async () => {
      const ctrl = createQuicklookController(deps as any);

      const imgFile = makeFile({ name: 'photo.jpg', path: '/photo.jpg', size: 500 });
      await ctrl.showQuickLookForFile(imgFile);
      expect(dom.content.querySelector('img')).not.toBeNull();

      (window as any).electronAPI.readFileContent = vi.fn().mockResolvedValue({
        success: true,
        content: 'hello',
      });
      const txtFile = makeFile({ name: 'readme.md', path: '/readme.md' });
      await ctrl.showQuickLookForFile(txtFile);
      expect(dom.content.querySelector('pre')).not.toBeNull();
      expect(dom.content.querySelector('img')).toBeNull();

      const binFile = makeFile({ name: 'data.bin', path: '/data.bin' });
      await ctrl.showQuickLookForFile(binFile);
      expect(dom.content.innerHTML).toContain('Preview not available');
    });
  });
});
