import type { FileItem, ItemProperties, Settings } from './types';
import { escapeHtml, getErrorMessage } from './shared.js';
import { getById } from './rendererDom.js';
import { encodeFileUrl, twemojiImg } from './rendererUtils.js';
import {
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  TEXT_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PDF_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  VIDEO_MIME_TYPES,
  AUDIO_MIME_TYPES,
} from './fileTypes.js';

type PreviewDeps = {
  getSelectedItems: () => Set<string>;
  getFileByPath: (path: string) => FileItem | undefined;
  getCurrentSettings: () => Settings;
  formatFileSize: (size: number) => string;
  getFileExtension: (name: string) => string;
  getFileIcon: (name: string) => string;
  openFileEntry: (file: FileItem) => void;
};

type HighlightJs = {
  highlightElement?: (element: Element) => void;
};

export function createPreviewController(deps: PreviewDeps) {
  let isPreviewPanelVisible = false;
  let previewRequestId = 0;
  let currentQuicklookFile: FileItem | null = null;
  let quicklookRequestId = 0;

  let previewPanel: HTMLElement | null = null;
  let previewContent: HTMLElement | null = null;
  let previewToggleBtn: HTMLButtonElement | null = null;
  let previewCloseBtn: HTMLButtonElement | null = null;

  let quicklookModal: HTMLElement | null = null;
  let quicklookContent: HTMLElement | null = null;
  let quicklookTitle: HTMLElement | null = null;
  let quicklookInfo: HTMLElement | null = null;
  let quicklookClose: HTMLButtonElement | null = null;
  let quicklookOpen: HTMLButtonElement | null = null;

  const ensureElements = () => {
    if (!previewPanel) previewPanel = getById('preview-panel');
    if (!previewContent) previewContent = getById('preview-content');
    if (!previewToggleBtn) previewToggleBtn = getById('preview-toggle-btn') as HTMLButtonElement;
    if (!previewCloseBtn) previewCloseBtn = getById('preview-close') as HTMLButtonElement;

    if (!quicklookModal) quicklookModal = getById('quicklook-modal');
    if (!quicklookContent) quicklookContent = getById('quicklook-content');
    if (!quicklookTitle) quicklookTitle = getById('quicklook-title');
    if (!quicklookInfo) quicklookInfo = getById('quicklook-info');
    if (!quicklookClose) quicklookClose = getById('quicklook-close') as HTMLButtonElement;
    if (!quicklookOpen) quicklookOpen = getById('quicklook-open') as HTMLButtonElement;
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
    showEmptyPreview();
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
  }

  function updatePreview(file: FileItem) {
    const requestId = ++previewRequestId;
    if (!file || file.isDirectory) {
      showEmptyPreview();
      return;
    }

    const ext = deps.getFileExtension(file.name);

    if (IMAGE_EXTENSIONS.has(ext)) {
      showImagePreview(file, requestId);
    } else if (RAW_EXTENSIONS.has(ext)) {
      showRawImagePreview(file, requestId);
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
  }

  async function showArchivePreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading archive contents...</p>
    </div>
  `;

    try {
      const result = await window.electronAPI.listArchiveContents(file.path);
      if (requestId !== previewRequestId) return;

      if (result.success && result.entries) {
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
      } else {
        previewContent.innerHTML = `
        <div class="preview-error">
          Failed to list archive contents: ${escapeHtml(result.error || 'Unknown error')}
        </div>
        ${generateFileInfo(file, null)}
      `;
      }
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
    previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading image...</p>
    </div>
  `;

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
    const info = props.success && props.properties ? props.properties : null;
    const fileUrl = encodeFileUrl(file.path);
    const altText = escapeHtml(file.name);

    previewContent.innerHTML = `
    <img src="${fileUrl}" class="preview-image" alt="${altText}">
    ${generateFileInfo(file, info)}
  `;

    const img = previewContent.querySelector('.preview-image') as HTMLImageElement | null;
    if (img) {
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
    const info = props.success && props.properties ? props.properties : null;

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

  let hljs: HighlightJs | null = null;
  let hljsLoading: Promise<HighlightJs | null> | null = null;

  const EXT_TO_LANG: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    pyc: 'python',
    pyw: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    r: 'r',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    svelte: 'xml',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    sql: 'sql',
    md: 'markdown',
    markdown: 'markdown',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    cmake: 'cmake',
  };

  async function loadHighlightJs(): Promise<HighlightJs | null> {
    if (hljs) return hljs;
    if (hljsLoading) return hljsLoading;

    hljsLoading = new Promise((resolve) => {
      const existingLink = document.querySelector('link[data-highlightjs="theme"]');
      if (!existingLink) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '../dist/vendor/highlight.css';
        link.dataset.highlightjs = 'theme';
        document.head.appendChild(link);
      }

      const existingScript = document.querySelector(
        'script[data-highlightjs="core"]'
      ) as HTMLScriptElement | null;
      if (existingScript) {
        existingScript.addEventListener('load', () => {
          const globalHljs = (window as Window & { hljs?: HighlightJs }).hljs || null;
          hljs = globalHljs;
          resolve(hljs);
        });
        existingScript.addEventListener('error', () => resolve(null));
        const existingGlobal = (window as Window & { hljs?: HighlightJs }).hljs;
        if (existingGlobal) {
          hljs = existingGlobal;
          resolve(hljs);
        }
        return;
      }

      const script = document.createElement('script');
      script.src = '../dist/vendor/highlight.js';
      script.dataset.highlightjs = 'core';
      script.onload = () => {
        const globalHljs = (window as Window & { hljs?: HighlightJs }).hljs || null;
        hljs = globalHljs;
        resolve(hljs);
      };
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });

    return hljsLoading;
  }

  function getLanguageForExt(ext: string): string | null {
    return EXT_TO_LANG[ext.toLowerCase()] || null;
  }

  async function showTextPreview(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    previewContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading text...</p>
    </div>
  `;

    const result = await window.electronAPI.readFileContent(file.path, 50 * 1024);
    if (requestId !== previewRequestId) return;

    if (result.success && typeof result.content === 'string') {
      const props = await window.electronAPI.getItemProperties(file.path);
      if (requestId !== previewRequestId) return;
      const info = props.success && props.properties ? props.properties : null;
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
    } else {
      previewContent.innerHTML = `
      <div class="preview-error">
        Failed to load text: ${escapeHtml(result.error || 'Unknown error')}
      </div>
      ${generateFileInfo(file, null)}
    `;
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
    const info = props.success && props.properties ? props.properties : null;

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
    const info = props.success && props.properties ? props.properties : null;

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

    const settings = deps.getCurrentSettings();
    const maxSizeMB = settings.maxPreviewSizeMB || 50;
    if (file.size > maxSizeMB * 1024 * 1024) {
      previewContent.innerHTML = `
      <div class="preview-error">
        PDF file too large to preview (>${maxSizeMB}MB)
      </div>
      ${generateFileInfo(file, null)}
    `;
      return;
    }

    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success && props.properties ? props.properties : null;

    const fileUrl = encodeFileUrl(file.path);

    previewContent.innerHTML = `
    <iframe src="${fileUrl}" class="preview-pdf" frameborder="0" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
    ${generateFileInfo(file, info)}
  `;
  }

  async function showFileInfo(file: FileItem, requestId: number) {
    ensureElements();
    if (!previewContent || requestId !== previewRequestId) return;
    const props = await window.electronAPI.getItemProperties(file.path);
    if (requestId !== previewRequestId) return;
    const info = props.success && props.properties ? props.properties : null;

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

  async function showQuickLook() {
    ensureElements();
    const selectedItems = deps.getSelectedItems();
    if (selectedItems.size !== 1) return;
    if (!quicklookModal || !quicklookTitle || !quicklookContent || !quicklookInfo) return;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const selectedPath = Array.from(selectedItems)[0];
    const file = deps.getFileByPath(selectedPath);

    if (!file || file.isDirectory) return;

    const requestId = ++quicklookRequestId;
    currentQuicklookFile = file;
    quicklookTitle.textContent = file.name;
    quicklookModal.style.display = 'flex';

    const ext = deps.getFileExtension(file.name);

    quicklookContent.innerHTML = `
    <div class="preview-loading">
      <div class="spinner"></div>
      <p>Loading preview...</p>
    </div>
  `;

    if (IMAGE_EXTENSIONS.has(ext)) {
      const settings = deps.getCurrentSettings();
      if (file.size > (settings.maxThumbnailSizeMB || 10) * 1024 * 1024) {
        quicklookContent.innerHTML = `<div class="preview-error">Image too large to preview</div>`;
        quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
      } else {
        const fileUrl = encodeFileUrl(file.path);
        quicklookContent.innerHTML = '';
        const img = document.createElement('img');
        img.src = fileUrl;
        img.alt = file.name;
        img.addEventListener('error', () => {
          if (requestId !== quicklookRequestId || currentQuicklookFile?.path !== file.path) {
            return;
          }
          quicklookContent!.innerHTML = `<div class="preview-error">Failed to load image</div>`;
        });
        quicklookContent.appendChild(img);
        quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
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
      quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
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
      quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
    } else if (PDF_EXTENSIONS.has(ext)) {
      const fileUrl = encodeFileUrl(file.path);
      quicklookContent.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.src = fileUrl;
      iframe.className = 'preview-pdf';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute('frameborder', '0');
      quicklookContent.appendChild(iframe);
      quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
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
        quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
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
      quicklookInfo.textContent = `${deps.formatFileSize(file.size)} • ${new Date(file.modified).toLocaleDateString()}`;
    }
  }

  function closeQuickLook() {
    ensureElements();
    if (quicklookModal) quicklookModal.style.display = 'none';
    currentQuicklookFile = null;
    quicklookRequestId++;
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
      });
    }

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

  function isPreviewVisible(): boolean {
    return isPreviewPanelVisible;
  }

  function isQuickLookOpen(): boolean {
    ensureElements();
    return !!quicklookModal && quicklookModal.style.display === 'flex';
  }

  return {
    initPreviewUi,
    updatePreview,
    showEmptyPreview,
    clearPreview,
    togglePreviewPanel,
    isPreviewVisible,
    showQuickLook,
    closeQuickLook,
    isQuickLookOpen,
  };
}
