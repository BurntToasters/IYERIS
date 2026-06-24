// @vitest-environment jsdom
/**
 * Regression tests for the file preview panel.
 * M5: updatePreview and clearPreview must pause and clear src on any playing
 *     <video> or <audio> element before swapping in new content.  Previously
 *     only the explicit panel-close path stopped media; selecting a new file
 *     while audio/video was playing left it playing in the background.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const mockQuicklookController = vi.hoisted(() => ({
  initQuicklookUi: vi.fn(),
  showQuickLook: vi.fn(),
  showQuickLookForFile: vi.fn(),
  closeQuickLook: vi.fn(),
  isQuickLookOpen: vi.fn(() => false),
}));
const mockCreateQuicklookController = vi.hoisted(() => vi.fn(() => mockQuicklookController));
const mockCreatePdfViewer = vi.hoisted(() => vi.fn());
const mockLoadHighlightJs = vi.hoisted(() => vi.fn());
const mockGetLanguageForExt = vi.hoisted(() => vi.fn(() => null));
const mockGetFileDataUrlWithCache = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockLoadMarked = vi.hoisted(() => vi.fn());

vi.mock('../rendererQuicklook.js', () => ({
  createQuicklookController: mockCreateQuicklookController,
}));
vi.mock('../rendererPdfViewer.js', () => ({
  createPdfViewer: mockCreatePdfViewer,
  loadPdfJs: vi.fn(),
}));
vi.mock('../rendererHighlight.js', () => ({
  loadHighlightJs: mockLoadHighlightJs,
  getLanguageForExt: mockGetLanguageForExt,
}));
vi.mock('../shared.js', () => ({
  escapeHtml: (s: string) => s,
  getErrorMessage: (e: unknown) => String(e),
  ignoreError: () => {},
  sanitizeMarkdownHtml: (html: string) => html,
}));
vi.mock('../rendererDom.js', () => ({
  getById: vi.fn((id: string) => document.getElementById(id)),
}));
vi.mock('../rendererUtils.js', () => ({
  encodeFileUrl: (p: string) => `file://${p}`,
  getFileDataUrlWithCache: mockGetFileDataUrlWithCache,
  twemojiImg: () => '<img />',
}));
vi.mock('../rendererMarkdown.js', () => ({ loadMarked: mockLoadMarked }));

import { createPreviewController } from '../rendererPreviews';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="preview-panel" style="display:none">
      <div id="preview-content"></div>
      <button id="preview-toggle-btn" aria-pressed="false" aria-expanded="false"
              aria-controls="preview-panel"></button>
      <button id="preview-close-btn"></button>
      <div id="preview-filename"></div>
      <div id="preview-filesize"></div>
      <div id="preview-metadata"></div>
      <div id="preview-properties"></div>
      <div id="quicklook-modal" style="display:none">
        <button id="quicklook-close"></button>
        <div id="quicklook-content"></div>
        <div id="quicklook-filename"></div>
        <div id="quicklook-filesize"></div>
      </div>
    </div>
  `;
}

function createDeps() {
  return {
    getSelectedItems: () => new Set<string>(),
    getFileByPath: vi.fn((_p: string) => undefined),
    getFileExtension: (name: string) => name.split('.').pop() ?? '',
    formatFileSize: (n: number) => `${n} B`,
    getCurrentSettings: () => ({ maxPreviewSizeMB: 50, autoPlayVideos: false }) as never,
    getFileIcon: vi.fn(() => '<span>icon</span>'),
    openFile: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn(),
    showToast: vi.fn(),
  };
}

/** Creates a fake HTMLMediaElement with a jest-spied pause method. */
function makeMediaElement(tag: 'video' | 'audio'): HTMLMediaElement {
  const el = document.createElement(tag) as HTMLMediaElement;
  // jsdom does not implement pause(); spy on it.
  vi.spyOn(el, 'pause').mockImplementation(() => {});
  el.setAttribute('src', 'http://example.com/media.mp4');
  return el;
}

describe('rendererPreviews — M5 media pause before content swap', () => {
  beforeEach(() => {
    buildDom();
    vi.clearAllMocks();
    window.tauriAPI = {
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
      readFileContent: vi.fn().mockResolvedValue({ success: false }),
      getFileDataUrl: vi.fn().mockResolvedValue({ success: false }),
    } as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updatePreview pauses any playing video before rendering new content', () => {
    const ctrl = createPreviewController(createDeps() as never);
    ctrl.initPreviewUi();

    const previewContent = document.getElementById('preview-content')!;

    // Inject a playing video element into the preview pane.
    const video = makeMediaElement('video');
    previewContent.appendChild(video);
    expect(video.pause).not.toHaveBeenCalled();

    // Switching to a new image file should pause the existing video first.
    ctrl.updatePreview({
      name: 'photo.png',
      path: '/images/photo.png',
      size: 1024,
      isFile: true,
      isDirectory: false,
    } as never);

    expect(video.pause).toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();
  });

  it('updatePreview pauses any playing audio before rendering new content', () => {
    const ctrl = createPreviewController(createDeps() as never);
    ctrl.initPreviewUi();

    const previewContent = document.getElementById('preview-content')!;
    const audio = makeMediaElement('audio');
    previewContent.appendChild(audio);

    ctrl.updatePreview({
      name: 'song.mp3',
      path: '/music/song.mp3',
      size: 4096,
      isFile: true,
      isDirectory: false,
    } as never);

    expect(audio.pause).toHaveBeenCalled();
    expect(audio.getAttribute('src')).toBeNull();
  });

  it('clearPreview pauses any playing media', () => {
    const ctrl = createPreviewController(createDeps() as never);
    ctrl.initPreviewUi();

    const previewContent = document.getElementById('preview-content')!;
    const video = makeMediaElement('video');
    const audio = makeMediaElement('audio');
    previewContent.appendChild(video);
    previewContent.appendChild(audio);

    ctrl.clearPreview();

    expect(video.pause).toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.getAttribute('src')).toBeNull();
  });

  it('updatePreview does not throw when previewContent has no media elements', () => {
    const ctrl = createPreviewController(createDeps() as never);
    ctrl.initPreviewUi();
    // Use an unsupported extension so no async tauriAPI calls are made.
    expect(() =>
      ctrl.updatePreview({
        name: 'doc.unknown_ext_xyz',
        path: '/doc.unknown_ext_xyz',
        size: 10,
        isFile: true,
        isDirectory: false,
      } as never)
    ).not.toThrow();
  });
});
