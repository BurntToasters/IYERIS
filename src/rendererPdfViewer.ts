/* eslint-disable @typescript-eslint/no-explicit-any */

interface PdfjsLib {
  getDocument: (params: {
    url?: string;
    data?: ArrayBuffer | Uint8Array;
    disableAutoFetch?: boolean;
    disableStream?: boolean;
    isEvalSupported?: boolean;
    enableXfa?: boolean;
  }) => { promise: Promise<PdfjsDocument> };
  GlobalWorkerOptions: { workerSrc: string };
  TextLayer?: any;
}

interface PdfjsDocument {
  numPages: number;
  getPage: (pageNum: number) => Promise<PdfjsPage>;
  destroy: () => void;
}

interface PdfjsPage {
  getViewport: (params: { scale: number }) => any;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: any }) => {
    promise: Promise<void>;
  };
  getTextContent: () => Promise<any>;
}

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const DEFAULT_ZOOM_INDEX = 2;
const WHEEL_NAV_COOLDOWN = 300;
const WHEEL_ZOOM_COOLDOWN = 150;

let pdfjsLib: PdfjsLib | null = null;
let pdfjsLoading: Promise<PdfjsLib | null> | null = null;

export async function loadPdfJs(): Promise<PdfjsLib | null> {
  if (pdfjsLib) return pdfjsLib;
  if (pdfjsLoading) return pdfjsLoading;

  pdfjsLoading = (async () => {
    try {
      const pdfJsModulePath = '../vendor/pdfjs/pdf.min.mjs';
      const mod = (await import(/* webpackIgnore: true */ pdfJsModulePath)) as any;
      const lib: PdfjsLib = mod.default || mod;
      lib.GlobalWorkerOptions.workerSrc = '../vendor/pdfjs/pdf.worker.min.mjs';
      pdfjsLib = lib;
      return pdfjsLib;
    } catch (err) {
      console.error('[PDF] Failed to load pdf.js:', err);
      pdfjsLoading = null;
      return null;
    }
  })();

  return pdfjsLoading;
}

