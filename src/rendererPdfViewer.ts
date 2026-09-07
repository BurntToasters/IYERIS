import { devLog } from './shared.js';

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsTextContent {
  items: Array<{ str: string }>;
}

interface PdfjsTextLayerConstructor {
  new (params: {
    textContentSource: Promise<PdfjsTextContent>;
    container: HTMLElement;
    viewport: PdfjsViewport;
  }): { render: () => Promise<void> };
}

interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy: () => void | Promise<void>;
}

export interface PdfjsLib {
  getDocument: (params: {
    url?: string;
    data?: ArrayBuffer | Uint8Array;
    disableAutoFetch?: boolean;
    disableStream?: boolean;
    isEvalSupported?: boolean;
    enableXfa?: boolean;
  }) => PdfjsLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
  TextLayer?: PdfjsTextLayerConstructor;
}

interface PdfjsDocument {
  numPages: number;
  getPage: (pageNum: number) => Promise<PdfjsPage>;
  destroy: () => void;
}

interface PdfjsPage {
  getViewport: (params: { scale: number }) => PdfjsViewport;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: PdfjsViewport }) => {
    promise: Promise<void>;
    cancel?: () => void;
  };
  getTextContent: () => Promise<PdfjsTextContent>;
}

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const DEFAULT_ZOOM_INDEX = 2;
const WHEEL_NAV_COOLDOWN = 300;
const WHEEL_ZOOM_COOLDOWN = 150;
const PDF_LOAD_TIMEOUT_MS = 30_000;
const PDF_RENDER_TIMEOUT_MS = 30_000;
const PDF_MAX_CANVAS_PIXELS = 16_000_000;

let pdfjsLib: PdfjsLib | null = null;
let pdfjsLoading: Promise<PdfjsLib | null> | null = null;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function assertViewportWithinBudget(viewport: PdfjsViewport): void {
  const pixels = viewport.width * viewport.height;
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(pixels) ||
    pixels > PDF_MAX_CANVAS_PIXELS
  ) {
    throw new Error('PDF page dimensions exceed the preview limit');
  }
}

