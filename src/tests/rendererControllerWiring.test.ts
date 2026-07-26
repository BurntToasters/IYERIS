// @vitest-environment jsdom
//
// F1 (composition layer): rendererControllerWiring.ts is the dependency-injection
// seam that assembles ~50 individually unit-tested controllers into the app. Every
// controller suite builds its own hand-rolled deps object, so a mismatch between a
// controller's real dependency contract and what the wiring actually passes it
// would keep all of those suites green and only surface at runtime.
//
// These tests run the real wireControllers() against the real src/index.html DOM
// with only the Tauri IPC boundary stubbed, and assert the producer/consumer
// contract with renderer.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Settings, FileItem } from '../types';

const RENDERER_SRC_PATH = resolve(process.cwd(), 'src/renderer.ts');
const WIRING_SRC_PATH = resolve(process.cwd(), 'src/rendererControllerWiring.ts');

function mountRealIndexBody(): void {
  const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new Error('src/index.html has no <body> element');
  document.body.innerHTML = body[1];
}

// wireControllers pulls in ~50 controller modules; under v8 coverage
// instrumentation that import graph plus the real DOM exceeds the default
// 10s hook timeout, so this one-time setup gets explicit headroom.
const SETUP_TIMEOUT_MS = 120_000;

/** Names renderer.ts destructures out of `wireControllers(...)`. */
function readWiringConsumerNames(): string[] {
  const src = readFileSync(RENDERER_SRC_PATH, 'utf8');
  const block = src.match(/const \{([\s\S]*?)\} = wired;/);
  if (!block) throw new Error('renderer.ts no longer destructures `wired`');
  return block[1]
    .split(',')
    .map((entry) => entry.split(':')[0].trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith('//'));
}