async function renderPage(
  doc: PdfjsDocument,
  pageNum: number,
  canvas: HTMLCanvasElement,
  textLayerEl: HTMLElement | null,
  maxWidth: number,
  zoom: number,
  lib: PdfjsLib
): Promise<void> {
  const page = await doc.getPage(pageNum);
  const dpr = window.devicePixelRatio || 1;
  const effectiveWidth = maxWidth * zoom;
  const baseViewport = page.getViewport({ scale: 1 });
  const cssScale = effectiveWidth / baseViewport.width;
  const renderScale = cssScale * dpr;
  const viewport = page.getViewport({ scale: renderScale });
  const cssViewport = page.getViewport({ scale: cssScale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${cssViewport.width}px`;
  canvas.style.height = `${cssViewport.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  await page.render({ canvasContext: ctx, viewport }).promise;

  if (textLayerEl && lib.TextLayer) {
    textLayerEl.innerHTML = '';
    textLayerEl.style.width = `${cssViewport.width}px`;
    textLayerEl.style.height = `${cssViewport.height}px`;

    try {
      const tl = new lib.TextLayer({
        textContentSource: page.getTextContent(),
        container: textLayerEl,
        viewport: cssViewport,
      });
      await tl.render();
    } catch (err) {
      console.warn('[PDF] Text layer render failed:', err);
    }
  }
}

export interface PdfViewerHandle {
  element: HTMLElement;
  goToPage: (page: number) => Promise<void>;
  getPageCount: () => number;
  getCurrentPage: () => number;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  resetZoom: () => Promise<void>;
  getZoom: () => number;
  destroy: () => void;
}

export async function createPdfViewer(
  fileUrl: string,
  options: {
    maxWidth?: number;
    containerClass?: string;
    showPageControls?: boolean;
    onError?: (error: string) => void;
  } = {}
): Promise<PdfViewerHandle> {
  const { maxWidth = 800, containerClass = '', showPageControls = true, onError } = options;

  const lib = await loadPdfJs();
  if (!lib) throw new Error('pdf.js failed to load');

  const container = document.createElement('div');
  container.className = `pdfjs-viewer ${containerClass}`.trim();
  container.tabIndex = 0;

  const pageViewport = document.createElement('div');
  pageViewport.className = 'pdfjs-page-viewport';

  const pageWrapper = document.createElement('div');
  pageWrapper.className = 'pdfjs-page-wrapper';

  const canvas = document.createElement('canvas');
  canvas.className = 'pdfjs-canvas';
  pageWrapper.appendChild(canvas);

  let textLayerEl: HTMLElement | null = null;
  if (lib.TextLayer) {
    textLayerEl = document.createElement('div');
    textLayerEl.className = 'textLayer pdfjs-text-layer';
    pageWrapper.appendChild(textLayerEl);
  }

  pageViewport.appendChild(pageWrapper);
  container.appendChild(pageViewport);

  let doc: PdfjsDocument | null = null;
  let currentPage = 1;
  let totalPages = 0;
  let zoomIndex = DEFAULT_ZOOM_INDEX;
  let destroyed = false;
  let rendering = false;
  let lastWheelNav = 0;
  let lastWheelZoom = 0;

  let controlsEl: HTMLElement | null = null;
  let pageIndicator: HTMLElement | null = null;
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  let zoomOutBtn: HTMLButtonElement | null = null;
  let zoomInBtn: HTMLButtonElement | null = null;
  let zoomIndicator: HTMLElement | null = null;

  if (showPageControls) {
    controlsEl = document.createElement('div');
    controlsEl.className = 'pdfjs-controls';

    prevBtn = document.createElement('button');
    prevBtn.className = 'pdfjs-nav-btn';
    prevBtn.textContent = '\u2039';
    prevBtn.title = 'Previous page';
    prevBtn.disabled = true;

    pageIndicator = document.createElement('span');
    pageIndicator.className = 'pdfjs-page-indicator';
    pageIndicator.textContent = 'Loading...';

    nextBtn = document.createElement('button');
    nextBtn.className = 'pdfjs-nav-btn';
    nextBtn.title = 'Next page';
    nextBtn.textContent = '\u203a';
    nextBtn.disabled = true;

    const separator = document.createElement('div');
    separator.className = 'pdfjs-controls-separator';

    zoomOutBtn = document.createElement('button');
    zoomOutBtn.className = 'pdfjs-zoom-btn';
    zoomOutBtn.textContent = '\u2212';
    zoomOutBtn.title = 'Zoom out';

    zoomIndicator = document.createElement('span');
    zoomIndicator.className = 'pdfjs-zoom-indicator';
    zoomIndicator.textContent = '100%';

    zoomInBtn = document.createElement('button');
    zoomInBtn.className = 'pdfjs-zoom-btn';
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';

    controlsEl.appendChild(prevBtn);
    controlsEl.appendChild(pageIndicator);
    controlsEl.appendChild(nextBtn);
    controlsEl.appendChild(separator);
    controlsEl.appendChild(zoomOutBtn);
    controlsEl.appendChild(zoomIndicator);
    controlsEl.appendChild(zoomInBtn);
    container.appendChild(controlsEl);

    prevBtn.addEventListener('click', () => void goToPage(currentPage - 1));
    nextBtn.addEventListener('click', () => void goToPage(currentPage + 1));
    zoomOutBtn.addEventListener('click', () => void zoomOut());
    zoomInBtn.addEventListener('click', () => void zoomIn());
  }

  function updateControls(): void {
    if (pageIndicator) pageIndicator.textContent = `${currentPage} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
    if (zoomIndicator) zoomIndicator.textContent = `${Math.round(ZOOM_LEVELS[zoomIndex] * 100)}%`;
    if (zoomOutBtn) zoomOutBtn.disabled = zoomIndex <= 0;
    if (zoomInBtn) zoomInBtn.disabled = zoomIndex >= ZOOM_LEVELS.length - 1;
  }

  async function renderCurrentPage(animate: boolean): Promise<void> {
    if (!doc || destroyed || rendering) return;
    rendering = true;

    try {
      if (animate) {
        pageWrapper.classList.add('pdfjs-transitioning');
        await new Promise((r) => setTimeout(r, 150));
      }

      await renderPage(
        doc,
        currentPage,
        canvas,
        textLayerEl,
        maxWidth,
        ZOOM_LEVELS[zoomIndex],
        lib!
      );
      updateControls();

      if (animate) pageWrapper.classList.remove('pdfjs-transitioning');
    } catch (err) {
      console.error('[PDF] Render error:', err);
      onError?.('Failed to render page');
      if (animate) pageWrapper.classList.remove('pdfjs-transitioning');
    } finally {
      rendering = false;
    }
  }

  async function goToPage(page: number): Promise<void> {
    if (!doc || destroyed) return;
    if (page < 1 || page > totalPages || page === currentPage) return;
    currentPage = page;
    await renderCurrentPage(true);
  }

  async function zoomIn(): Promise<void> {
    if (zoomIndex >= ZOOM_LEVELS.length - 1) return;
    zoomIndex++;
    await renderCurrentPage(false);
  }

  async function zoomOut(): Promise<void> {
    if (zoomIndex <= 0) return;
    zoomIndex--;
    await renderCurrentPage(false);
  }

  async function resetZoom(): Promise<void> {
    if (zoomIndex === DEFAULT_ZOOM_INDEX) return;
    zoomIndex = DEFAULT_ZOOM_INDEX;
    await renderCurrentPage(false);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (destroyed) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        void goToPage(currentPage - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        void goToPage(currentPage + 1);
        break;
      case '=':
      case '+':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          void zoomIn();
        }
        break;
      case '-':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          void zoomOut();
        }
        break;
      case '0':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          void resetZoom();
        }
        break;
    }
  }

  function handleWheel(e: WheelEvent): void {
    if (destroyed) return;
    const now = Date.now();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (now - lastWheelZoom < WHEEL_ZOOM_COOLDOWN) return;
      lastWheelZoom = now;
      if (e.deltaY < 0) void zoomIn();
      else if (e.deltaY > 0) void zoomOut();
      return;
    }

    if (ZOOM_LEVELS[zoomIndex] > 1.0) return;

    if (now - lastWheelNav < WHEEL_NAV_COOLDOWN) return;
    if (Math.abs(e.deltaY) < 20) return;
    e.preventDefault();
    lastWheelNav = now;
    if (e.deltaY > 0) void goToPage(currentPage + 1);
    else void goToPage(currentPage - 1);
  }

  function destroy(): void {
    destroyed = true;
    container.removeEventListener('keydown', handleKeydown);
    pageViewport.removeEventListener('wheel', handleWheel);
    if (doc) {
      doc.destroy();
      doc = null;
    }
  }

  container.addEventListener('keydown', handleKeydown);
  pageViewport.addEventListener('wheel', handleWheel, { passive: false });

  try {
    const loadingTask = lib.getDocument({
      url: fileUrl,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      enableXfa: false,
    });
    doc = await loadingTask.promise;
    totalPages = doc.numPages;

    if (destroyed) {
      doc.destroy();
      doc = null;
      throw new Error('Viewer destroyed during load');
    }

    if (totalPages === 0) throw new Error('PDF has no pages');

    if (totalPages === 1 && controlsEl) {
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      if (pageIndicator) pageIndicator.style.display = 'none';
      const sep = controlsEl.querySelector('.pdfjs-controls-separator');
      if (sep) (sep as HTMLElement).style.display = 'none';
    }

    await renderPage(doc, 1, canvas, textLayerEl, maxWidth, ZOOM_LEVELS[zoomIndex], lib);
    updateControls();

    requestAnimationFrame(() => {
      if (!destroyed) container.focus({ preventScroll: true });
    });
  } catch (err: any) {
    const msg = err?.message || 'Failed to load PDF';
    console.error('[PDF] Load error:', msg);
    onError?.(msg);
    throw err;
  }

  return {
    element: container,
    goToPage,
    getPageCount: () => totalPages,
    getCurrentPage: () => currentPage,
    zoomIn,
    zoomOut,
    resetZoom,
    getZoom: () => ZOOM_LEVELS[zoomIndex],
    destroy,
  };
}

export async function generatePdfThumbnailPdfJs(
  fileUrl: string,
  quality: 'low' | 'medium' | 'high' = 'medium'
): Promise<string> {
  const lib = await loadPdfJs();
  if (!lib) throw new Error('pdf.js failed to load');

  const loadingTask = lib.getDocument({
    url: fileUrl,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    enableXfa: false,
  });

  const doc = await loadingTask.promise;

  try {
    if (doc.numPages === 0) throw new Error('PDF has no pages');

    const page = await doc.getPage(1);
    const dpr = window.devicePixelRatio || 1;
    const thumbWidth = 160 * dpr;

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = thumbWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const q = quality === 'low' ? 0.5 : quality === 'high' ? 0.9 : 0.7;
    return canvas.toDataURL('image/jpeg', q);
  } finally {
    doc.destroy();
  }
}