export async function loadPdfJs(): Promise<PdfjsLib | null> {
  if (pdfjsLib) return pdfjsLib;
  if (pdfjsLoading) return pdfjsLoading;

  pdfjsLoading = (async () => {
    try {
      const modulePath = '/vendor/pdfjs/pdf.min.mjs';
      const mod = await import(/* @vite-ignore */ modulePath);
      mod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      pdfjsLib = mod as PdfjsLib;
      return pdfjsLib;
    } catch {
      devLog('PDF', 'Failed to load pdf.js');
      pdfjsLoading = null;
      return null;
    }
  })();

  return pdfjsLoading;
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('PDF load cancelled', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function renderPage(
  doc: PdfjsDocument,
  pageNum: number,
  canvas: HTMLCanvasElement,
  textLayerEl: HTMLElement | null,
  maxWidth: number,
  zoom: number,
  lib: PdfjsLib,
  signal?: AbortSignal
): Promise<void> {
  const page = await withTimeout(
    withAbort(doc.getPage(pageNum), signal),
    PDF_RENDER_TIMEOUT_MS,
    'PDF page load timed out'
  );
  const dpr = window.devicePixelRatio || 1;
  const effectiveWidth = maxWidth * zoom;
  const baseViewport = page.getViewport({ scale: 1 });
  const cssScale = effectiveWidth / baseViewport.width;
  const renderScale = cssScale * dpr;
  const viewport = page.getViewport({ scale: renderScale });
  const cssViewport = page.getViewport({ scale: cssScale });
  assertViewportWithinBudget(viewport);

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${cssViewport.width}px`;
  canvas.style.height = `${cssViewport.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await withTimeout(
      withAbort(renderTask.promise, signal),
      PDF_RENDER_TIMEOUT_MS,
      'PDF page render timed out'
    );
  } catch (error) {
    renderTask.cancel?.();
    throw error;
  }

  if (textLayerEl && lib.TextLayer) {
    textLayerEl.replaceChildren();
    textLayerEl.style.width = `${cssViewport.width}px`;
    textLayerEl.style.height = `${cssViewport.height}px`;

    try {
      const tl = new lib.TextLayer({
        textContentSource: withTimeout(
          page.getTextContent(),
          PDF_RENDER_TIMEOUT_MS,
          'PDF text layer load timed out'
        ),
        container: textLayerEl,
        viewport: cssViewport,
      });
      await withTimeout(tl.render(), PDF_RENDER_TIMEOUT_MS, 'PDF text layer render timed out');
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

export interface PdfViewerOptions {
  signal?: AbortSignal;
  maxWidth?: number;
  containerClass?: string;
  showPageControls?: boolean;
  onError?: (error: string) => void;
}

export async function createPdfViewer(
  fileUrl: string,
  options: PdfViewerOptions = {}
): Promise<PdfViewerHandle> {
  if (options.signal?.aborted) throw new DOMException('PDF load cancelled', 'AbortError');
  const lib = await withAbort(loadPdfJs(), options.signal);
  if (!lib) throw new Error('pdf.js failed to load');
  return createPdfViewerWithLibrary(lib, fileUrl, options);
}

/** Dependency-injected entry point used by the focused pdf.js contract tests. */
export async function createPdfViewerWithLibrary(
  lib: PdfjsLib,
  fileUrl: string,
  options: PdfViewerOptions = {}
): Promise<PdfViewerHandle> {
  const { maxWidth = 800, containerClass = '', showPageControls = true, onError, signal } = options;
  if (signal?.aborted) throw new DOMException('PDF load cancelled', 'AbortError');

  const container = document.createElement('div');
  container.className = `pdfjs-viewer ${containerClass}`.trim();
  container.tabIndex = 0;
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'PDF document viewer');

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
  let loadingTask: PdfjsLoadingTask | null = null;
  let loadingTaskDestroyCalled = false;
  let currentPage = 1;
  let requestedPage = 1;
  let committedPage = 1;
  let totalPages = 0;
  let zoomIndex = DEFAULT_ZOOM_INDEX;
  let requestedZoomIndex = DEFAULT_ZOOM_INDEX;
  let committedZoomIndex = DEFAULT_ZOOM_INDEX;
  let destroyed = false;
  let renderGeneration = 0;
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

  function destroyLoadingTask(task: PdfjsLoadingTask): void {
    if (loadingTaskDestroyCalled) return;
    loadingTaskDestroyCalled = true;
    try {
      void Promise.resolve(task.destroy()).catch((error) => {
        devLog('PDF', 'Failed to cancel PDF load', error);
      });
    } catch (error) {
      devLog('PDF', 'Failed to cancel PDF load', error);
    }
  }

  if (showPageControls) {
    controlsEl = document.createElement('div');
    controlsEl.className = 'pdfjs-controls';
    controlsEl.setAttribute('role', 'toolbar');
    controlsEl.setAttribute('aria-label', 'PDF controls');

    prevBtn = document.createElement('button');
    prevBtn.className = 'pdfjs-nav-btn';
    prevBtn.type = 'button';
    prevBtn.textContent = '\u2039';
    prevBtn.title = 'Previous page';
    prevBtn.setAttribute('aria-label', 'Previous PDF page');
    prevBtn.disabled = true;

    pageIndicator = document.createElement('span');
    pageIndicator.className = 'pdfjs-page-indicator';
    pageIndicator.textContent = 'Loading...';
    pageIndicator.setAttribute('aria-live', 'polite');
    pageIndicator.setAttribute('aria-atomic', 'true');

    nextBtn = document.createElement('button');
    nextBtn.className = 'pdfjs-nav-btn';
    nextBtn.type = 'button';
    nextBtn.title = 'Next page';
    nextBtn.setAttribute('aria-label', 'Next PDF page');
    nextBtn.textContent = '\u203a';
    nextBtn.disabled = true;

    const separator = document.createElement('div');
    separator.className = 'pdfjs-controls-separator';
    separator.setAttribute('role', 'separator');
    separator.setAttribute('aria-orientation', 'vertical');

    zoomOutBtn = document.createElement('button');
    zoomOutBtn.className = 'pdfjs-zoom-btn';
    zoomOutBtn.type = 'button';
    zoomOutBtn.textContent = '\u2212';
    zoomOutBtn.title = 'Zoom out';
    zoomOutBtn.setAttribute('aria-label', 'Zoom out PDF');

    zoomIndicator = document.createElement('span');
    zoomIndicator.className = 'pdfjs-zoom-indicator';
    zoomIndicator.textContent = '100%';

    zoomInBtn = document.createElement('button');
    zoomInBtn.className = 'pdfjs-zoom-btn';
    zoomInBtn.type = 'button';
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomInBtn.setAttribute('aria-label', 'Zoom in PDF');

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
    if (zoomIndicator) zoomIndicator.textContent = `${Math.round(ZOOM_LEVELS[zoomIndex]! * 100)}%`;
    if (zoomOutBtn) zoomOutBtn.disabled = zoomIndex <= 0;
    if (zoomInBtn) zoomInBtn.disabled = zoomIndex >= ZOOM_LEVELS.length - 1;
  }

  let pendingRender: { animate: boolean } | null = null;

  function isCurrentRender(generation: number): boolean {
    return !destroyed && generation === renderGeneration && doc !== null;
  }

  async function renderCurrentPage(animate: boolean): Promise<void> {
    if (!doc || destroyed) return;
    if (rendering) {
      pendingRender = { animate };
      return;
    }
    rendering = true;
    const generation = renderGeneration;
    const page = requestedPage;
    const zoom = requestedZoomIndex;

    try {
      if (animate) {
        pageWrapper.classList.add('pdfjs-transitioning');
        await new Promise<void>((resolve) => {
          const onEnd = () => {
            pageWrapper.removeEventListener('transitionend', onEnd);
            resolve();
          };
          pageWrapper.addEventListener('transitionend', onEnd);
          setTimeout(onEnd, 200);
        });
        if (!isCurrentRender(generation)) return;
      }

      await renderPage(doc, page, canvas, textLayerEl, maxWidth, ZOOM_LEVELS[zoom]!, lib);
      if (!isCurrentRender(generation)) return;
      committedPage = page;
      committedZoomIndex = zoom;
      currentPage = page;
      zoomIndex = zoom;
      updateControls();

      if (animate) pageWrapper.classList.remove('pdfjs-transitioning');
    } catch (err) {
      if (!isCurrentRender(generation)) return;
      requestedPage = committedPage;
      requestedZoomIndex = committedZoomIndex;
      currentPage = committedPage;
      zoomIndex = committedZoomIndex;
      updateControls();
      devLog('PDF', 'Render error', err);
      onError?.('Failed to render page');
      if (animate) pageWrapper.classList.remove('pdfjs-transitioning');
    } finally {
      rendering = false;
      if (!isCurrentRender(generation)) {
        pendingRender = null;
      } else if (pendingRender) {
        const next = pendingRender;
        pendingRender = null;
        void renderCurrentPage(next.animate);
      }
    }
  }

  async function goToPage(page: number): Promise<void> {
    if (!doc || destroyed) return;
    if (page < 1 || page > totalPages || page === requestedPage) return;
    requestedPage = page;
    await renderCurrentPage(true);
  }

  async function zoomIn(): Promise<void> {
    if (requestedZoomIndex >= ZOOM_LEVELS.length - 1) return;
    requestedZoomIndex++;
    await renderCurrentPage(false);
  }

  async function zoomOut(): Promise<void> {
    if (requestedZoomIndex <= 0) return;
    requestedZoomIndex--;
    await renderCurrentPage(false);
  }

  async function resetZoom(): Promise<void> {
    if (requestedZoomIndex === DEFAULT_ZOOM_INDEX) return;
    requestedZoomIndex = DEFAULT_ZOOM_INDEX;
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

    if (ZOOM_LEVELS[zoomIndex]! > 1.0) return;

    if (now - lastWheelNav < WHEEL_NAV_COOLDOWN) return;
    if (Math.abs(e.deltaY) < 20) return;
    e.preventDefault();
    lastWheelNav = now;
    if (e.deltaY > 0) void goToPage(currentPage + 1);
    else void goToPage(currentPage - 1);
  }

  function destroy(): void {
    signal?.removeEventListener('abort', destroy);
    destroyed = true;
    renderGeneration += 1;
    pendingRender = null;
    container.removeEventListener('keydown', handleKeydown);
    pageViewport.removeEventListener('wheel', handleWheel);
    if (doc) {
      doc.destroy();
      doc = null;
    }
    if (loadingTask) {
      destroyLoadingTask(loadingTask);
      loadingTask = null;
    }
  }

  signal?.addEventListener('abort', destroy, { once: true });
  container.addEventListener('keydown', handleKeydown);
  pageViewport.addEventListener('wheel', handleWheel, { passive: false });

  try {
    loadingTask = lib.getDocument({
      url: fileUrl,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      enableXfa: false,
    });
    loadingTaskDestroyCalled = false;
    const activeLoadingTask = loadingTask;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      doc = await Promise.race([
        withAbort(activeLoadingTask.promise, signal),
        new Promise<PdfjsDocument>((_, reject) => {
          loadTimer = setTimeout(() => {
            destroyLoadingTask(activeLoadingTask);
            reject(new Error('PDF load timed out'));
          }, PDF_LOAD_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (loadTimer) clearTimeout(loadTimer);
    }
    loadingTask = null;
    if (!doc) throw new Error('PDF failed to load');
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

    await withAbort(
      renderPage(doc, 1, canvas, textLayerEl, maxWidth, ZOOM_LEVELS[zoomIndex]!, lib, signal),
      signal
    );
    committedPage = 1;
    committedZoomIndex = zoomIndex;
    requestedPage = 1;
    requestedZoomIndex = zoomIndex;
    currentPage = 1;
    updateControls();

    requestAnimationFrame(() => {
      if (!destroyed) container.focus({ preventScroll: true });
    });
  } catch (err: unknown) {
    signal?.removeEventListener('abort', destroy);
    container.removeEventListener('keydown', handleKeydown);
    pageViewport.removeEventListener('wheel', handleWheel);
    doc?.destroy();
    doc = null;
    if (loadingTask && !loadingTaskDestroyCalled) {
      destroyLoadingTask(loadingTask);
      loadingTask = null;
    }
    const msg = err instanceof Error ? err.message : 'Failed to load PDF';
    devLog('PDF', 'Load error', msg);
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
    getZoom: () => ZOOM_LEVELS[zoomIndex]!,
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

  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let loadingTaskDestroyCalled = false;
  let doc!: PdfjsDocument;
  const destroyLoadingTask = (): void => {
    if (loadingTaskDestroyCalled) return;
    loadingTaskDestroyCalled = true;
    try {
      void Promise.resolve(loadingTask.destroy()).catch((error) => {
        devLog('PDF', 'Failed to cancel PDF thumbnail load', error);
      });
    } catch (error) {
      devLog('PDF', 'Failed to cancel PDF thumbnail load', error);
    }
  };
  try {
    doc = await Promise.race([
      loadingTask.promise,
      new Promise<PdfjsDocument>((_, reject) => {
        loadTimer = setTimeout(() => {
          destroyLoadingTask();
          reject(new Error('PDF thumbnail load timed out'));
        }, PDF_LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    destroyLoadingTask();
    throw error;
  } finally {
    if (loadTimer) clearTimeout(loadTimer);
  }

  try {
    if (doc.numPages === 0) throw new Error('PDF has no pages');

    const page = await withTimeout(
      doc.getPage(1),
      PDF_RENDER_TIMEOUT_MS,
      'PDF thumbnail page load timed out'
    );
    const dpr = window.devicePixelRatio || 1;
    const thumbWidth = 160 * dpr;

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = thumbWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    assertViewportWithinBudget(viewport);

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    const renderTask = page.render({ canvasContext: ctx, viewport });
    try {
      await withTimeout(
        renderTask.promise,
        PDF_RENDER_TIMEOUT_MS,
        'PDF thumbnail render timed out'
      );
    } catch (error) {
      renderTask.cancel?.();
      throw error;
    }

    const q = quality === 'low' ? 0.5 : quality === 'high' ? 0.9 : 0.7;
    return canvas.toDataURL('image/jpeg', q);
  } finally {
    doc.destroy();
  }
}
