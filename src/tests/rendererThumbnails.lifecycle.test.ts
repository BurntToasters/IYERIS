// @vitest-environment jsdom
//
// Audit follow-up: rendererThumbnails.ts had exactly one test (dual-root observer
// creation), leaving the whole lifecycle unverified — observer teardown, the
// memory/disk cache path, oversize and failure fallbacks, in-flight de-duplication
// and the background pause/resume behaviour. Those guards are what stop the grid
// from decoding media it no longer needs or writing a thumbnail onto a file item
// that has already been scrolled away and replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Controllable stand-in for the activity signal that drives pause/resume. */
const activity = vi.hoisted(() => ({
  foreground: true,
  listeners: new Set<(foreground: boolean, reason: string) => void>(),
}));

vi.mock('../rendererActivityState.js', () => ({
  isForeground: () => activity.foreground,
  onActivityChange: (listener: (foreground: boolean, reason: string) => void) => {
    activity.listeners.add(listener);
    return () => activity.listeners.delete(listener);
  },
}));

vi.mock('../rendererUtils.js', () => ({
  encodeFileUrl: (filePath: string) => `asset://${filePath}`,
}));

const generatePdfThumbnailPdfJs = vi.hoisted(() => vi.fn());
vi.mock('../rendererPdfViewer.js', () => ({ generatePdfThumbnailPdfJs }));

import { createThumbnailController } from '../rendererThumbnails';

type Controller = ReturnType<typeof createThumbnailController>;

class MockIntersectionObserver {
  root: Element | null;
  callback: IntersectionObserverCallback;
  observed = new Set<Element>();
  observe = vi.fn((element: Element) => {
    this.observed.add(element);
  });
  unobserve = vi.fn((element: Element) => {
    this.observed.delete(element);
  });
  disconnect = vi.fn(() => {
    this.observed.clear();
  });
  takeRecords = vi.fn(() => [] as IntersectionObserverEntry[]);
  rootMargin = '';
  thresholds = [0];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = (options?.root as Element) ?? null;
    observers.push(this);
  }
}

let observers: MockIntersectionObserver[] = [];
let controllers: Controller[] = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

/** Feed an entry to an observer the way the browser would. */
function intersect(observer: MockIntersectionObserver, target: Element, isIntersecting = true) {
  observer.callback(
    [{ isIntersecting, target } as unknown as IntersectionObserverEntry],
    observer as unknown as IntersectionObserver
  );
}

function installTauriApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getCachedThumbnail: vi.fn(async () => ({ success: false as boolean, dataUrl: '' })),
    saveCachedThumbnail: vi.fn(async () => ({ success: true })),
    getEmbeddedOfficeThumbnail: vi.fn(async () => ({
      success: true as boolean,
      dataUrl: 'data:image/png;base64,office',
      error: '',
    })),
    getThumbnailCacheSize: vi.fn(async () => ({
      success: true as boolean,
      sizeBytes: 2048,
      fileCount: 7,
    })),
    ...overrides,
  };
  (window as any).tauriAPI = api;
  return api;
}

function makeController(overrides: Record<string, unknown> = {}) {
  const settings = {
    thumbnailQuality: 'medium',
    maxThumbnailSizeMB: 10,
    maxPreviewSizeMB: 50,
  } as any;
  const deps = {
    getCurrentSettings: () => settings,
    getFileIcon: vi.fn((name: string) => `<span class="fallback-icon" data-name="${name}"></span>`),
    getFileExtension: (name: string) => name.split('.').pop() ?? '',
    formatFileSize: (bytes: number) => `${bytes} B`,
    getFileByPath: vi.fn(),
    ...overrides,
  };
  const controller = createThumbnailController(deps as any);
  controllers.push(controller);
  return { controller, deps, settings };
}

/** A grid item shaped the way rendererFileRender builds them. */
function addFileItem(
  path: string,
  { rootId = 'file-view', thumbnailType = '', hasThumbnail = true } = {}
) {
  const fileItem = document.createElement('div');
  fileItem.className = hasThumbnail ? 'file-item has-thumbnail' : 'file-item';
  fileItem.dataset.path = path;
  if (thumbnailType) fileItem.dataset.thumbnailType = thumbnailType;
  const icon = document.createElement('div');
  icon.className = 'file-icon';
  fileItem.appendChild(icon);
  document.getElementById(rootId)!.appendChild(fileItem);
  return fileItem;
}

