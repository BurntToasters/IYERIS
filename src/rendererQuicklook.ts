import type { FileItem, Settings } from './types';
import { escapeHtml } from './shared.js';
import { getById } from './rendererDom.js';
import { encodeFileUrl, twemojiImg } from './rendererUtils.js';
import { createPdfViewer, type PdfViewerHandle } from './rendererPdfViewer.js';
import { loadHighlightJs, getLanguageForExt } from './rendererHighlight.js';
import {
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  TEXT_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
  VIDEO_MIME_TYPES,
  AUDIO_MIME_TYPES,
} from './fileTypes.js';

import { loadMarked } from './rendererMarkdown.js';

interface PdfViewerElement extends HTMLElement {
  __pdfViewer?: PdfViewerHandle | null;
}

export type QuicklookDeps = {
  getSelectedItems: () => Set<string>;
  getFileByPath: (path: string) => FileItem | undefined;
  getCurrentSettings: () => Settings;
  formatFileSize: (size: number) => string;
  getFileExtension: (name: string) => string;
  getFileIcon: (name: string) => string;
  openFileEntry: (file: FileItem) => void;
  onModalOpen?: (modal: HTMLElement) => void;
  onModalClose?: (modal: HTMLElement) => void;
};

export function createQuicklookController(deps: QuicklookDeps) {
  let currentQuicklookFile: FileItem | null = null;
  let quicklookRequestId = 0;

  let quicklookModal: HTMLElement | null = null;
  let quicklookContent: HTMLElement | null = null;
  let quicklookTitle: HTMLElement | null = null;
  let quicklookInfo: HTMLElement | null = null;
  let quicklookClose: HTMLButtonElement | null = null;
  let quicklookOpen: HTMLButtonElement | null = null;

  const ensureElements = () => {
    if (!quicklookModal) quicklookModal = getById('quicklook-modal');
    if (!quicklookContent) quicklookContent = getById('quicklook-content');
    if (!quicklookTitle) quicklookTitle = getById('quicklook-title');
    if (!quicklookInfo) quicklookInfo = getById('quicklook-info');
    if (!quicklookClose) quicklookClose = getById('quicklook-close') as HTMLButtonElement;
    if (!quicklookOpen) quicklookOpen = getById('quicklook-open') as HTMLButtonElement;
  };

  const quickInfo = (file: FileItem, prefix = '') =>
    `${prefix}${deps.formatFileSize(file.size)} \u2022 ${new Date(file.modified).toLocaleDateString()}`;

  const loadingHtml = (label: string) =>
    `<div class="preview-loading"><div class="spinner"></div><p>Loading ${label}...</p></div>`;

  async function showQuickLookForFile(file: FileItem) {
    ensureElements();
    if (!quicklookModal || !quicklookTitle || !quicklookContent || !quicklookInfo) return;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    if (file.isDirectory) return;

    const requestId = ++quicklookRequestId;
    currentQuicklookFile = file;
    quicklookTitle.textContent = file.name;
    quicklookModal.style.display = 'flex';
    deps.onModalOpen?.(quicklookModal);

    const ext = deps.getFileExtension(file.name);

    quicklookContent.innerHTML = loadingHtml('preview');

    if (IMAGE_EXTENSIONS.has(ext)) {
      const settings = deps.getCurrentSettings();
      if (file.size > (settings.maxThumbnailSizeMB || 10) * 1024 * 1024) {
        quicklookContent.innerHTML = `<div class="preview-error">Image too large to preview</div>`;
        quicklookInfo.textContent = quickInfo(file);
      } else {
        const fileUrl = encodeFileUrl(file.path);
        quicklookContent.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'quicklook-image-wrapper';

        const img = document.createElement('img');
        img.src = fileUrl;
        img.alt = file.name;
        img.className = 'quicklook-zoomable';

        let isZoomed = false;
        img.addEventListener('click', () => {
          isZoomed = !isZoomed;
          img.classList.toggle('zoomed', isZoomed);
          if (isZoomed) {
            img.style.maxHeight = 'none';
            img.style.cursor = 'zoom-out';
          } else {
            img.style.maxHeight = '';
            img.style.cursor = 'zoom-in';
          }
        });

        img.addEventListener('load', () => {
          if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) return;
          const dims =
            img.naturalWidth && img.naturalHeight
              ? `${img.naturalWidth} × ${img.naturalHeight} • `
              : '';
          quicklookInfo!.textContent = quickInfo(file, dims);
        });
        img.addEventListener('error', () => {
          if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) {
            return;
          }
          quicklookContent!.innerHTML = `<div class="preview-error">Failed to load image</div>`;
        });
        wrapper.appendChild(img);
        quicklookContent.appendChild(wrapper);
        quicklookInfo.textContent = quickInfo(file);
      }
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      const fileUrl = encodeFileUrl(file.path);
      quicklookContent.innerHTML = '';
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = deps.getCurrentSettings().autoPlayVideos || false;
      video.className = 'preview-video';
      const source = document.createElement('source');
      source.src = fileUrl;
      source.type = VIDEO_MIME_TYPES[ext] || 'video/*';
      video.appendChild(source);
      video.appendChild(document.createTextNode('Your browser does not support the video tag.'));
      quicklookContent.appendChild(video);
      quicklookInfo.textContent = quickInfo(file);
    } else if (AUDIO_EXTENSIONS.has(ext)) {
      const fileUrl = encodeFileUrl(file.path);
      quicklookContent.innerHTML = '';
      const container = document.createElement('div');
      container.className = 'preview-audio-container';
      const icon = document.createElement('div');
      icon.className = 'preview-audio-icon';
      icon.innerHTML = twemojiImg(String.fromCodePoint(0x1f3b5), 'twemoji-large');
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.autoplay = deps.getCurrentSettings().autoPlayVideos || false;
      audio.className = 'preview-audio';
      const source = document.createElement('source');
      source.src = fileUrl;
      source.type = AUDIO_MIME_TYPES[ext] || 'audio/*';
      audio.appendChild(source);
      audio.appendChild(document.createTextNode('Your browser does not support the audio tag.'));
      container.appendChild(icon);
      container.appendChild(audio);
      quicklookContent.appendChild(container);
      quicklookInfo.textContent = quickInfo(file);
    } else if (PDF_EXTENSIONS.has(ext)) {
      const headerResult = await window.electronAPI.readFileContent(file.path, 16);
      if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) return;
      if (
        !headerResult.success ||
        typeof headerResult.content !== 'string' ||
        !headerResult.content.startsWith('%PDF-')
      ) {
        quicklookContent.innerHTML = `<div class="preview-error">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File does not appear to be a valid PDF</div>`;
        quicklookInfo.textContent = quickInfo(file);
        return;
      }

      const fileUrl = encodeFileUrl(file.path);
      quicklookContent.innerHTML = '';

      try {
        const viewer = await createPdfViewer(fileUrl, {
          maxWidth: 900,
          containerClass: 'quicklook-pdf',
          showPageControls: true,
          onError: (msg) => console.error('[QuickLook] PDF error:', msg),
        });

        if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) {
          viewer.destroy();
          return;
        }

        (quicklookModal as PdfViewerElement).__pdfViewer = viewer;

        const container = document.createElement('div');
        container.className = 'preview-pdf-container quicklook-pdf';
        container.appendChild(viewer.element);
        quicklookContent.appendChild(container);
      } catch {
        if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) return;
        quicklookContent.innerHTML = `<div class="preview-error">Failed to render PDF</div>`;
      }
      quicklookInfo.textContent = quickInfo(file, 'PDF \u2022 ');
    } else if (MARKDOWN_EXTENSIONS.has(ext)) {
      const result = await window.electronAPI.readFileContent(file.path, 100 * 1024);
      if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) return;
      if (result.success && typeof result.content === 'string') {
        const md = await loadMarked();
        if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) return;
        if (md) {
          const rendered = md.marked.parse(result.content, {
            async: false,
            breaks: true,
          }) as string;
          quicklookContent.innerHTML = `
          ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 100KB</div>` : ''}
          <div class="preview-markdown">${rendered}</div>
        `;
        } else {
          quicklookContent.innerHTML = `
          ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 100KB</div>` : ''}
          <pre class="preview-text"><code>${escapeHtml(result.content)}</code></pre>
        `;
        }
        quicklookInfo.textContent = quickInfo(file);
      } else {
        quicklookContent.innerHTML = `<div class="preview-error">Failed to load markdown</div>`;
      }
    } else if (TEXT_EXTENSIONS.has(ext)) {
      const result = await window.electronAPI.readFileContent(file.path, 100 * 1024);
      if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) {
        return;
      }
      if (result.success && typeof result.content === 'string') {
        const lang = getLanguageForExt(ext);
        quicklookContent.innerHTML = `
        ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 100KB</div>` : ''}
        <pre class="preview-text"><code class="${lang ? `language-${lang}` : ''}">${escapeHtml(result.content)}</code></pre>
      `;
        quicklookInfo.textContent = quickInfo(file);
        const settings = deps.getCurrentSettings();
        if (lang && settings.enableSyntaxHighlighting) {
          loadHighlightJs().then((hl) => {
            if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path || !hl)
              return;
            const codeBlock = quicklookContent?.querySelector('code');
            if (codeBlock) hl.highlightElement?.(codeBlock);
          });
        }
      } else {
        quicklookContent.innerHTML = `<div class="preview-error">Failed to load text</div>`;
      }
    } else {
      quicklookContent.innerHTML = `
      <div class="preview-unsupported">
        <div class="preview-unsupported-icon">${deps.getFileIcon(file.name)}</div>
        <p>Preview not available for this file type</p>
      </div>
    `;
      quicklookInfo.textContent = quickInfo(file);
    }
  }

  async function showQuickLook() {
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size !== 1) return;
    const selectedPath = Array.from(selectedItems)[0];
    const file = deps.getFileByPath(selectedPath);
    if (!file) return;
    await showQuickLookForFile(file);
  }

  function closeQuickLook() {
    ensureElements();
    if (quicklookModal && (quicklookModal as PdfViewerElement).__pdfViewer) {
      (quicklookModal as PdfViewerElement).__pdfViewer!.destroy();
      (quicklookModal as PdfViewerElement).__pdfViewer = null;
    }
    if (quicklookModal) quicklookModal.style.display = 'none';
    if (quicklookModal) {
      deps.onModalClose?.(quicklookModal);
    }
    currentQuicklookFile = null;
    quicklookRequestId++;
  }

  function initQuicklookUi() {
    ensureElements();

    if (quicklookClose) {
      quicklookClose.addEventListener('click', closeQuickLook);
    }

    if (quicklookOpen) {
      quicklookOpen.addEventListener('click', () => {
        if (currentQuicklookFile) {
          const file = currentQuicklookFile;
          closeQuickLook();
          void deps.openFileEntry(file);
        }
      });
    }

    if (quicklookModal) {
      quicklookModal.addEventListener('click', (e) => {
        if (e.target === quicklookModal) {
          closeQuickLook();
        }
      });
    }
  }

  function isQuickLookOpen(): boolean {
    ensureElements();
    return !!quicklookModal && quicklookModal.style.display === 'flex';
  }

  return {
    initQuicklookUi,
    showQuickLook,
    showQuickLookForFile,
    closeQuickLook,
    isQuickLookOpen,
  };
}
