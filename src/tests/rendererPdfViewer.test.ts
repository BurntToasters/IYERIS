// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPdfViewerWithLibrary, type PdfjsLib } from '../rendererPdfViewer.js';

type MockPdfOptions = {
  documentPromise?: Promise<unknown>;
  renderPromise?: Promise<void>;
};

function createMockPdf(options: MockPdfOptions = {}) {
  const renderCancel = vi.fn();
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    })),
    render: vi.fn(() => ({
      promise: options.renderPromise ?? Promise.resolve(),
      cancel: renderCancel,
    })),
    getTextContent: vi.fn(async () => ({ items: [] })),
  };
  const documentDestroy = vi.fn();
  const document = {
    numPages: 2,
    getPage: vi.fn(async () => page),
    destroy: documentDestroy,
  };
  const loadingDestroy = vi.fn();
  const lib = {
    getDocument: vi.fn(() => ({
      promise: options.documentPromise ?? Promise.resolve(document),
      destroy: loadingDestroy,
    })),
    GlobalWorkerOptions: { workerSrc: '' },
  } as unknown as PdfjsLib;

  return { lib, page, document, documentDestroy, loadingDestroy, renderCancel };
}

describe('rendererPdfViewer', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('aborts a pending document load before a viewer handle exists', async () => {
    const mock = createMockPdf({ documentPromise: new Promise(() => {}) });
    const abort = new AbortController();
    const pending = createPdfViewerWithLibrary(mock.lib, 'asset://document.pdf', {
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await rejected;
    expect(mock.loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it('aborts first-page rendering before a viewer handle exists', async () => {
    const mock = createMockPdf({ renderPromise: new Promise(() => {}) });
    const abort = new AbortController();
    const pending = createPdfViewerWithLibrary(mock.lib, 'asset://document.pdf', {
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mock.page.render).toHaveBeenCalled());
    abort.abort();
    await rejected;
    expect(mock.documentDestroy).toHaveBeenCalledTimes(1);
    expect(mock.renderCancel).toHaveBeenCalled();
  });

  it('labels the viewer, toolbar, navigation, and zoom controls', async () => {
    const mock = createMockPdf();
    const viewer = await createPdfViewerWithLibrary(mock.lib, 'asset://document.pdf');

    expect(viewer.element.getAttribute('role')).toBe('region');
    expect(viewer.element.getAttribute('aria-label')).toBe('PDF document viewer');
    expect(viewer.element.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'PDF controls'
    );
    expect(
      Array.from(viewer.element.querySelectorAll('button')).map((button) =>
        button.getAttribute('aria-label')
      )
    ).toEqual(['Previous PDF page', 'Next PDF page', 'Zoom out PDF', 'Zoom in PDF']);
    expect(viewer.element.querySelector('.pdfjs-page-indicator')?.getAttribute('aria-live')).toBe(
      'polite'
    );
    expect(mock.lib.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        disableAutoFetch: true,
        disableStream: true,
        isEvalSupported: false,
        enableXfa: false,
      })
    );
  });

  it('destroys the PDF document and ignores navigation after destruction', async () => {
    const mock = createMockPdf();
    const viewer = await createPdfViewerWithLibrary(mock.lib, 'asset://document.pdf');
    expect(mock.document.getPage).toHaveBeenCalledTimes(1);

    viewer.destroy();
    await viewer.goToPage(2);

    expect(mock.documentDestroy).toHaveBeenCalledTimes(1);
    expect(mock.document.getPage).toHaveBeenCalledTimes(1);
  });

  it('reverts page state after a render failure so retry still works', async () => {
    const onError = vi.fn();
    const mock = createMockPdf();
    let renderCount = 0;
    mock.page.render.mockImplementation(() => {
      renderCount += 1;
      if (renderCount === 2) {
        return {
          promise: Promise.reject(new Error('paint failed')),
          cancel: mock.renderCancel,
        };
      }
      return {
        promise: Promise.resolve(),
        cancel: mock.renderCancel,
      };
    });

    const viewer = await createPdfViewerWithLibrary(mock.lib, 'asset://document.pdf', { onError });
    expect(viewer.getCurrentPage()).toBe(1);

    await viewer.goToPage(2);
    expect(viewer.getCurrentPage()).toBe(1);
    expect(onError).toHaveBeenCalledWith('Failed to render page');

    await viewer.goToPage(2);
    expect(viewer.getCurrentPage()).toBe(2);
  });

  it('does not resume a pending render after destroy during the transition', async () => {
    vi.useFakeTimers();
    const mock = createMockPdf();
    const viewer = await createPdfViewerWithLibrary(mock.lib, 'asset://document.pdf');
    expect(mock.document.getPage).toHaveBeenCalledTimes(1);

    const navigation = viewer.goToPage(2);
    viewer.destroy();
    await vi.advanceTimersByTimeAsync(250);
    await navigation;

    expect(mock.document.getPage).toHaveBeenCalledTimes(1);
    expect(mock.documentDestroy).toHaveBeenCalledTimes(1);
  });

  it('rejects a page viewport above the canvas pixel budget', async () => {
    const mock = createMockPdf();
    mock.page.getViewport
      .mockReturnValueOnce({ width: 100, height: 100 })
      .mockReturnValueOnce({ width: 5000, height: 5000 })
      .mockReturnValueOnce({ width: 800, height: 800 });

    await expect(createPdfViewerWithLibrary(mock.lib, 'asset://oversized.pdf')).rejects.toThrow(
      'PDF page dimensions exceed the preview limit'
    );
    expect(mock.page.render).not.toHaveBeenCalled();
    expect(mock.documentDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a loading task when document loading times out', async () => {
    vi.useFakeTimers();
    const mock = createMockPdf({ documentPromise: new Promise(() => undefined) });
    const viewerPromise = createPdfViewerWithLibrary(mock.lib, 'asset://stalled.pdf');
    const rejection = expect(viewerPromise).rejects.toThrow('PDF load timed out');

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(mock.loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a loading task when document loading rejects', async () => {
    const mock = createMockPdf({ documentPromise: Promise.reject(new Error('invalid PDF')) });

    await expect(createPdfViewerWithLibrary(mock.lib, 'asset://invalid.pdf')).rejects.toThrow(
      'invalid PDF'
    );
    expect(mock.loadingDestroy).toHaveBeenCalledTimes(1);
  });

  it('cancels a render task when page rendering times out', async () => {
    vi.useFakeTimers();
    const mock = createMockPdf({ renderPromise: new Promise(() => undefined) });
    const viewerPromise = createPdfViewerWithLibrary(mock.lib, 'asset://stalled-page.pdf');
    const rejection = expect(viewerPromise).rejects.toThrow('PDF page render timed out');

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(mock.renderCancel).toHaveBeenCalledTimes(1);
    expect(mock.documentDestroy).toHaveBeenCalledTimes(1);
  });
});