/** Method names declared on the LateBound interface. */
function readLateBoundMembers(): string[] {
  const src = readFileSync(WIRING_SRC_PATH, 'utf8');
  const block = src.match(/export interface LateBound \{([\s\S]*?)\n\}/);
  if (!block) throw new Error('LateBound interface not found in rendererControllerWiring.ts');
  return [...block[1].matchAll(/^\s*(\w+)\(/gm)].map((match) => match[1]);
}

/** Auto-stubbing stand-in for the whole Tauri IPC surface. */
function installTauriApiStub() {
  const cache = new Map<string, any>();
  const stub = new Proxy({} as any, {
    get(_target, prop: string) {
      if (prop === 'getWindowLabel') return () => 'main';
      if (!cache.has(prop)) {
        cache.set(
          prop,
          prop.startsWith('on')
            ? vi.fn(() => () => {})
            : vi.fn(async () => ({ success: true, data: [] }))
        );
      }
      return cache.get(prop);
    },
    has: () => true,
  });
  (window as any).tauriAPI = stub;
  return stub;
}

describe('rendererControllerWiring composition', () => {
  let wired: Record<string, unknown>;
  let api: any;
  let ipcCleanups: (() => void)[];
  let consumerNames: string[];
  let settings: Settings;
  let currentPath: string;
  let allFiles: FileItem[];
  const late: Record<string, unknown> = {};

  beforeAll(async () => {
    mountRealIndexBody();
    api = installTauriApiStub();
    ipcCleanups = [];
    consumerNames = readWiringConsumerNames();

    const { createDefaultSettings } = await import('../settings');
    const { wireControllers } = await import('../rendererControllerWiring');

    settings = createDefaultSettings();
    currentPath = '/home/user';
    allFiles = [];
    let selectedItems = new Set<string>();

    wired = wireControllers({
      getCurrentPath: () => currentPath,
      getSearchScopePath: () => currentPath,
      getSearchScopeLabel: () => 'files',
      setCurrentPath: (value) => {
        currentPath = value;
      },
      getCurrentSettings: () => settings,
      setCurrentSettings: (value) => {
        settings = value;
      },
      getSelectedItems: () => selectedItems,
      setSelectedItems: (value) => {
        selectedItems = value;
      },
      clearSelectedItemsState: () => selectedItems.clear(),
      markSelectionDirty: () => {},
      getAllFiles: () => allFiles,
      setAllFiles: (value) => {
        allFiles = value;
      },
      getViewMode: () => 'grid',
      getPlatformOS: () => 'linux',
      getHistory: () => [],
      setHistory: () => {},
      getHistoryIndex: () => 0,
      setHistoryIndex: () => {},
      getTabs: () => [],
      setTabs: () => {},
      getActiveTabId: () => 'tab-1',
      setActiveTabId: () => {},
      getTabsEnabled: () => false,
      setTabsEnabled: () => {},
      getTabNewButtonListenerAttached: () => false,
      setTabNewButtonListenerAttached: () => {},
      getTabCacheAccessOrder: () => [],
      setTabCacheAccessOrder: () => {},
      getSaveTabStateTimeout: () => null,
      setSaveTabStateTimeout: () => {},
      getFileViewScrollTop: () => 0,
      setFileViewScrollTop: () => {},
      saveSettingsWithTimestamp: async () => ({ success: true }),
      debouncedSaveSettings: () => {},
      getFileElementMap: () => new Map<string, HTMLElement>(),
      getDriveLabelByPath: () => new Map<string, string>(),
      getCachedDriveInfo: () => [],
      cacheDriveInfo: () => {},
      getIpcCleanupFunctions: () => ipcCleanups,
      isMainWindow: true,
      late: late as any,
    }) as unknown as Record<string, unknown>;
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    ipcCleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch {
        /* cleanup errors are not this suite's concern */
      }
    });
    ipcCleanups.length = 0;
    vi.restoreAllMocks();
  });

  it('constructs every controller against the shipped DOM without throwing', () => {
    expect(wired).toBeTruthy();
    expect(Object.keys(wired).length).toBeGreaterThan(200);
  });

  it('leaves no wired binding undefined', () => {
    const undefinedBindings = Object.entries(wired)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    expect(undefinedBindings).toEqual([]);
  });

  it('provides every binding renderer.ts destructures from the wiring', () => {
    expect(consumerNames.length).toBeGreaterThan(100);
    const missing = consumerNames.filter((name) => !(name in wired));
    expect(missing).toEqual([]);
  });

  it('binds renderer.ts consumers to callable controllers, not bare values', () => {
    const nonCallable = consumerNames.filter((name) => {
      const value = wired[name];
      return typeof value !== 'function' && typeof value !== 'object';
    });
    expect(nonCallable).toEqual([]);
  });

  it('has every LateBound member assigned by renderer.ts', () => {
    const members = readLateBoundMembers();
    expect(members.length).toBeGreaterThan(10);
    const rendererSrc = readFileSync(RENDERER_SRC_PATH, 'utf8');
    const unassigned = members.filter(
      (member) => !new RegExp(`late\\.${member}\\s*=`).test(rendererSrc)
    );
    expect(unassigned).toEqual([]);
  });

  it('registers IPC listeners and hands their cleanups to the renderer', () => {
    expect(ipcCleanups.length).toBeGreaterThan(0);
    expect(ipcCleanups.every((cleanup) => typeof cleanup === 'function')).toBe(true);
    expect(api.onDirectoryContentsProgress).toHaveBeenCalled();
  });

  it('wires the directory loader to the real loading and empty-state elements', () => {
    const loading = document.getElementById('loading')!;
    const loadingText = document.getElementById('loading-text')!;
    const emptyState = document.getElementById('empty-state')!;
    emptyState.style.display = 'flex';

    (wired.showLoading as (context?: string) => void)('Scanning archive...');
    expect(loading.style.display).toBe('flex');
    expect(loadingText.textContent).toBe('Scanning archive...');
    expect(emptyState.style.display).toBe('none');

    (wired.hideLoading as () => void)();
    expect(loading.style.display).toBe('none');
    expect(loadingText.textContent).toBe('Loading...');
  });

  it('routes directory progress IPC events into the real loading text', () => {
    const loadingText = document.getElementById('loading-text')!;
    const onProgress = api.onDirectoryContentsProgress.mock.calls[0][0] as (p: {
      operationId?: string;
      dirPath?: string;
      loaded: number;
    }) => void;

    const { operationId } = (
      wired.startDirectoryRequest as (p: string) => { requestId: number; operationId: string }
    )('/home/user/big');

    onProgress({ operationId, dirPath: '/home/user/big', loaded: 1234 });
    expect(loadingText.textContent).toBe('Loading... (1,234 items)');

    // A progress event from a superseded operation must not touch the UI.
    loadingText.textContent = 'untouched';
    onProgress({ operationId: 'dir-stale', dirPath: '/home/user/big', loaded: 9999 });
    expect(loadingText.textContent).toBe('untouched');
  });

  it('cancels the in-flight native request when a new directory request starts', async () => {
    const first = (
      wired.startDirectoryRequest as (p: string) => { requestId: number; operationId: string }
    )('/first');
    (wired.startDirectoryRequest as (p: string) => { requestId: number; operationId: string })(
      '/second'
    );
    expect(api.cancelDirectoryContents).toHaveBeenCalledWith(first.operationId);
  });

  it('tracks request currency so stale directory responses can be discarded', () => {
    const loader = wired.directoryLoader as {
      startRequest: (p: string) => { requestId: number };
      isCurrentRequest: (id: number) => boolean;
    };
    const stale = loader.startRequest('/stale');
    const current = loader.startRequest('/current');
    expect(loader.isCurrentRequest(stale.requestId)).toBe(false);
    expect(loader.isCurrentRequest(current.requestId)).toBe(true);
  });
});
