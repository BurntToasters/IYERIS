import type { FileItem, ItemProperties } from './types';
import { escapeHtml, getErrorMessage } from './shared.js';
import { getById } from './rendererDom.js';
import { encodeFileUrl, twemojiImg } from './rendererUtils.js';
import { createPdfViewer, type PdfViewerHandle } from './rendererPdfViewer.js';
import { loadHighlightJs, getLanguageForExt } from './rendererHighlight.js';
import { createQuicklookController, type QuicklookDeps } from './rendererQuicklook.js';
import {
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  TEXT_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
} from './fileTypes.js';

import { loadMarked } from './rendererMarkdown.js';

type PreviewDeps = QuicklookDeps;

export function createPreviewController(deps: PreviewDeps) {
  const quicklook = createQuicklookController(deps);

  let isPreviewPanelVisible = false;
  let previewRequestId = 0;

  let activePdfViewer: PdfViewerHandle | null = null;

  const loadingHtml = (label: string) =>
    `<div class="preview-loading"><div class="spinner"></div><p>Loading ${label}...</p></div>`;

  let previewPanel: HTMLElement | null = null;
  let previewContent: HTMLElement | null = null;
  let previewToggleBtn: HTMLButtonElement | null = null;
  let previewCloseBtn: HTMLButtonElement | null = null;

  const ensureElements = () => {
    if (!previewPanel) previewPanel = getById('preview-panel');
    if (!previewContent) previewContent = getById('preview-content');
    if (!previewToggleBtn) previewToggleBtn = getById('preview-toggle-btn') as HTMLButtonElement;
    if (!previewCloseBtn) previewCloseBtn = getById('preview-close') as HTMLButtonElement;
  };

  function showEmptyPreview() {
    ensureElements();
    if (!previewContent) return;
    previewContent.innerHTML = `
    <div class="preview-empty">
      <div class="preview-empty-icon">${twemojiImg(String.fromCodePoint(0x1f441), 'twemoji-xlarge')}</div>
      <p>Select a file to preview</p>
      <small>Press Space for quick look</small>
    </div>
  `;
  }

  function clearPreview() {
    previewRequestId++;
    if (activePdfViewer) {
      activePdfViewer.destroy();
      activePdfViewer = null;
    }
    showEmptyPreview();
  }

  function syncPreviewToggleState() {
    ensureElements();
    if (previewToggleBtn) {
      previewToggleBtn.setAttribute('aria-pressed', String(isPreviewPanelVisible));
      previewToggleBtn.setAttribute('aria-expanded', String(isPreviewPanelVisible));
      previewToggleBtn.setAttribute('aria-controls', 'preview-panel');
    }
    if (previewPanel) {
      previewPanel.setAttribute('aria-hidden', String(!isPreviewPanelVisible));
    }
  }

  function togglePreviewPanel() {
    ensureElements();
    if (!previewPanel) return;
    isPreviewPanelVisible = !isPreviewPanelVisible;
    if (isPreviewPanelVisible) {
      previewPanel.style.display = 'flex';
      const selectedItems = deps.getSelectedItems();
      if (selectedItems.size === 1) {
        const selectedPath = Array.from(selectedItems)[0];
        const file = deps.getFileByPath(selectedPath);
        if (file && file.isFile) {
          updatePreview(file);
        }
      }
    } else {
      previewPanel.style.display = 'none';
      previewRequestId++;
    }
    syncPreviewToggleState();
  }

  function updatePreview(file: FileItem) {
    const requestId = ++previewRequestId;
    if (!file || file.isDirectory) {
      showEmptyPreview();
      return;
    }

    try {
      const ext = deps.getFileExtension(file.name);

      if (IMAGE_EXTENSIONS.has(ext)) {
        showImagePreview(file, requestId);
      } else if (RAW_EXTENSIONS.has(ext)) {
        showRawImagePreview(file, requestId);
      } else if (MARKDOWN_EXTENSIONS.has(ext)) {
        showMarkdownPreview(file, requestId);
      } else if (TEXT_EXTENSIONS.has(ext)) {
        showTextPreview(file, requestId);
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        showVideoPreview(file, requestId);
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        showAudioPreview(file, requestId);
      } else if (PDF_EXTENSIONS.has(ext)) {
        showPdfPreview(file, requestId);
      } else if (ARCHIVE_EXTENSIONS.has(ext)) {
        showArchivePreview(file, requestId);
      } else {
        showFileInfo(file, requestId);
      }
    } catch (error) {
      ensureElements();
      if (previewContent) {
        previewContent.innerHTML = `<div class="preview-error">Preview failed: ${escapeHtml(getErrorMessage(error))}</div>`;
      }
    }
  }

  async function showArchivePreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    previewContent.innerHTML = loadingHtml('archive contents');

    try {
      const result = await window.electronAPI.listArchiveContents(file.path);
      if (requestId !== previewRequestId) return;

      if (!result.success) {
        previewContent.innerHTML = `
        <div class="preview-error">
          Failed to list archive contents: ${escapeHtml(result.error || 'Operation failed')}
        </div>
        ${generateFileInfo(file, null)}
      `;
        return;
      }

      const entries = result.entries;
      const fileCount = entries.filter((e) => !e.isDirectory).length;
      const folderCount = entries.filter((e) => e.isDirectory).length;
      const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

      let html = `
      <div class="preview-section">
        <h3>Archive Contents</h3>
        <div class="archive-info">
          <p>${fileCount} file${fileCount !== 1 ? 's' : ''}, ${folderCount} folder${folderCount !== 1 ? 's' : ''}</p>
          <p>Total size: ${deps.formatFileSize(totalSize)}</p>
        </div>
        <div class="archive-list">
      `;

      const maxEntries = 100;
      const displayEntries = entries.slice(0, maxEntries);

      for (const entry of displayEntries) {
        const icon = entry.isDirectory ? '📁' : '📄';
        html += `
        <div class="archive-entry">
          <span class="archive-icon">${icon}</span>
          <span class="archive-name">${escapeHtml(entry.name)}</span>
          <span class="archive-size">${entry.isDirectory ? '' : deps.formatFileSize(entry.size)}</span>
        </div>
        `;
      }

      if (entries.length > maxEntries) {
        html += `<p class="archive-more">... and ${entries.length - maxEntries} more</p>`;
      }

      html += `
        </div>
      </div>
      ${generateFileInfo(file, null)}
      `;

      previewContent.innerHTML = html;
    } catch (error) {
      if (requestId !== previewRequestId) return;
      previewContent.innerHTML = `
      <div class="preview-error">
        Failed to list archive contents: ${escapeHtml(getErrorMessage(error))}
      </div>
      ${generateFileInfo(file, null)}
    `;
    }
  }

  async function showImagePreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    previewContent.innerHTML = loadingHtml('image');

    const settings = deps.getCurrentSettings();
    if (file.size > (settings.maxPreviewSizeMB || 50) * 1024 * 1024) {
      if (requestId !== previewRequestId) return;
      previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load image: ${escapeHtml('File too large to preview')}
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;
    const fileUrl = encodeFileUrl(file.path);
    const altText = escapeHtml(file.name);

    previewContent.innerHTML = `
    <div class="preview-image-wrapper">
      <img src="${fileUrl}" class="preview-image" alt="${altText}">
      <div class="preview-image-dimensions" id="preview-image-dimensions"></div>
    </div>
    ${generateFileInfo(file, info)}
  `;

    const img = previewContent.querySelector('.preview-image') as HTMLImageElement | null;
    const dimensionsEl = previewContent.querySelector(
      '#preview-image-dimensions'
    ) as HTMLElement | null;
    if (img) {
      img.addEventListener('load', () => {
        if (requestId !== previewRequestId) return;
        if (dimensionsEl && img.naturalWidth && img.naturalHeight) {
          dimensionsEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
        }
      });
      img.addEventListener('error', () => {
        if (requestId !== previewRequestId) return;
        previewContent!.innerHTML = `
        <div class="preview-error">
          Failed to load image
        </div>
        ${generateFileInfo(file, info)}
      `;
      });
    }
  }

  async function showRawImagePreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;

    const ext = deps.getFileExtension(file.name).toUpperCase() || 'RAW';
    const cameraFormats: Record<string, string> = {
      CR2: 'Canon',
      CR3: 'Canon',
      CRW: 'Canon',
      NEF: 'Nikon',
      NRW: 'Nikon',
      ARW: 'Sony',
      SR2: 'Sony',
      SRF: 'Sony',
      DNG: 'Adobe DNG',
      ORF: 'Olympus',
      RW2: 'Panasonic',
      RW1: 'Leica',
      RWL: 'Leica',
      PEF: 'Pentax',
      SRW: 'Samsung',
      RAF: 'Fujifilm',
      DCR: 'Kodak',
      KDC: 'Kodak',
      ERF: 'Epson',
      MRW: 'Minolta',
      X3F: 'Sigma',
      '3FR': 'Hasselblad',
      IIQ: 'Phase One',
      MEF: 'Mamiya',
      MOS: 'Leaf',
    };
    const brand = cameraFormats[ext] || 'Camera';

    previewContent.innerHTML = `
    <div class="preview-raw-info">
      <div class="preview-raw-icon">${twemojiImg(String.fromCodePoint(0x1f4f7), 'twemoji-xlarge')}</div>
      <div class="preview-raw-details">
        <strong>${ext} RAW Image</strong>
        <p>${brand} RAW format</p>
        <p class="preview-raw-note">RAW preview not available in browser.<br>Use a photo editor to view this file.</p>
      </div>
    </div>
    ${generateFileInfo(file, info)}
  `;
  }

  async function showMarkdownPreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    previewContent.innerHTML = loadingHtml('markdown');

    const result = await window.electronAPI.readFileContent(file.path, 100 * 1024);
    if (requestId !== previewRequestId) return;

    if (!result.success) {
      previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load markdown: ${escapeHtml(result.error || 'Operation failed')}
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;

    const md = await loadMarked();
    if (requestId !== previewRequestId) return;

    if (md) {
      const rendered = md.marked.parse(result.content, { async: false, breaks: true }) as string;
      previewContent.innerHTML = `
      ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 100KB</div>` : ''}
      <div class="preview-markdown">${rendered}</div>
      ${generateFileInfo(file, info)}
    `;
    } else {
      const lang = getLanguageForExt(deps.getFileExtension(file.name));
      previewContent.innerHTML = `
      ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 100KB</div>` : ''}
      <pre class="preview-text"><code class="${lang ? `language-${lang}` : ''}">${escapeHtml(result.content)}</code></pre>
      ${generateFileInfo(file, info)}
    `;
    }
  }

  async function showTextPreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    previewContent.innerHTML = loadingHtml('text');

    const result = await window.electronAPI.readFileContent(file.path, 50 * 1024);
    if (requestId !== previewRequestId) return;

    if (!result.success) {
      previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load text: ${escapeHtml(result.error || 'Operation failed')}
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;
    const ext = deps.getFileExtension(file.name);
    const lang = getLanguageForExt(ext);

    previewContent.innerHTML = `
    ${result.isTruncated ? `<div class="preview-truncated">${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File truncated to first 50KB</div>` : ''}
    <pre class="preview-text"><code class="${lang ? `language-${lang}` : ''}">${escapeHtml(result.content)}</code></pre>
    ${generateFileInfo(file, info)}
  `;

    const settings = deps.getCurrentSettings();
    if (lang && settings.enableSyntaxHighlighting) {
      loadHighlightJs().then((hl) => {
        if (requestId !== previewRequestId || !hl) return;
        const codeBlock = previewContent?.querySelector('code');
        if (codeBlock) hl.highlightElement?.(codeBlock);
      });
    }
  }

  async function showVideoPreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;

    const settings = deps.getCurrentSettings();
    const maxSizeMB = settings.maxPreviewSizeMB || 50;
    if (file.size > maxSizeMB * 1024 * 1024) {
      previewContent.innerHTML = `
      <div class="preview-error">
        Video file too large to preview (>${maxSizeMB}MB)
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;

    const fileUrl = encodeFileUrl(file.path);

    previewContent.innerHTML = `
    <video src="${fileUrl}" class="preview-video" controls controlsList="nodownload" ${settings.autoPlayVideos ? 'autoplay' : ''}>
      Your browser does not support the video tag.
    </video>
    ${generateFileInfo(file, info)}
  `;
  }

  async function showAudioPreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;

    const fileUrl = encodeFileUrl(file.path);

    previewContent.innerHTML = `
    <div class="preview-audio-container">
      <div class="preview-audio-icon">${twemojiImg(String.fromCodePoint(0x1f3b5), 'twemoji-xlarge')}</div>
      <audio src="${fileUrl}" class="preview-audio" controls controlsList="nodownload">
        Your browser does not support the audio tag.
      </audio>
    </div>
    ${generateFileInfo(file, info)}
  `;
  }

  async function showPdfPreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;

    if (activePdfViewer) {
      activePdfViewer.destroy();
      activePdfViewer = null;
    }

    const settings = deps.getCurrentSettings();
    const maxSizeMB = settings.maxPreviewSizeMB || 50;
    if (file.size > maxSizeMB * 1024 * 1024) {
      previewContent.innerHTML = `
      <div class="preview-error">
        ${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} PDF file too large to preview (>${maxSizeMB}MB)
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    const headerResult = await window.electronAPI.readFileContent(file.path, 16);
    if (requestId !== previewRequestId) return;
    if (!headerResult.success || !headerResult.content.startsWith('%PDF-')) {
      previewContent.innerHTML = `
      <div class="preview-error">
        ${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} File does not appear to be a valid PDF
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    previewContent.innerHTML = loadingHtml('PDF');

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;

    const fileUrl = encodeFileUrl(file.path);

    try {
      const viewer = await createPdfViewer(fileUrl, {
        maxWidth: 600,
        containerClass: 'preview-panel-pdf',
        showPageControls: true,
        onError: (msg) => console.error('[Preview] PDF error:', msg),
      });

      if (requestId !== previewRequestId) {
        viewer.destroy();
        return;
      }

      activePdfViewer = viewer;
      previewContent.innerHTML = '';

      const wrapper = document.createElement('div');
      wrapper.className = 'preview-pdf-container';
      wrapper.appendChild(viewer.element);
      previewContent.appendChild(wrapper);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'preview-pdf-actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'preview-pdf-open-btn';
      openBtn.title = 'Open in default application';
      openBtn.innerHTML = `${twemojiImg(String.fromCodePoint(0x1f4c4), 'twemoji-small')} Open in Default App`;
      openBtn.addEventListener('click', () => void window.electronAPI.openFile(file.path));
      actionsDiv.appendChild(openBtn);
      previewContent.appendChild(actionsDiv);

      const infoHtml = generateFileInfo(file, info);
      const infoWrapper = document.createElement('div');
      infoWrapper.innerHTML = infoHtml;
      while (infoWrapper.firstChild) {
        previewContent.appendChild(infoWrapper.firstChild);
      }
    } catch {
      if (requestId !== previewRequestId) return;
      previewContent.innerHTML = `
      <div class="preview-error">
        Failed to render PDF
      </div>
      <div class="preview-pdf-actions">
        <button class="preview-pdf-open-btn" title="Open in default application">
          ${twemojiImg(String.fromCodePoint(0x1f4c4), 'twemoji-small')} Open in Default App
        </button>
      </div>
      ${generateFileInfo(file, info)}
    `;
      const fallbackBtn = previewContent.querySelector(
        '.preview-pdf-open-btn'
      ) as HTMLButtonElement | null;
      if (fallbackBtn) {
        fallbackBtn.addEventListener('click', () => void window.electronAPI.openFile(file.path));
      }
    }
  }

  async function showFileInfo(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success ? props.properties : null;

    previewContent.innerHTML = `
    <div class="preview-unsupported">
      <div class="preview-unsupported-icon">${deps.getFileIcon(file.name)}</div>
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <p>Preview not available for this file type</p>
      </div>
    </div>
    ${generateFileInfo(file, info)}
  `;
  }

  function generateFileInfo(file: FileItem, props: ItemProperties | null): string {
    const size = props ? props.size : file.size;
    const sizeDisplay = deps.formatFileSize(size);
    const modified = props ? new Date(props.modified) : new Date(file.modified);

    return `
    <div class="preview-info">
      <div class="preview-info-item">
        <span class="preview-info-label">Name</span>
        <span class="preview-info-value">${escapeHtml(file.name)}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Type</span>
        <span class="preview-info-value">${file.isDirectory ? 'Folder' : 'File'}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Size</span>
        <span class="preview-info-value">${sizeDisplay}</span>
      </div>
      <div class="preview-info-item">
        <span class="preview-info-label">Location</span>
        <span class="preview-info-value">${escapeHtml(file.path)}</span>
      </div>
      ${
        props && props.created
          ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Created</span>
        <span class="preview-info-value">${new Date(props.created).toLocaleString()}</span>
      </div>`
          : ''
      }
      <div class="preview-info-item">
        <span class="preview-info-label">Modified</span>
        <span class="preview-info-value">${modified.toLocaleDateString()} ${modified.toLocaleTimeString()}</span>
      </div>
      ${
        props && props.accessed
          ? `
      <div class="preview-info-item">
        <span class="preview-info-label">Accessed</span>
        <span class="preview-info-value">${new Date(props.accessed).toLocaleString()}</span>
      </div>`
          : ''
      }
    </div>
  `;
  }

  function initPreviewUi() {
    ensureElements();
    if (previewToggleBtn) {
      previewToggleBtn.addEventListener('click', togglePreviewPanel);
    }

    if (previewCloseBtn) {
      previewCloseBtn.addEventListener('click', () => {
        isPreviewPanelVisible = false;
        if (previewPanel) previewPanel.style.display = 'none';
        previewRequestId++;
        syncPreviewToggleState();
      });
    }

    quicklook.initQuicklookUi();
    syncPreviewToggleState();
  }

  function isPreviewVisible(): boolean {
    return isPreviewPanelVisible;
  }

  return {
    initPreviewUi,
    updatePreview,
    showEmptyPreview,
    clearPreview,
    togglePreviewPanel,
    isPreviewVisible,
    showQuickLook: quicklook.showQuickLook,
    showQuickLookForFile: quicklook.showQuickLookForFile,
    closeQuickLook: quicklook.closeQuickLook,
    isQuickLookOpen: quicklook.isQuickLookOpen,
  };
}
