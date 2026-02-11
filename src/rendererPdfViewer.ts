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
}

interface PdfjsDocument {
  numPages: number;
  getPage: (pageNum: number) => Promise<PdfjsPage>;
  destroy: () => void;
}

interface PdfjsPage {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
}

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
  maxWidth: number
): Promise<void> {
  const page = await doc.getPage(pageNum);
  const dpr = window.devicePixelRatio || 1;
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = (maxWidth / baseViewport.width) * dpr;
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  await page.render({ canvasContext: ctx, viewport }).promise;
}

export interface PdfViewerHandle {
  element: HTMLElement;
  goToPage: (page: number) => Promise<void>;
  getPageCount: () => number;
  getCurrentPage: () => number;
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
  if (!lib) {
    throw new Error('pdf.js failed to load');
  }

  const container = document.createElement('div');
  container.className = `pdfjs-viewer ${containerClass}`.trim();

  const canvas = document.createElement('canvas');
  canvas.className = 'pdfjs-canvas';
  container.appendChild(canvas);

  let doc: PdfjsDocument | null = null;
  let currentPage = 1;
  let totalPages = 0;
  let destroyed = false;

  let controlsEl: HTMLElement | null = null;
  let pageIndicator: HTMLElement | null = null;
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;

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

    controlsEl.appendChild(prevBtn);
    controlsEl.appendChild(pageIndicator);
    controlsEl.appendChild(nextBtn);
    container.appendChild(controlsEl);

    prevBtn.addEventListener('click', () => void goToPage(currentPage - 1));
    nextBtn.addEventListener('click', () => void goToPage(currentPage + 1));
  }

  function updateControls(): void {
    if (pageIndicator) {
      pageIndicator.textContent = `${currentPage} / ${totalPages}`;
    }
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
  }

  async function goToPage(page: number): Promise<void> {
    if (!doc || destroyed) return;
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    try {
      await renderPage(doc, currentPage, canvas, maxWidth);
      updateControls();
    } catch (err) {
      console.error('[PDF] Render error:', err);
      onError?.('Failed to render page');
    }
  }

  function destroy(): void {
    destroyed = true;
    if (doc) {
      doc.destroy();
      doc = null;
    }
  }

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

    if (totalPages === 0) {
      throw new Error('PDF has no pages');
    }

    if (totalPages === 1 && controlsEl) {
      controlsEl.style.display = 'none';
    }

    await renderPage(doc, 1, canvas, maxWidth);
    updateControls();
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