function makeItem(path: string, overrides: Record<string, unknown> = {}) {
  return {
    name: path.split('/').pop() ?? path,
    path,
    isDirectory: false,
    isFile: true,
    size: 1024,
    modified: 1_700_000_000_000,
    ...overrides,
  } as any;
}

const thumbnailOf = (fileItem: HTMLElement) =>
  fileItem.querySelector('img.file-thumbnail') as HTMLImageElement | null;

beforeEach(() => {
  observers = [];
  controllers = [];
  activity.foreground = true;
  activity.listeners.clear();
  generatePdfThumbnailPdfJs.mockReset();
  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="file-view"></div>
    <div id="dual-pane-secondary-list"></div>
    <span id="thumbnail-cache-size"></span>
  `;
  installTauriApi();
});

afterEach(() => {
  // The controller subscribes to activity changes; drop it so a later test's
  // background/foreground flip cannot reach an earlier controller.
  controllers.forEach((controller) => controller.destroy());
  controllers = [];
  activity.listeners.clear();
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
  }
  delete (window as any).tauriAPI;
  vi.restoreAllMocks();
});

describe('thumbnail observer lifecycle', () => {
  it('reuses a single observer per scroll root', () => {
    const { controller } = makeController();
    const a = addFileItem('/a.png');
    const b = addFileItem('/b.png');

    controller.observeThumbnailItem(a);
    controller.observeThumbnailItem(b);

    expect(observers).toHaveLength(1);
    expect(observers[0].observed.has(a)).toBe(true);
    expect(observers[0].observed.has(b)).toBe(true);
  });

  it('does nothing when the scroll root is absent', () => {
    const { controller } = makeController();
    const orphan = addFileItem('/a.png');

    expect(() => controller.observeThumbnailItem(orphan, 'no-such-root')).not.toThrow();
    expect(observers).toHaveLength(0);
  });

  it('resetThumbnailObserver disconnects and forces a fresh observer', () => {
    const { controller } = makeController();
    controller.observeThumbnailItem(addFileItem('/a.png'));
    const first = observers[0];

    controller.resetThumbnailObserver();
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    controller.observeThumbnailItem(addFileItem('/b.png'));
    expect(observers).toHaveLength(2);
    expect(observers[1]).not.toBe(first);
  });

  it('disconnectThumbnailObserver disconnects but keeps the instance for reuse', () => {
    const { controller } = makeController();
    controller.observeThumbnailItem(addFileItem('/a.png'));
    const first = observers[0];

    controller.disconnectThumbnailObserver();
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    controller.observeThumbnailItem(addFileItem('/b.png'));
    // Same observer reused, so no new instance was constructed.
    expect(observers).toHaveLength(1);
  });

  it('loads and then unobserves an item that scrolls into view', async () => {
    const item = makeItem('/a.png');
    const { controller, deps } = makeController({ getFileByPath: vi.fn(() => item) });
    const fileItem = addFileItem('/a.png');
    controller.observeThumbnailItem(fileItem);

    intersect(observers[0], fileItem);

    await vi.waitFor(() => {
      expect(thumbnailOf(fileItem)).not.toBeNull();
    });
    expect(observers[0].unobserve).toHaveBeenCalledWith(fileItem);
    expect(deps.getFileByPath).toHaveBeenCalledWith('/a.png');
  });

  it('ignores entries that are not intersecting', () => {
    const { controller, deps } = makeController({ getFileByPath: vi.fn(() => makeItem('/a.png')) });
    const fileItem = addFileItem('/a.png');
    controller.observeThumbnailItem(fileItem);

    intersect(observers[0], fileItem, false);

    expect(deps.getFileByPath).not.toHaveBeenCalled();
    expect(observers[0].unobserve).not.toHaveBeenCalled();
  });

  it('ignores items that are not marked has-thumbnail', () => {
    const { controller } = makeController({ getFileByPath: vi.fn(() => makeItem('/a.txt')) });
    const fileItem = addFileItem('/a.txt', { hasThumbnail: false });
    controller.observeThumbnailItem(fileItem);

    intersect(observers[0], fileItem);

    expect(thumbnailOf(fileItem)).toBeNull();
    expect(observers[0].unobserve).not.toHaveBeenCalled();
  });

  it('ignores entries that arrive while the window is backgrounded', () => {
    const { controller, deps } = makeController({ getFileByPath: vi.fn(() => makeItem('/a.png')) });
    const fileItem = addFileItem('/a.png');
    controller.observeThumbnailItem(fileItem);
    activity.foreground = false;

    intersect(observers[0], fileItem);

    expect(deps.getFileByPath).not.toHaveBeenCalled();
  });
});

describe('thumbnail load path', () => {
  it('renders from the disk cache and remembers it in memory', async () => {
    const api = installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,disk',
      })),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');

    controller.loadThumbnail(fileItem, makeItem('/a.png'));

    await vi.waitFor(() => {
      expect(thumbnailOf(fileItem)?.getAttribute('src')).toBe('data:image/png;base64,disk');
    });
    expect(controller.getThumbnailForPath('/a.png')).toBe('data:image/png;base64,disk');
    expect(api.getCachedThumbnail).toHaveBeenCalledWith('/a.png', 1_700_000_000_000, 1024);
  });

  it('serves a second render from memory without touching the disk cache again', async () => {
    const api = installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,disk',
      })),
    });
    const { controller } = makeController();
    const first = addFileItem('/a.png');
    controller.loadThumbnail(first, makeItem('/a.png'));
    await vi.waitFor(() => expect(thumbnailOf(first)).not.toBeNull());
    expect(api.getCachedThumbnail).toHaveBeenCalledTimes(1);

    const second = addFileItem('/a.png');
    controller.loadThumbnail(second, makeItem('/a.png'));

    // Memory hit renders synchronously and must not re-query the disk cache.
    expect(thumbnailOf(second)?.getAttribute('src')).toBe('data:image/png;base64,disk');
    expect(api.getCachedThumbnail).toHaveBeenCalledTimes(1);
  });

  it('converts a Date mtime to milliseconds for the cache key', async () => {
    const api = installTauriApi();
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');
    const modified = new Date(1_700_000_000_000);

    controller.loadThumbnail(fileItem, makeItem('/a.png', { modified }));

    await vi.waitFor(() => {
      expect(api.getCachedThumbnail).toHaveBeenCalledWith('/a.png', modified.getTime(), 1024);
    });
  });

  it('falls back to the file URL when the disk cache misses, without re-saving it', async () => {
    const api = installTauriApi();
    const { controller } = makeController();
    const fileItem = addFileItem('/photos/a.png');

    controller.loadThumbnail(fileItem, makeItem('/photos/a.png'));

    await vi.waitFor(() => {
      expect(thumbnailOf(fileItem)?.getAttribute('src')).toBe('asset:///photos/a.png');
    });
    // Nothing was generated, so there is nothing worth persisting.
    expect(api.saveCachedThumbnail).not.toHaveBeenCalled();
  });

  it('persists a generated office thumbnail to the disk cache', async () => {
    const api = installTauriApi();
    const { controller } = makeController();
    const fileItem = addFileItem('/docs/report.docx', { thumbnailType: 'office' });

    controller.loadThumbnail(fileItem, makeItem('/docs/report.docx'));

    await vi.waitFor(() => {
      expect(thumbnailOf(fileItem)?.getAttribute('src')).toBe('data:image/png;base64,office');
    });
    expect(api.saveCachedThumbnail).toHaveBeenCalledWith(
      '/docs/report.docx',
      'data:image/png;base64,office',
      1_700_000_000_000,
      1024
    );
  });

  it('falls back to the file icon when office extraction fails', async () => {
    installTauriApi({
      getEmbeddedOfficeThumbnail: vi.fn(async () => ({ success: false, error: 'no thumbnail' })),
    });
    const { controller, deps } = makeController();
    const fileItem = addFileItem('/docs/report.docx', { thumbnailType: 'office' });

    controller.loadThumbnail(fileItem, makeItem('/docs/report.docx'));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.fallback-icon')).not.toBeNull();
    });
    expect(fileItem.classList.contains('has-thumbnail')).toBe(false);
    expect(deps.getFileIcon).toHaveBeenCalledWith('report.docx');
  });

  it('falls back to the file icon when PDF rendering fails', async () => {
    generatePdfThumbnailPdfJs.mockRejectedValue(new Error('pdfjs blew up'));
    const { controller } = makeController();
    const fileItem = addFileItem('/docs/a.pdf', { thumbnailType: 'pdf' });

    controller.loadThumbnail(fileItem, makeItem('/docs/a.pdf'));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.fallback-icon')).not.toBeNull();
    });
    expect(fileItem.classList.contains('has-thumbnail')).toBe(false);
  });

  it('passes the configured quality tier through to the PDF renderer', async () => {
    generatePdfThumbnailPdfJs.mockResolvedValue('data:image/png;base64,pdf');
    const { controller, settings } = makeController();
    settings.thumbnailQuality = 'high';
    const fileItem = addFileItem('/docs/a.pdf', { thumbnailType: 'pdf' });

    controller.loadThumbnail(fileItem, makeItem('/docs/a.pdf'));

    await vi.waitFor(() => {
      expect(generatePdfThumbnailPdfJs).toHaveBeenCalledWith('asset:///docs/a.pdf', 'high');
    });
  });

  it('skips images past the thumbnail size limit', async () => {
    const api = installTauriApi();
    const { controller } = makeController();
    const fileItem = addFileItem('/huge.png');

    controller.loadThumbnail(fileItem, makeItem('/huge.png', { size: 11 * 1024 * 1024 }));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.fallback-icon')).not.toBeNull();
    });
    expect(fileItem.classList.contains('has-thumbnail')).toBe(false);
    // Bailed before any IPC.
    expect(api.getCachedThumbnail).not.toHaveBeenCalled();
  });

  it('skips PDFs past the preview size limit, not the thumbnail limit', async () => {
    const api = installTauriApi();
    const { controller } = makeController();
    const fileItem = addFileItem('/huge.pdf', { thumbnailType: 'pdf' });

    // 20MB is over the 10MB thumbnail cap but under the 50MB preview cap.
    controller.loadThumbnail(fileItem, makeItem('/huge.pdf', { size: 20 * 1024 * 1024 }));
    await vi.waitFor(() => expect(api.getCachedThumbnail).toHaveBeenCalled());
    expect(fileItem.classList.contains('has-thumbnail')).toBe(true);

    const tooBig = addFileItem('/enormous.pdf', { thumbnailType: 'pdf' });
    controller.loadThumbnail(tooBig, makeItem('/enormous.pdf', { size: 60 * 1024 * 1024 }));
    await vi.waitFor(() => {
      expect(tooBig.querySelector('.fallback-icon')).not.toBeNull();
    });
    expect(tooBig.classList.contains('has-thumbnail')).toBe(false);
  });

  it('abandons a load whose file item has been detached from the grid', async () => {
    const api = installTauriApi();
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');
    fileItem.remove();

    controller.loadThumbnail(fileItem, makeItem('/a.png'));
    await Promise.resolve();
    await Promise.resolve();

    expect(thumbnailOf(fileItem)).toBeNull();
    expect(api.getCachedThumbnail).not.toHaveBeenCalled();
  });

  it('de-duplicates concurrent loads for the same path', async () => {
    let release!: (value: { success: boolean; dataUrl: string }) => void;
    const api = installTauriApi({
      getCachedThumbnail: vi.fn(
        () =>
          new Promise<{ success: boolean; dataUrl: string }>((resolve) => {
            release = resolve;
          })
      ),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');

    controller.loadThumbnail(fileItem, makeItem('/a.png'));
    controller.loadThumbnail(fileItem, makeItem('/a.png'));
    controller.loadThumbnail(fileItem, makeItem('/a.png'));
    await vi.waitFor(() => expect(api.getCachedThumbnail).toHaveBeenCalled());

    expect(api.getCachedThumbnail).toHaveBeenCalledTimes(1);

    release({ success: true, dataUrl: 'data:image/png;base64,done' });
    await vi.waitFor(() => expect(thumbnailOf(fileItem)).not.toBeNull());
  });

  it('falls back to the file icon when the cache lookup throws', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => {
        throw new Error('ipc down');
      }),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');

    controller.loadThumbnail(fileItem, makeItem('/a.png'));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.fallback-icon')).not.toBeNull();
    });
    expect(fileItem.classList.contains('has-thumbnail')).toBe(false);
  });

  it('keeps has-thumbnail when a media decode is deferred for being backgrounded', async () => {
    const { controller } = makeController();
    const fileItem = addFileItem('/clip.mp4', { thumbnailType: 'video' });
    activity.foreground = false;

    controller.loadThumbnail(fileItem, makeItem('/clip.mp4'));

    await vi.waitFor(() => {
      expect(fileItem.querySelector('.fallback-icon')).not.toBeNull();
    });
    // Unlike the oversize path, the marker stays so resume can re-drive it.
    expect(fileItem.classList.contains('has-thumbnail')).toBe(true);
  });
});

describe('rendered thumbnail element', () => {
  it('fades the image in once it loads', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,x',
      })),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');

    controller.loadThumbnail(fileItem, makeItem('/a.png'));
    await vi.waitFor(() => expect(thumbnailOf(fileItem)).not.toBeNull());

    const img = thumbnailOf(fileItem)!;
    expect(img.style.opacity).toBe('0');
    expect(img.alt).toBe('a.png');
    expect(img.loading).toBe('lazy');

    img.dispatchEvent(new Event('load'));
    expect(img.style.opacity).toBe('1');
  });

  it('tags animated formats so hover can swap to the moving source', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/gif;base64,still',
      })),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/loop.gif');

    controller.loadThumbnail(fileItem, makeItem('/loop.gif'));
    await vi.waitFor(() => expect(thumbnailOf(fileItem)).not.toBeNull());

    const img = thumbnailOf(fileItem)!;
    expect(img.dataset.animated).toBe('true');
    expect(img.dataset.staticSrc).toBe('data:image/gif;base64,still');
    expect(img.dataset.animatedSrc).toBe('asset:///loop.gif');
  });

  it('leaves still formats untagged', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,x',
      })),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/still.png');

    controller.loadThumbnail(fileItem, makeItem('/still.png'));
    await vi.waitFor(() => expect(thumbnailOf(fileItem)).not.toBeNull());

    expect(thumbnailOf(fileItem)!.dataset.animated).toBeUndefined();
  });

  it('falls back to the file icon when the rendered image fails to decode', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,x',
      })),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/broken.png');

    controller.loadThumbnail(fileItem, makeItem('/broken.png'));
    await vi.waitFor(() => expect(thumbnailOf(fileItem)).not.toBeNull());

    thumbnailOf(fileItem)!.dispatchEvent(new Event('error'));

    expect(fileItem.querySelector('.fallback-icon')).not.toBeNull();
    expect(fileItem.classList.contains('has-thumbnail')).toBe(false);
  });
});

describe('thumbnail cache', () => {
  it('clears cached entries on request', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,x',
      })),
    });
    const { controller } = makeController();
    const fileItem = addFileItem('/a.png');
    controller.loadThumbnail(fileItem, makeItem('/a.png'));
    await vi.waitFor(() => expect(controller.getThumbnailForPath('/a.png')).toBeDefined());

    controller.clearThumbnailCache();
    expect(controller.getThumbnailForPath('/a.png')).toBeUndefined();
  });

  it('evicts the oldest entry once the cache ceiling is reached', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async (path: string) => ({
        success: true,
        dataUrl: `data:image/png;base64,${path}`,
      })),
    });
    const { controller } = makeController();
    const paths = Array.from({ length: 100 }, (_, i) => `/f${i}.png`);

    // Cache ceiling is 100 entries. Fire them all and wait once rather than
    // polling per item, which otherwise dominates this file's runtime.
    paths.forEach((path) => controller.loadThumbnail(addFileItem(path), makeItem(path)));
    await vi.waitFor(
      () => {
        expect(paths.filter((p) => controller.getThumbnailForPath(p) !== undefined)).toHaveLength(
          100
        );
      },
      { timeout: 10_000, interval: 10 }
    );

    controller.loadThumbnail(addFileItem('/overflow.png'), makeItem('/overflow.png'));
    await vi.waitFor(() => expect(controller.getThumbnailForPath('/overflow.png')).toBeDefined(), {
      interval: 10,
    });

    // Exactly one of the original hundred was dropped to make room, and it was not
    // the most recent one.
    const surviving = paths.filter((p) => controller.getThumbnailForPath(p) !== undefined);
    expect(surviving).toHaveLength(99);
    expect(controller.getThumbnailForPath('/f99.png')).toBeDefined();
  }, 20_000);
});

describe('background pause and resume', () => {
  /** Saturates the 4 concurrent slots so further loads land in the pending queue. */
  function stallCacheLookups() {
    const releases: Array<(value: { success: boolean; dataUrl: string }) => void> = [];
    const api = installTauriApi({
      getCachedThumbnail: vi.fn(
        () =>
          new Promise<{ success: boolean; dataUrl: string }>((resolve) => {
            releases.push(resolve);
          })
      ),
    });
    return { api, releases };
  }

  it('drops queued work when the window goes to the background', async () => {
    const { api, releases } = stallCacheLookups();
    const { controller } = makeController();

    const items = Array.from({ length: 6 }, (_, i) => {
      const fileItem = addFileItem(`/q${i}.png`);
      controller.loadThumbnail(fileItem, makeItem(`/q${i}.png`));
      return fileItem;
    });

    // Four loads run concurrently; the last two are queued behind them.
    await vi.waitFor(() => expect(api.getCachedThumbnail).toHaveBeenCalledTimes(4));

    activity.foreground = false;
    activity.listeners.forEach((listener) => listener(false, 'test-blur'));

    releases.forEach((release) => release({ success: true, dataUrl: 'data:image/png;base64,x' }));
    await vi.waitFor(() => expect(thumbnailOf(items[0])).not.toBeNull());

    // The queued pair was discarded rather than starting after the flush.
    expect(api.getCachedThumbnail).toHaveBeenCalledTimes(4);
    expect(thumbnailOf(items[4])).toBeNull();
    expect(thumbnailOf(items[5])).toBeNull();
  });

  it('re-drives observers for un-rendered items when the window returns', () => {
    const { controller } = makeController();
    const pending = addFileItem('/pending.png');
    controller.observeThumbnailItem(pending);
    const observer = observers[0];
    observer.observe.mockClear();
    observer.unobserve.mockClear();

    activity.listeners.forEach((listener) => listener(false, 'test-blur'));
    activity.foreground = true;
    activity.listeners.forEach((listener) => listener(true, 'test-focus'));

    expect(observer.unobserve).toHaveBeenCalledWith(pending);
    expect(observer.observe).toHaveBeenCalledWith(pending);
  });

  it('leaves already-rendered items alone when the window returns', async () => {
    installTauriApi({
      getCachedThumbnail: vi.fn(async () => ({
        success: true,
        dataUrl: 'data:image/png;base64,x',
      })),
    });
    const { controller } = makeController();
    const done = addFileItem('/done.png');
    controller.observeThumbnailItem(done);
    controller.loadThumbnail(done, makeItem('/done.png'));
    await vi.waitFor(() => expect(thumbnailOf(done)).not.toBeNull());

    const observer = observers[0];
    observer.observe.mockClear();

    activity.listeners.forEach((listener) => listener(false, 'test-blur'));
    activity.listeners.forEach((listener) => listener(true, 'test-focus'));

    expect(observer.observe).not.toHaveBeenCalled();
  });

  it('ignores a repeated pause and a resume that was never paused', () => {
    const { controller } = makeController();
    controller.observeThumbnailItem(addFileItem('/a.png'));
    const observer = observers[0];

    // Not paused yet, so resume must be a no-op.
    controller.resumeThumbnails();
    expect(observer.observe).toHaveBeenCalledTimes(1);

    expect(() => {
      controller.pauseThumbnails();
      controller.pauseThumbnails();
    }).not.toThrow();
  });

  it('stops reacting to activity once destroyed', () => {
    const { controller } = makeController();
    controller.observeThumbnailItem(addFileItem('/a.png'));
    const observer = observers[0];

    controller.destroy();
    observer.observe.mockClear();

    activity.listeners.forEach((listener) => listener(false, 'test-blur'));
    activity.listeners.forEach((listener) => listener(true, 'test-focus'));

    expect(observer.observe).not.toHaveBeenCalled();
  });
});

describe('updateThumbnailCacheSize', () => {
  it('reports the cache size and file count', async () => {
    const { controller } = makeController();
    await controller.updateThumbnailCacheSize();
    expect(document.getElementById('thumbnail-cache-size')?.textContent).toBe('(2048 B, 7 files)');
  });

  it('clears the label when the size lookup fails', async () => {
    installTauriApi({ getThumbnailCacheSize: vi.fn(async () => ({ success: false })) });
    const label = document.getElementById('thumbnail-cache-size')!;
    label.textContent = 'stale';
    const { controller } = makeController();

    await controller.updateThumbnailCacheSize();
    expect(label.textContent).toBe('');
  });

  it('does not query the backend when the label is absent', async () => {
    document.getElementById('thumbnail-cache-size')!.remove();
    const api = installTauriApi();
    const { controller } = makeController();

    await controller.updateThumbnailCacheSize();
    expect(api.getThumbnailCacheSize).not.toHaveBeenCalled();
  });
});
