// @vitest-environment jsdom
//
// F3 (escaping integration): production interpolates user-controlled data into
// innerHTML at a number of boundaries and relies on escapeHtml() /
// sanitizeMarkdownHtml() to neutralize it. Every module suite for those
// boundaries replaces escapeHtml with an identity function
// (`vi.mock('../shared.js', () => ({ escapeHtml: (s) => s }))`) and never feeds
// HTML-bearing input, so dropping an escapeHtml() call at any one of them would
// keep those suites green.
//
// This suite is the counterweight: it deliberately does NOT mock ../shared.js,
// so the real escaping runs, and it pushes an active payload through each
// boundary asserting the rendered markup is inert and the payload survives as
// visible text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Payloads that become live nodes if interpolated unescaped. */
const IMG_PAYLOAD = '<img src=x onerror="globalThis.__xssFired = true">';
const SCRIPT_PAYLOAD = '<script>globalThis.__xssFired = true</script>';
/** Breaks out of a double-quoted attribute value. */
const ATTR_PAYLOAD = '" onmouseover="globalThis.__xssFired = true" data-x="';

function xssFired(): boolean {
  return (globalThis as Record<string, unknown>).__xssFired === true;
}

/**
 * Asserts the payload produced no executable markup. Note that jsdom does not
 * run inline handlers or load `src`, so the presence of the *node* (or the
 * attribute) is the oracle here, not whether it fired.
 */
function expectInert(root: ParentNode): void {
  expect(root.querySelector('script')).toBeNull();
  expect(root.querySelector('[onerror]')).toBeNull();
  expect(root.querySelector('[onmouseover]')).toBeNull();
  expect(root.querySelector('[onload]')).toBeNull();
  expect(xssFired()).toBe(false);
}

/** Asserts the payload is present, but only as inert text. */
function expectRenderedAsText(root: ParentNode, payload: string): void {
  expectInert(root);
  expect((root as HTMLElement).textContent ?? '').toContain(payload);
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__xssFired;
  document.body.replaceChildren();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__xssFired;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('escapeHtml is real and neutralizes markup', () => {
  it('escapes every HTML-significant character', async () => {
    const { escapeHtml } = await import('../shared');
    expect(escapeHtml(IMG_PAYLOAD)).toBe(
      '&lt;img src=x onerror=&quot;globalThis.__xssFired = true&quot;&gt;'
    );
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
  });

  it('is not the identity function this suite is guarding against', async () => {
    const { escapeHtml } = await import('../shared');
    expect(escapeHtml(IMG_PAYLOAD)).not.toBe(IMG_PAYLOAD);
  });
});

describe('toast boundary (rendererToasts innerHTML)', () => {
  async function showToast(message: string, title = '', type = 'info') {
    const { createToastManager } = await import('../rendererToasts');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const manager = createToastManager({
      durationMs: 3000,
      maxVisible: 3,
      getContainer: () => container,
      // Benign stand-in so the icon markup cannot be confused for injected markup.
      twemojiImg: (name: string) => `<span data-icon="${name}"></span>`,
    });
    manager.showToast(message, title, type as 'info');
    return container;
  }

  it('renders a scripted toast message as text', async () => {
    const container = await showToast(IMG_PAYLOAD);
    expectRenderedAsText(container, IMG_PAYLOAD);
    expect(container.querySelector('.toast-message')?.textContent).toBe(IMG_PAYLOAD);
  });

  it('renders a scripted toast title as text', async () => {
    const container = await showToast('harmless body', SCRIPT_PAYLOAD);
    expectRenderedAsText(container, SCRIPT_PAYLOAD);
    expect(container.querySelector('.toast-title')?.textContent).toBe(SCRIPT_PAYLOAD);
  });

  it('keeps an attribute-breaking payload inside the message text', async () => {
    const container = await showToast(ATTR_PAYLOAD);
    expectInert(container);
    expect(container.querySelector('.toast-message')?.textContent).toBe(ATTR_PAYLOAD);
  });
});

describe('tab label boundary (rendererTabs innerHTML)', () => {
  async function renderTabWithFolderName(folderName: string) {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `<div id="tab-bar"><div id="tab-list"></div><button id="new-tab-btn"></button></div>`;
    (window as any).tauriAPI = {
      getItemProperties: vi.fn().mockResolvedValue({ success: true }),
      watchDirectory: vi.fn().mockResolvedValue({ success: true }),
    };

    const { createTabsController } = await import('../rendererTabs');
    const settings: any = { enableTabs: true, startupPath: '', tabState: undefined };
    let tabs: any[] = [];
    let activeTabId = '';
    let tabsEnabled = false;
    let newBtnAttached = false;
    let cacheAccessOrder: string[] = [];
    let saveTimeout: ReturnType<typeof setTimeout> | null = null;
    const maliciousPath = `/home/user/${folderName}`;
    let currentPath = maliciousPath;

    const controller = createTabsController({
      getTabs: () => tabs,
      setTabs: (t: any[]) => {
        tabs = t;
      },
      getActiveTabId: () => activeTabId,
      setActiveTabId: (id: string) => {
        activeTabId = id;
      },
      getTabsEnabled: () => tabsEnabled,
      setTabsEnabled: (v: boolean) => {
        tabsEnabled = v;
      },
      getTabNewButtonListenerAttached: () => newBtnAttached,
      setTabNewButtonListenerAttached: (v: boolean) => {
        newBtnAttached = v;
      },
      getTabCacheAccessOrder: () => cacheAccessOrder,
      setTabCacheAccessOrder: (o: string[]) => {
        cacheAccessOrder = o;
      },
      getSaveTabStateTimeout: () => saveTimeout,
      setSaveTabStateTimeout: (t: any) => {
        saveTimeout = t;
      },
      getCurrentSettings: () => settings,
      getCurrentPath: () => currentPath,
      setCurrentPath: (p: string) => {
        currentPath = p;
      },
      getHistory: () => [maliciousPath],
      setHistory: () => {},
      getHistoryIndex: () => 0,
      setHistoryIndex: () => {},
      getSelectedItems: () => new Set<string>(),
      setSelectedItems: () => {},
      getAllFiles: () => [],
      setAllFiles: () => {},
      getFileViewScrollTop: () => 0,
      setFileViewScrollTop: () => {},
      getAddressInput: () => document.createElement('input'),
      getPathDisplayValue: (p: string) => p,
      isHomeViewPath: (p: string) => p === '~~HOME~~',
      homeViewLabel: 'Home',
      homeViewPath: '~~HOME~~',
      getViewMode: () => 'grid' as const,
      renderFiles: vi.fn(),
      renderColumnView: vi.fn(),
      updateBreadcrumb: vi.fn(),
      updateNavigationButtons: vi.fn(),
      setHomeViewActive: vi.fn(),
      navigateTo: vi.fn(),
      watchDirectory: vi.fn(),
      debouncedSaveSettings: vi.fn(),
      saveSettingsWithTimestamp: vi.fn().mockResolvedValue(undefined),
      maxCachedTabs: 5,
      maxCachedFilesPerTab: 500,
      isMainWindow: true,
    } as any);

    controller.initializeTabs();
    return document.getElementById('tab-list')!;
  }

  it('renders a scripted folder name as tab text, not markup', async () => {
    const tabList = await renderTabWithFolderName(IMG_PAYLOAD);
    expectInert(tabList);
    expect(tabList.querySelector('.tab-title')?.textContent).toBe(IMG_PAYLOAD);
  });

  it('escapes the tab title attribute so it cannot break out', async () => {
    const tabList = await renderTabWithFolderName(ATTR_PAYLOAD);
    expectInert(tabList);
    const title = tabList.querySelector('.tab-title') as HTMLElement;
    // The whole payload must land inside the attribute value, not become new attributes.
    expect(title.getAttribute('title')).toContain(ATTR_PAYLOAD);
    expect(title.hasAttribute('onmouseover')).toBe(false);
    expect(title.hasAttribute('data-x')).toBe(false);
  });
});

describe('navigation boundaries (rendererNavigation innerHTML)', () => {
  function setupNavDom() {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div class="address-bar-wrapper">
        <div class="address-bar">
          <div id="breadcrumb-container" class="breadcrumb" style="display:inline-flex"></div>
          <input id="address-input" style="display:none" />
        </div>
        <div id="breadcrumb-menu" style="display:none" role="menu"></div>
      </div>
      <div id="directory-history-dropdown" style="display:none"></div>
    `;
  }

  async function createController(overrides: {
    currentPath?: string;
    directoryHistory?: string[];
  }) {
    const { createNavigationController } = await import('../rendererNavigation');
    const settings: any = {
      enableSearchHistory: true,
      directoryHistory: overrides.directoryHistory ?? [],
      showHiddenFiles: true,
    };
    const deps: any = {
      getCurrentPath: () => overrides.currentPath ?? '/workspace',
      getCurrentSettings: () => settings,
      getBreadcrumbContainer: () => document.getElementById('breadcrumb-container'),
      getBreadcrumbMenu: () => document.getElementById('breadcrumb-menu'),
      getAddressInput: () => document.getElementById('address-input'),
      getPathDisplayValue: (p: string) => p,
      isHomeViewPath: (p: string) => p === 'home-view',
      homeViewLabel: 'Home',
      homeViewPath: 'home-view',
      navigateTo: vi.fn(),
      createDirectoryOperationId: vi.fn(() => 'op-1'),
      nameCollator: new Intl.Collator(),
      // Benign icon so injected markup cannot hide behind the icon output.
      getFolderIcon: () => '<span data-icon="folder"></span>',
      getDragOperation: vi.fn(() => 'copy' as const),
      showDropIndicator: vi.fn(),
      hideDropIndicator: vi.fn(),
      getDraggedPaths: vi.fn(async () => []),
      handleDrop: vi.fn(async () => {}),
      debouncedSaveSettings: vi.fn(),
      saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
      showToast: vi.fn(),
      directoryHistoryMax: 10,
    };
    return { controller: createNavigationController(deps), deps, settings };
  }

  it('renders a scripted subfolder name in the breadcrumb menu as text', async () => {
    setupNavDom();
    (window as any).tauriAPI = {
      getDirectoryContents: vi.fn().mockResolvedValue({
        success: true,
        contents: [
          {
            name: IMG_PAYLOAD,
            path: `/workspace/${IMG_PAYLOAD}`,
            isDirectory: true,
            isFile: false,
            isHidden: false,
          },
        ],
      }),
    };

    const { controller } = await createController({ currentPath: '/workspace' });
    const anchor = document.createElement('button');
    document.getElementById('breadcrumb-container')!.appendChild(anchor);

    await controller.showBreadcrumbMenu('/workspace', anchor);

    const menu = document.getElementById('breadcrumb-menu')!;
    expectRenderedAsText(menu, IMG_PAYLOAD);
  });

  it('renders scripted path segments in the collapsed breadcrumb menu as text', async () => {
    setupNavDom();
    (window as any).tauriAPI = { getDirectoryContents: vi.fn() };
    const maliciousPath = `/home/${IMG_PAYLOAD}/deep/leaf`;

    const { controller } = await createController({ currentPath: maliciousPath });
    controller.updateBreadcrumb(maliciousPath);

    const container = document.getElementById('breadcrumb-container')!;
    const overflow = document.createElement('button');
    overflow.className = 'breadcrumb-overflow';
    container.appendChild(overflow);
    overflow.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const menu = document.getElementById('breadcrumb-menu')!;
    expect(menu.style.display).toBe('block');
    expectRenderedAsText(menu, IMG_PAYLOAD);
  });

  it('escapes the data-path attribute in the directory history dropdown', async () => {
    setupNavDom();
    (window as any).tauriAPI = { getDirectoryContents: vi.fn() };
    const maliciousPath = `/home/${ATTR_PAYLOAD}`;

    const { controller } = await createController({ directoryHistory: [maliciousPath] });
    controller.showDirectoryHistoryDropdown();

    const dropdown = document.getElementById('directory-history-dropdown')!;
    expectInert(dropdown);
    const item = dropdown.querySelector('.history-item') as HTMLElement;
    expect(item.getAttribute('data-path')).toBe(maliciousPath);
    expect(item.hasAttribute('onmouseover')).toBe(false);
    expect(item.hasAttribute('data-x')).toBe(false);
  });
});

describe('search boundaries (rendererSearch innerHTML)', () => {
  function setupSearchDom() {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <button id="search-btn"></button>
      <input id="search-input" />
      <button id="search-close"></button>
      <div id="search-history-dropdown" style="display:none"></div>
      <div id="file-grid"></div>
    `;
  }

  async function createController(settingsOverrides: Record<string, unknown> = {}) {
    const { createSearchController } = await import('../rendererSearch');
    const settings: any = {
      enableSearchHistory: true,
      searchHistory: [],
      savedSearches: [],
      maxSearchHistoryItems: 10,
      globalContentSearch: false,
      ...settingsOverrides,
    };
    const deps: any = {
      getCurrentPath: () => '/workspace',
      getCurrentSettings: () => settings,
      setAllFiles: vi.fn(),
      renderFiles: vi.fn(),
      showLoading: vi.fn(),
      hideLoading: vi.fn(),
      updateStatusBar: vi.fn(),
      showToast: vi.fn(),
      createDirectoryOperationId: vi.fn(() => 'op-1'),
      navigateTo: vi.fn(),
      debouncedSaveSettings: vi.fn(),
      saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
      getFileGrid: () => document.getElementById('file-grid'),
      setHomeViewActive: vi.fn(),
      searchDebounceMs: 200,
      searchHistoryMax: 10,
    };
    return { controller: createSearchController(deps), deps, settings };
  }

  it('renders a scripted search query in the empty state as text', async () => {
    setupSearchDom();
    (window as any).tauriAPI = {
      searchFiles: vi.fn().mockResolvedValue({ success: true, results: [] }),
      cancelSearch: vi.fn().mockResolvedValue({ success: true }),
    };

    const { controller } = await createController();
    (document.getElementById('search-input') as HTMLInputElement).value = IMG_PAYLOAD;

    await controller.performSearch();

    const grid = document.getElementById('file-grid')!;
    expect(grid.querySelector('.search-empty-state')).not.toBeNull();
    expectRenderedAsText(grid, IMG_PAYLOAD);
  });

  it('escapes the data-query attribute in the search history dropdown', async () => {
    setupSearchDom();
    (window as any).tauriAPI = {};
    const { controller } = await createController({ searchHistory: [ATTR_PAYLOAD] });

    controller.showSearchHistoryDropdown();

    const dropdown = document.getElementById('search-history-dropdown')!;
    expectInert(dropdown);
    const item = dropdown.querySelector('.history-item') as HTMLElement;
    expect(item.getAttribute('data-query')).toBe(ATTR_PAYLOAD);
    expect(item.hasAttribute('onmouseover')).toBe(false);
  });

  it('escapes saved-search names in both text and title/aria attributes', async () => {
    setupSearchDom();
    (window as any).tauriAPI = {};
    const { controller } = await createController({
      savedSearches: [
        {
          name: IMG_PAYLOAD,
          query: ATTR_PAYLOAD,
          isGlobal: false,
          isRegex: false,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    controller.showSearchHistoryDropdown();

    const dropdown = document.getElementById('search-history-dropdown')!;
    expectInert(dropdown);
    const name = dropdown.querySelector('.saved-search-name') as HTMLElement;
    expect(name.textContent).toBe(IMG_PAYLOAD);
    expect(name.getAttribute('title')).toContain(ATTR_PAYLOAD);
    const deleteBtn = dropdown.querySelector('.saved-search-delete') as HTMLElement;
    expect(deleteBtn.getAttribute('aria-label')).toContain(IMG_PAYLOAD);
  });
});

describe('licenses boundary (rendererSupportUi innerHTML)', () => {
  async function renderLicenses(getLicenses: () => Promise<unknown>) {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="licenses-modal"><div id="licenses-content"></div><span id="total-deps"></span></div>
    `;
    Object.defineProperty(window, 'tauriAPI', {
      value: { getLicenses },
      configurable: true,
      writable: true,
    });

    const { createSupportUiController } = await import('../rendererSupportUi');
    const { escapeHtml, getErrorMessage } = await import('../shared');
    const controller = createSupportUiController({
      activateModal: vi.fn(),
      deactivateModal: vi.fn(),
      // The real escaping, not the identity stub the module suites use.
      escapeHtml,
      getErrorMessage,
      getCurrentSettings: () => ({}) as any,
      saveSettingsWithTimestamp: vi.fn(async () => ({ success: true as const })),
      openExternal: vi.fn(),
    } as any);

    await controller.showLicensesModal();
    return document.getElementById('licenses-content')!;
  }

  it('renders a scripted package name as text', async () => {
    const content = await renderLicenses(async () => ({
      success: true,
      licenses: {
        [IMG_PAYLOAD]: {
          licenses: 'MIT',
          repository: 'https://github.com/test/pkg',
          publisher: 'Test Author',
        },
      },
    }));

    expectRenderedAsText(content, IMG_PAYLOAD);
    expect(content.querySelector('.license-package-name')?.textContent).toBe(IMG_PAYLOAD);
  });

  it('renders a scripted license label as text', async () => {
    const content = await renderLicenses(async () => ({
      success: true,
      licenses: {
        'safe-pkg': { licenses: SCRIPT_PAYLOAD, repository: '', publisher: '' },
      },
    }));

    expectRenderedAsText(content, SCRIPT_PAYLOAD);
    expect(content.querySelector('.license-package-license')?.textContent).toBe(SCRIPT_PAYLOAD);
  });

  it('renders a scripted licenses error as text', async () => {
    const content = await renderLicenses(async () => ({
      success: false,
      error: IMG_PAYLOAD,
    }));

    expectRenderedAsText(content, IMG_PAYLOAD);
  });

  it('renders a thrown licenses failure as text', async () => {
    const content = await renderLicenses(async () => {
      throw new Error(IMG_PAYLOAD);
    });

    expectRenderedAsText(content, IMG_PAYLOAD);
  });
});

describe('markdown sanitization boundary (real DOMPurify)', () => {
  const MALICIOUS_MARKDOWN = [
    '# Release notes',
    '',
    '<script>globalThis.__xssFired = true</script>',
    '',
    '<img src=x onerror="globalThis.__xssFired = true">',
    '',
    '<a href="javascript:globalThis.__xssFired = true">click me</a>',
    '',
    '<iframe src="https://evil.example"></iframe>',
  ].join('\n');

  it('strips scripts, event handlers and javascript: urls from rendered markdown', async () => {
    const { sanitizeMarkdownHtml } = await import('../shared');
    const { marked } = await import('marked');
    const rendered = sanitizeMarkdownHtml(
      marked.parse(MALICIOUS_MARKDOWN, { async: false, breaks: true }) as string
    );

    const host = document.createElement('div');
    host.innerHTML = rendered;
    document.body.appendChild(host);

    expectInert(host);
    expect(host.querySelector('iframe')).toBeNull();
    const link = host.querySelector('a');
    if (link) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
    // Benign markdown still renders.
    expect(host.querySelector('h1')?.textContent).toBe('Release notes');
  });

  it('is not the identity function this suite is guarding against', async () => {
    const { sanitizeMarkdownHtml } = await import('../shared');
    const dirty = '<img src=x onerror="globalThis.__xssFired = true">';
    expect(sanitizeMarkdownHtml(dirty)).not.toBe(dirty);
    expect(sanitizeMarkdownHtml(dirty)).not.toContain('onerror');
  });
});

describe('preview boundaries (rendererPreviews innerHTML)', () => {
  function setupPreviewDom() {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="preview-panel"><div id="preview-content"></div></div>
      <button id="preview-toggle-btn"></button>
      <button id="preview-close"></button>
    `;
  }

  function makeFile(overrides: Record<string, unknown> = {}) {
    return {
      name: 'notes.md',
      path: '/workspace/notes.md',
      isDirectory: false,
      isFile: true,
      size: 128,
      modified: Date.now(),
      ...overrides,
    } as any;
  }

  async function createController(overrides: Record<string, unknown> = {}) {
    const { createPreviewController } = await import('../rendererPreviews');
    const deps: any = {
      getSelectedItems: () => new Set<string>(),
      getFileByPath: () => undefined,
      getCurrentSettings: () =>
        ({ maxPreviewSizeMB: 50, maxThumbnailSizeMB: 10, enableSyntaxHighlighting: false }) as any,
      formatFileSize: (size: number) => `${size} B`,
      getFileExtension: (name: string) => name.split('.').pop() ?? '',
      getFileIcon: () => '<span data-icon="file"></span>',
      openFileEntry: vi.fn(),
      openExternal: vi.fn(),
      showToast: vi.fn(),
      ...overrides,
    };
    return createPreviewController(deps);
  }

  it('renders a thrown preview failure as text', async () => {
    setupPreviewDom();
    (window as any).tauriAPI = {};
    // The extension lookup is the first thing updatePreview does inside its try.
    const controller = await createController({
      getFileExtension: () => {
        throw new Error(IMG_PAYLOAD);
      },
    });

    await controller.updatePreview(makeFile());

    const content = document.getElementById('preview-content')!;
    expect(content.querySelector('.preview-error')).not.toBeNull();
    expectRenderedAsText(content, IMG_PAYLOAD);
  });

  it('renders a scripted text-file body inside a code block as text', async () => {
    setupPreviewDom();
    (window as any).tauriAPI = {
      readFileContent: vi.fn().mockResolvedValue({
        success: true,
        content: SCRIPT_PAYLOAD,
        isTruncated: false,
      }),
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
    };

    const controller = await createController();
    await controller.updatePreview(makeFile({ name: 'notes.txt', path: '/workspace/notes.txt' }));
    await vi.waitFor(() => {
      expect(document.querySelector('#preview-content .preview-text')).not.toBeNull();
    });

    const content = document.getElementById('preview-content')!;
    expectInert(content);
    expect(content.querySelector('.preview-text code')?.textContent).toBe(SCRIPT_PAYLOAD);
  });

  it('sanitizes a scripted markdown file before rendering it', async () => {
    setupPreviewDom();
    (window as any).tauriAPI = {
      readFileContent: vi.fn().mockResolvedValue({
        success: true,
        content: '# Title\n\n<img src=x onerror="globalThis.__xssFired = true">',
        isTruncated: false,
      }),
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
    };

    const controller = await createController();
    await controller.updatePreview(makeFile());
    await vi.waitFor(() => {
      expect(document.querySelector('#preview-content .preview-markdown')).not.toBeNull();
    });

    const content = document.getElementById('preview-content')!;
    expectInert(content);
    expect(content.querySelector('.preview-markdown h1')?.textContent).toBe('Title');
  });

  it('renders a scripted file name and path in the info panel as text', async () => {
    setupPreviewDom();
    (window as any).tauriAPI = {
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
    };

    const controller = await createController();
    await controller.updatePreview(
      makeFile({ name: `${IMG_PAYLOAD}.bin`, path: `/workspace/${IMG_PAYLOAD}.bin` })
    );
    await vi.waitFor(() => {
      expect(document.querySelector('#preview-content .preview-info-value')).not.toBeNull();
    });

    const content = document.getElementById('preview-content')!;
    expectRenderedAsText(content, IMG_PAYLOAD);
  });
});

describe('quicklook boundaries (rendererQuicklook innerHTML)', () => {
  function setupQuicklookDom() {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="quicklook-modal" style="display:none">
        <span id="quicklook-title"></span>
        <div id="quicklook-content"></div>
        <span id="quicklook-info"></span>
        <button id="quicklook-close"></button>
        <button id="quicklook-open"></button>
      </div>
    `;
  }

  async function showFile(file: Record<string, unknown>) {
    const { createQuicklookController } = await import('../rendererQuicklook');
    const controller = createQuicklookController({
      getSelectedItems: () => new Set<string>(),
      getFileByPath: () => undefined,
      getCurrentSettings: () =>
        ({ maxThumbnailSizeMB: 10, enableSyntaxHighlighting: false }) as any,
      formatFileSize: (size: number) => `${size} B`,
      getFileExtension: (name: string) => name.split('.').pop() ?? '',
      getFileIcon: () => '<span data-icon="file"></span>',
      openFileEntry: vi.fn(),
      openExternal: vi.fn(),
      showToast: vi.fn(),
    } as any);

    await controller.showQuickLookForFile({
      isDirectory: false,
      isFile: true,
      size: 128,
      modified: Date.now(),
      ...file,
    } as any);
    return document.getElementById('quicklook-content')!;
  }

  it('renders a scripted text body inside a code block as text', async () => {
    setupQuicklookDom();
    (window as any).tauriAPI = {
      readFileContent: vi.fn().mockResolvedValue({
        success: true,
        content: IMG_PAYLOAD,
        isTruncated: false,
      }),
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
    };

    const content = await showFile({ name: 'notes.txt', path: '/workspace/notes.txt' });
    await vi.waitFor(() => {
      expect(content.querySelector('.preview-text')).not.toBeNull();
    });

    expectInert(content);
    expect(content.querySelector('.preview-text code')?.textContent).toBe(IMG_PAYLOAD);
  });

  it('sanitizes scripted markdown before rendering it', async () => {
    setupQuicklookDom();
    (window as any).tauriAPI = {
      readFileContent: vi.fn().mockResolvedValue({
        success: true,
        content: '# Heading\n\n<script>globalThis.__xssFired = true</script>',
        isTruncated: false,
      }),
      getItemProperties: vi.fn().mockResolvedValue({ success: false }),
    };

    const content = await showFile({ name: 'readme.md', path: '/workspace/readme.md' });
    await vi.waitFor(() => {
      expect(content.querySelector('.preview-markdown')).not.toBeNull();
    });

    expectInert(content);
    expect(content.querySelector('.preview-markdown h1')?.textContent).toBe('Heading');
  });
});
