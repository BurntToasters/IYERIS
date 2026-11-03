import indexHtml from '../src/index.html?raw';
import { createDefaultHomeSettings } from '../src/homeSettings.ts';
import { createDefaultSettings } from '../src/settings.ts';

const {
  document,
  window,
  DOMParser,
  Event,
  HTMLImageElement,
  HTMLInputElement,
  HTMLSelectElement,
  HTMLElement,
  KeyboardEvent,
  MouseEvent,
  MutationObserver,
  getComputedStyle,
  requestAnimationFrame,
} = globalThis;

const FIXTURE_ID = 'iyeris-310-native-fixture-v1';
const WORKSPACE_PATH = '/fixture/Workspace';
const DOCUMENTS_PATH = `${WORKSPACE_PATH}/Documents`;
const PROJECTS_PATH = `${WORKSPACE_PATH}/Projects`;
const EMPTY_PATH = `${WORKSPACE_PATH}/Empty`;
const LARGE_PATH = `${WORKSPACE_PATH}/Large`;
const LONG_FILENAME =
  'A-very-long-filename-that-must-wrap-within-the-row-without-clipping-the-file-view-2026.md';
const LONG_FILE_PATH = `${WORKSPACE_PATH}/${LONG_FILENAME}`;
const FIXTURE_TIME = 1_761_920_000_000;
const VIEWPORTS = [
  { width: 800, height: 500 },
  { width: 1200, height: 800 },
  { width: 1600, height: 1000 },
];
const THEME_VALUES = [
  'default',
  'dark',
  'light',
  'nord',
  'catppuccin',
  'dracula',
  'solarized',
  'github',
  'custom',
];
const ACCESSIBILITY_SETTINGS = [
  ['reduce-motion-toggle', 'reduceMotion', 'reduce-motion'],
  ['high-contrast-toggle', 'highContrast', 'high-contrast'],
  ['use-system-font-size-toggle', 'useSystemFontSize', 'use-system-font-size'],
  ['large-text-toggle', 'largeText', 'large-text'],
  ['bold-text-toggle', 'boldText', 'bold-text'],
  ['reduce-transparency-toggle', 'reduceTransparency', 'reduce-transparency'],
  ['visible-focus-toggle', 'visibleFocus', 'visible-focus'],
];
const PREVIEW_FIXTURE_ID = 'readme-preview-markdown-v1';
const PROPERTIES_FIXTURE_ID = 'item-properties-raw-schema-v1';
const HOME_SETTINGS_SAVE_RACE_FIXTURE_ID = 'home-settings-inflight-edit-v1';
const SEARCH_LOADING_FIXTURE_ID = 'search-loading-state-v1';
const HOME_DRIVE_INFO_FIXTURE = [
  {
    name: 'Smoke Volume',
    mountPoint: '/fixture',
    totalSpace: 1_000_000_000,
    availableSpace: 600_000_000,
    fsType: 'fixture',
    isRemovable: false,
  },
  {
    name: '',
    mountPoint: '/fixture/empty-label',
    totalSpace: 1_000_000_000,
    availableSpace: 250_000_000,
    fsType: 'fixture',
    isRemovable: false,
  },
  {
    name: 'A deliberately long removable volume label for Home layout coverage',
    mountPoint: '/fixture/long-label',
    totalSpace: 1_000_000_000,
    availableSpace: 125_000_000,
    fsType: 'fixture',
    isRemovable: true,
  },
  {
    name: 'Unavailable Usage Volume',
    mountPoint: '/fixture/no-usage',
    totalSpace: 0,
    availableSpace: 0,
    fsType: 'fixture',
    isRemovable: false,
  },
];
const CONTEXT_MENU_DESTINATIONS = Array.from(
  { length: 8 },
  (_, index) => `${WORKSPACE_PATH}/Destination-${index + 1}`
);
const OPEN_WITH_APPS_FIXTURE = Array.from({ length: 18 }, (_, index) => ({
  id: `fixture-app-${String(index + 1).padStart(2, '0')}`,
  name: `Fixture Viewer ${String(index + 1).padStart(2, '0')}`,
}));
const DUAL_PANE_FIXTURE_IDS = {
  copy: 'dual-pane-copy-to-primary-v1',
  move: 'dual-pane-move-to-primary-v1',
  dragCleanup: 'dual-pane-drag-cleanup-v1',
};
const SECONDARY_COPY_PATH = `${PROJECTS_PATH}/Design.md`;
const SECONDARY_MOVE_PATH = `${PROJECTS_PATH}/Source.txt`;
const EXPECTED_OPERATION_FIXTURES = {
  'create-folder': 'create-folder-permission-denied-v1',
  'create-file': 'create-file-disk-full-v1',
  'dual-pane-copy': DUAL_PANE_FIXTURE_IDS.copy,
  'dual-pane-move': DUAL_PANE_FIXTURE_IDS.move,
  'dual-pane-drag-cleanup': DUAL_PANE_FIXTURE_IDS.dragCleanup,
  'home-settings-save-race': HOME_SETTINGS_SAVE_RACE_FIXTURE_ID,
  'search-loading': SEARCH_LOADING_FIXTURE_ID,
  'item-properties': PROPERTIES_FIXTURE_ID,
  'preview-read': PREVIEW_FIXTURE_ID,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSettings() {
  const settings = createDefaultSettings();
  Object.assign(settings, {
    theme: 'default',
    useSystemTheme: false,
    startupPath: WORKSPACE_PATH,
    launchCount: 5,
    autoCheckUpdates: false,
    supportPopupDismissed: true,
    tourPromptDismissed: true,
    tourCompleted: true,
    enableTabs: true,
    enableIndexer: false,
    enableGitStatus: false,
    showFileHoverCard: false,
    showFolderTree: true,
    recentFiles: [`${DOCUMENTS_PATH}/Planning.md`],
    bookmarks: [DOCUMENTS_PATH],
    customTheme: {
      name: 'Evidence Blue',
      accentColor: '#2979d8',
      bgPrimary: '#17202b',
      bgSecondary: '#202d3b',
      textPrimary: '#f4f7fb',
      textSecondary: '#aeb9c7',
      glassBg: '#ffffff',
      glassBorder: '#ffffff',
      iconHue: '#2979d8',
    },
    recentTransferDestinations: [...CONTEXT_MENU_DESTINATIONS],
  });
  return settings;
}

function rawFile(name, parentPath, isDirectory, overrides = {}) {
  const path = `${parentPath.replace(/\/$/, '')}/${name}`;
  const extension = isDirectory ? '' : name.includes('.') ? name.split('.').at(-1) || '' : '';
  return {
    name,
    path,
    isDirectory,
    isSymlink: false,
    isBrokenSymlink: false,
    isAppBundle: false,
    isShortcut: false,
    isDesktopEntry: false,
    isHidden: false,
    size: isDirectory ? 0 : 2048,
    modified: FIXTURE_TIME,
    created: FIXTURE_TIME - 86_400_000,
    extension,
    permissions: isDirectory ? 493 : 420,
    readonly: false,
    ...overrides,
  };
}

function makeDirectoryData() {
  return new Map([
    ['/', [rawFile('fixture', '/', true)]],
    ['/fixture', [rawFile('Home', '/fixture', true), rawFile('Workspace', '/fixture', true)]],
    [
      WORKSPACE_PATH,
      [
        rawFile('Documents', WORKSPACE_PATH, true),
        rawFile('Projects', WORKSPACE_PATH, true),
        rawFile('Empty', WORKSPACE_PATH, true),
        rawFile('Large', WORKSPACE_PATH, true),
        rawFile('Readme.md', WORKSPACE_PATH, false, { size: 1450 }),
        rawFile('Quarterly-Report.csv', WORKSPACE_PATH, false, { size: 8192 }),
        rawFile(LONG_FILENAME, WORKSPACE_PATH, false, { size: 5120 }),
      ],
    ],
    [
      DOCUMENTS_PATH,
      [
        rawFile('Archive', DOCUMENTS_PATH, true),
        rawFile('Meeting-Notes.txt', DOCUMENTS_PATH, false, { size: 420 }),
        rawFile('Planning.md', DOCUMENTS_PATH, false, { size: 2360 }),
      ],
    ],
    [
      PROJECTS_PATH,
      [
        rawFile('Design.md', PROJECTS_PATH, false, { size: 2750 }),
        rawFile('Meeting-Notes.txt', PROJECTS_PATH, false, { size: 640 }),
        rawFile('Source.txt', PROJECTS_PATH, false, { size: 1630 }),
      ],
    ],
    [
      '/fixture/Home',
      [
        rawFile('Documents', '/fixture/Home', true),
        rawFile('Downloads', '/fixture/Home', true),
        rawFile('Workspace', '/fixture/Home', true),
      ],
    ],
    [
      `${DOCUMENTS_PATH}/Archive`,
      [rawFile('Archive-Contents.txt', `${DOCUMENTS_PATH}/Archive`, false)],
    ],
    [EMPTY_PATH, []],
    [
      LARGE_PATH,
      Array.from({ length: 1300 }, (_, index) =>
        rawFile(`Item-${String(index).padStart(4, '0')}.txt`, LARGE_PATH, false, {
          size: 1024 + index,
        })
      ),
    ],
  ]);
}

function normalizeFixturePath(value) {
  const path = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return path || '/';
}

function fixtureParentPath(value) {
  const normalized = normalizeFixturePath(value);
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? '/' : normalized.slice(0, separator);
}

function fixtureBaseName(value) {
  const normalized = normalizeFixturePath(value);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function installNativeFixture() {
  const settingsStore = makeSettings();
  const homeSettingsStore = createDefaultHomeSettings();
  const directoryData = makeDirectoryData();
  const callbacks = new Map();
  const listeners = new Map();
  let nextCallbackId = 1;
  let nextListenerId = 1;

  const fixture = {
    fixtureId: FIXTURE_ID,
    settingsStore,
    homeSettingsStore,
    directoryData,
    calls: [],
    unexpectedInvokes: [],
    zoomLevel: 1,
    currentCaseId: 'startup',
    listenerCount: 0,
    saveSettingsCount: 0,
    saveHomeSettingsCount: 0,
    homeSettingsSaveGate: {
      fixtureId: HOME_SETTINGS_SAVE_RACE_FIXTURE_ID,
      caseId: 'home-settings-inflight-edit',
      enabled: false,
      started: false,
      invocations: 0,
      release: null,
      timeout: null,
    },
    searchLoadingGate: {
      fixtureId: SEARCH_LOADING_FIXTURE_ID,
      caseId: 'search-states-and-filters',
      enabled: false,
      started: false,
      invocations: 0,
      release: null,
      timeout: null,
    },
    directoryLoads: [],
    driveInfo: HOME_DRIVE_INFO_FIXTURE,
  };

  function invocationFixtureId(command) {
    if (command === 'create_folder') return EXPECTED_OPERATION_FIXTURES['create-folder'];
    if (command === 'create_file') return EXPECTED_OPERATION_FIXTURES['create-file'];
    if (command === 'copy_items') return DUAL_PANE_FIXTURE_IDS.copy;
    if (command === 'move_items') return DUAL_PANE_FIXTURE_IDS.move;
    if (command === 'clear_drag_data') return DUAL_PANE_FIXTURE_IDS.dragCleanup;
    if (command === 'get_item_properties') return PROPERTIES_FIXTURE_ID;
    if (
      command === 'save_home_settings' &&
      fixture.currentCaseId === fixture.homeSettingsSaveGate.caseId
    ) {
      return HOME_SETTINGS_SAVE_RACE_FIXTURE_ID;
    }
    if (command === 'read_file_content') return PREVIEW_FIXTURE_ID;
    return FIXTURE_ID;
  }

  function applyFixtureFileOperation({ sourcePaths, destPath, operation }) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      throw new Error(`Invalid ${operation} fixture source paths.`);
    }
    const destination = normalizeFixturePath(destPath);
    const destinationItems = directoryData.get(destination);
    if (!destinationItems) throw new Error(`Fixture has no destination directory ${destination}`);
    for (const sourcePathValue of sourcePaths) {
      const sourcePath = normalizeFixturePath(sourcePathValue);
      const sourceItems = directoryData.get(fixtureParentPath(sourcePath));
      const sourceItem = sourceItems?.find((item) => item.path === sourcePath);
      if (!sourceItem) throw new Error(`Fixture has no source item ${sourcePath}`);
      const destinationPath = `${destination.replace(/\/$/, '')}/${fixtureBaseName(sourcePath)}`;
      const destinationItem = { ...sourceItem, path: destinationPath };
      if (operation === 'move') {
        sourceItems.splice(sourceItems.indexOf(sourceItem), 1);
      }
      if (!destinationItems.some((item) => item.path === destinationPath)) {
        destinationItems.push(destinationItem);
      }
    }
  }

  const handlers = {
    'plugin:event|listen': ({ event, handler }) => {
      const listenerId = nextListenerId++;
      listeners.set(listenerId, { event, handler });
      fixture.listenerCount += 1;
      return listenerId;
    },
    'plugin:event|unlisten': ({ eventId }) => {
      listeners.delete(eventId);
      return undefined;
    },
    get_platform: () => 'linux',
    is_mas: () => false,
    is_flatpak: () => false,
    is_ms_store: () => false,
    is_msi: () => false,
    is_dev_mode: () => false,
    get_app_version: () => '3.1.0-smoke',
    get_system_accent_color: () => ({ accentColor: '#2979d8', isDarkMode: true }),
    get_system_text_scale: () => 1,
    get_window_label: () => 'main',
    get_home_directory: () => '/fixture/Home',
    get_special_directory: ({ directory }) => {
      const paths = {
        desktop: '/fixture/Home/Desktop',
        documents: '/fixture/Workspace/Documents',
        downloads: '/fixture/Home/Downloads',
        music: '/fixture/Home/Music',
        videos: '/fixture/Home/Videos',
      };
      return paths[directory] || '/fixture/Home';
    },
    get_drives: () => fixture.driveInfo.map(({ mountPoint }) => ({ mountPoint })),
    get_drive_info: () => clone(fixture.driveInfo),
    get_directory_contents: ({ dirPath }) => {
      const path = normalizeFixturePath(dirPath);
      fixture.directoryLoads.push(path);
      if (!directoryData.has(path)) throw new Error(`Fixture has no directory data for ${path}`);
      return clone(directoryData.get(path));
    },
    cancel_directory_contents: () => undefined,
    get_settings: () => JSON.stringify(settingsStore),
    save_settings: ({ settings }) => {
      const submitted = JSON.parse(settings);
      const revision = (Number(settingsStore._revision) || 0) + 1;
      Object.keys(settingsStore).forEach((key) => delete settingsStore[key]);
      Object.assign(settingsStore, submitted, { _revision: revision });
      fixture.saveSettingsCount += 1;
      return { status: 'saved', settings: clone(settingsStore) };
    },
    get_settings_path: () => '/fixture/settings.json',
    get_home_settings: () => JSON.stringify(homeSettingsStore),
    save_home_settings: async ({ settings }) => {
      const gate = fixture.homeSettingsSaveGate;
      if (gate.enabled && fixture.currentCaseId === gate.caseId) {
        gate.invocations += 1;
        if (gate.invocations === 1) {
          gate.started = true;
          await new Promise((resolve) => {
            const release = () => {
              if (gate.timeout) clearTimeout(gate.timeout);
              gate.timeout = null;
              gate.release = null;
              resolve();
            };
            gate.release = release;
            gate.timeout = setTimeout(release, 12000);
          });
        }
      }
      const submitted = JSON.parse(settings);
      const revision = (Number(homeSettingsStore._revision) || 0) + 1;
      Object.keys(homeSettingsStore).forEach((key) => delete homeSettingsStore[key]);
      Object.assign(homeSettingsStore, submitted, { _revision: revision });
      fixture.saveHomeSettingsCount += 1;
      return { status: 'saved', settings: clone(homeSettingsStore) };
    },
    get_home_settings_path: () => '/fixture/home-settings.json',
    get_clipboard: () => null,
    get_system_clipboard_data: () => null,
    get_system_clipboard_files: () => [],
    get_autostart: () => false,
    get_undo_redo_state: () => ({ canUndo: false, canRedo: false }),
    undo_action: () => ({ canUndo: false, canRedo: false }),
    redo_action: () => ({ canUndo: false, canRedo: false }),
    get_disk_space: ({ drivePath }) =>
      drivePath === '/fixture/no-usage'
        ? {}
        : {
            total: 1_000_000_000,
            free: drivePath === '/fixture/long-label' ? 125_000_000 : 600_000_000,
          },
    get_open_with_apps: () => clone(OPEN_WITH_APPS_FIXTURE),
    open_file_with_app: () => ({ success: true }),
    read_file_content: ({ filePath }) => {
      if (normalizeFixturePath(filePath) !== `${WORKSPACE_PATH}/Readme.md`) {
        throw new Error(`Preview fixture has no text content for ${String(filePath)}`);
      }
      return {
        content: '# Fixture Preview\n\nDeterministic Markdown preview content.',
        isTruncated: false,
      };
    },
    get_item_properties: ({ itemPath }) => {
      const path = normalizeFixturePath(itemPath);
      const item = Array.from(directoryData.values())
        .flat()
        .find((candidate) => candidate.path === path);
      if (!item) throw new Error(`Properties fixture has no item ${path}`);
      return {
        name: item.name,
        path: item.path,
        size: item.size,
        isDirectory: item.isDirectory,
        isSymlink: item.isSymlink === true,
        symlinkTarget: null,
        isShortcut: item.isShortcut === true,
        shortcutTarget: null,
        isHidden: item.isHidden === true,
        readonly: item.readonly === true,
        owner: 'iyeris-fixture',
        group: 'fixture-users',
        isHiddenAttr: null,
        isSystemAttr: null,
        macTags: null,
        created: item.created,
        modified: item.modified,
        accessed: item.modified,
        extension: item.extension,
        permissions: item.permissions,
        sizeOnDisk: item.size,
        mimeType: null,
        opensWith: null,
        ownerName: 'IYERIS Fixture',
        groupName: 'Fixture Users',
        isArchiveAttr: null,
        isCompressedAttr: null,
        isEncryptedAttr: null,
        isIndexedAttr: null,
      };
    },
    copy_items: ({ sourcePaths, destPath }) => {
      applyFixtureFileOperation({ sourcePaths, destPath, operation: 'copy' });
      return null;
    },
    move_items: ({ sourcePaths, destPath }) => {
      applyFixtureFileOperation({ sourcePaths, destPath, operation: 'move' });
      return null;
    },
    clear_drag_data: () => null,
    get_thumbnail_cache_size: () => ({ sizeBytes: 0, fileCount: 0 }),
    get_git_status: () => ({
      isGitRepo: false,
      modified: [],
      added: [],
      deleted: [],
      untracked: [],
    }),
    get_git_branch: () => '',
    get_index_status: () => ({ isBuilding: false, entryCount: 6, indexedRoots: ['/fixture'] }),
    get_native_integration_status: () => ({
      supported: false,
      installed: false,
      message: 'Native integration is unavailable in the deterministic smoke fixture.',
    }),
    search_files: async ({ query }) => {
      const normalized = String(query || '')
        .trim()
        .toLowerCase();
      const gate = fixture.searchLoadingGate;
      if (
        gate.enabled &&
        fixture.currentCaseId === gate.caseId &&
        normalized === 'slow' &&
        !gate.started
      ) {
        gate.started = true;
        gate.invocations += 1;
        await new Promise((resolve) => {
          const release = () => {
            if (gate.timeout) clearTimeout(gate.timeout);
            gate.timeout = null;
            gate.release = null;
            resolve();
          };
          gate.release = release;
          gate.timeout = setTimeout(release, 8000);
        });
      }
      const results = [
        {
          name: 'Meeting-Notes.txt',
          path: `${DOCUMENTS_PATH}/Meeting-Notes.txt`,
          isDirectory: false,
          size: 420,
          modified: FIXTURE_TIME,
          extension: 'txt',
          isHidden: false,
        },
      ];
      return results.filter((result) => result.name.toLowerCase().includes(normalized));
    },
    search_index: ({ query }) => {
      const normalized = String(query || '')
        .trim()
        .toLowerCase();
      return [
        {
          name: 'Meeting-Notes.txt',
          path: `${DOCUMENTS_PATH}/Meeting-Notes.txt`,
          isDirectory: false,
          size: 420,
          modified: FIXTURE_TIME,
          extension: 'txt',
          isHidden: false,
        },
      ].filter((result) => result.name.toLowerCase().includes(normalized));
    },
    search_files_content: () => [],
    search_files_content_global: () => [],
    cancel_search: () => undefined,
    watch_directory: () => undefined,
    unwatch_directory: () => undefined,
    check_full_disk_access: () => true,
    set_zoom_level: ({ zoomLevel }) => {
      if (typeof zoomLevel !== 'number' || !Number.isFinite(zoomLevel)) {
        throw new Error(`Invalid fixture zoom level ${String(zoomLevel)}`);
      }
      fixture.zoomLevel = zoomLevel;
      document.documentElement.style.zoom = String(zoomLevel);
      return undefined;
    },
    get_zoom_level: () => fixture.zoomLevel,
    'plugin:window|is_maximized': () => false,
    create_folder: () => {
      throw new Error('Fixture operation error: permission denied creating folder');
    },
    create_file: () => {
      throw new Error('Fixture operation error: disk full while creating file');
    },
  };
  fixture.allowedInvokeCommands = Object.keys(handlers).sort();

  function safeArgs(args) {
    return JSON.parse(
      JSON.stringify(args ?? {}, (_key, value) =>
        typeof value === 'string' && value.length > 5000
          ? `${value.slice(0, 5000)}...[truncated]`
          : value
      )
    );
  }

  const invoke = async (command, args = {}) => {
    const fixtureId = invocationFixtureId(command);
    const call = {
      command,
      args: safeArgs(args),
      caseId: fixture.currentCaseId,
      fixtureId,
      status: 'pending',
    };
    fixture.calls.push(call);
    const handler = handlers[command];
    if (!handler) {
      const unexpected = { command, args: call.args, caseId: call.caseId, fixtureId };
      fixture.unexpectedInvokes.push(unexpected);
      call.status = 'unexpected';
      throw new Error(`Unexpected Tauri invoke ${command} for ${fixture.currentCaseId}`);
    }
    try {
      const result = await handler(args);
      call.status = 'resolved';
      return result;
    } catch (error) {
      call.status = 'rejected';
      call.error = String(error?.message || error);
      throw error;
    }
  };

  const transformCallback = (callback) => {
    const id = nextCallbackId++;
    callbacks.set(id, callback);
    return id;
  };

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    unregisterListener: (event, eventId) => {
      const listener = listeners.get(eventId);
      if (listener?.event === event) listeners.delete(eventId);
    },
    convertFileSrc: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event, eventId) => {
      const listener = listeners.get(eventId);
      if (listener?.event === event) listeners.delete(eventId);
    },
  };
  window.__IYERIS_APP_SMOKE__ = fixture;
  return fixture;
}

function mountCompleteAppBody() {
  const sourceDocument = new DOMParser().parseFromString(indexHtml, 'text/html');
  sourceDocument.body.querySelectorAll('script').forEach((script) => script.remove());
  document.body.className = '';
  document.body.innerHTML = sourceDocument.body.innerHTML;

  const fixRootedImage = (image) => {
    const source = image.getAttribute('src');
    if (source?.startsWith('/') && !source.startsWith('//')) {
      image.setAttribute('src', new URL(source.slice(1), window.location.href).href);
    }
  };
  document.querySelectorAll('img[src^="/"]').forEach(fixRootedImage);
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type !== 'attributes' || mutation.attributeName !== 'src') return;
      const target = mutation.target;
      if (target instanceof HTMLImageElement) fixRootedImage(target);
    });
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['src'] });
}

const doubleFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function waitFor(predicate, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForStable(predicate, message, timeoutMs = 6000, stableFrames = 3) {
  const deadline = Date.now() + timeoutMs;
  const nextFrame = () =>
    new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        resolve();
      }, 100);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        })
      );
    });
  while (Date.now() < deadline) {
    if (!predicate()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    let stable = 0;
    while (stable < stableFrames && Date.now() < deadline) {
      await nextFrame();
      if (!predicate()) break;
      stable += 1;
    }
    if (stable === stableFrames && predicate()) return;
  }
  throw new Error(message);
}

function isVisible(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  );
}

function textOf(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function computedColorAlpha(value) {
  const color = String(value).trim().toLowerCase();
  if (color === 'transparent') return 0;
  const slash = color.lastIndexOf('/');
  const rgba = /^rgba?\((.*)\)$/.exec(color);
  const alphaText =
    slash >= 0
      ? color.slice(slash + 1).replace(/[)\s]/g, '')
      : rgba?.[1]?.split(',').at(-1)?.trim();
  if (!alphaText) return 1;
  const alpha = alphaText.endsWith('%')
    ? Number.parseFloat(alphaText) / 100
    : Number.parseFloat(alphaText);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

function viewportNow() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function dispatchKey(key, options = {}) {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document;
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    })
  );
}

function beginViewportRequest() {
  let sequence = 0;
  const waiters = new Map();
  globalThis.__iyerisSmokeViewportSettle = (result) => {
    const waiter = waiters.get(result?.id);
    if (!waiter) return;
    waiters.delete(result.id);
    clearTimeout(waiter.timeout);
    if (result.error) waiter.reject(new Error(`Smoke viewport failed: ${result.error}`));
    else waiter.resolve(result);
  };
  return (width, height) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Viewport ${width}x${height} did not settle.`));
      }, 5000);
      waiters.set(id, { resolve, reject, timeout });
      if (typeof window.iyerisSmokeViewport !== 'function') {
        clearTimeout(timeout);
        waiters.delete(id);
        reject(new Error('The CDP viewport binding is unavailable.'));
        return;
      }
      window.iyerisSmokeViewport(JSON.stringify({ id, width, height }));
    });
}

function caseMetadata(caseId, options = {}) {
  return {
    caseId,
    fixtureId: options.fixtureId || FIXTURE_ID,
    viewport: options.viewport || viewportNow(),
    zoom: options.zoom ?? Math.round((window.__IYERIS_APP_SMOKE__?.zoomLevel || 1) * 100),
    theme: options.theme || window.__IYERIS_APP_SMOKE__?.settingsStore?.theme || 'default',
    density: options.density || window.__IYERIS_APP_SMOKE__?.settingsStore?.uiDensity || 'default',
    liquidGlass:
      options.liquidGlass ?? Boolean(window.__IYERIS_APP_SMOKE__?.settingsStore?.liquidGlassMode),
    accessibility:
      options.accessibility ||
      Object.fromEntries(ACCESSIBILITY_SETTINGS.map(([, key]) => [key, false])),
  };
}

function beginPointerRequest() {
  let sequence = 0;
  const waiters = new Map();
  globalThis.__iyerisSmokePointerSettle = (result) => {
    const waiter = waiters.get(result?.id);
    if (!waiter) return;
    waiters.delete(result.id);
    clearTimeout(waiter.timeout);
    if (result.error) waiter.reject(new Error(`Smoke pointer failed: ${result.error}`));
    else waiter.resolve(result);
  };
  return (x, y, action = 'move', button = 'left') =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Pointer ${action} at ${x},${y} did not settle.`));
      }, 5000);
      waiters.set(id, { resolve, reject, timeout });
      if (typeof globalThis.iyerisSmokePointer !== 'function') {
        clearTimeout(timeout);
        waiters.delete(id);
        reject(new Error('The CDP pointer binding is unavailable.'));
        return;
      }
      globalThis.iyerisSmokePointer(JSON.stringify({ id, x, y, action, button }));
    });
}

async function changeSetting(inputId, value) {
  const input = document.getElementById(inputId);
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) {
    throw new Error(`Settings control #${inputId} is missing.`);
  }
  if (input instanceof HTMLInputElement && input.type === 'checkbox') {
    input.checked = Boolean(value);
  } else {
    input.value = String(value);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function openSettings() {
  const button = document.getElementById('settings-btn');
  if (!(button instanceof HTMLElement))
    throw new Error('Settings button #settings-btn is missing.');
  if (!isVisible(button)) {
    const more = document.getElementById('more-actions-btn');
    const menu = document.getElementById('more-actions-menu');
    if (menu?.style.display !== 'block') more?.click();
    await doubleFrame();
  }
  button.click();
  await waitFor(
    () => document.getElementById('settings-modal')?.style.display === 'flex',
    'Settings modal did not open.'
  );
}

async function saveSettings() {
  const button = document.getElementById('save-settings-btn');
  if (!(button instanceof HTMLElement)) throw new Error('Settings save button is missing.');
  button.click();
  await waitFor(
    () => document.getElementById('settings-modal')?.style.display === 'none',
    'Settings modal did not close after saving.'
  );
  await doubleFrame();
}

async function closeSettings() {
  const button = document.getElementById('settings-close');
  if (!(button instanceof HTMLElement)) throw new Error('Settings close button is missing.');
  button.click();
  await waitFor(
    () => document.getElementById('settings-modal')?.style.display === 'none',
    'Settings modal did not close.'
  );
  if (document.getElementById('more-actions-menu')?.style.display === 'block') {
    document.getElementById('more-actions-btn')?.click();
  }
  await doubleFrame();
}

async function setSettingAndSave(inputId, value) {
  await openSettings();
  await changeSetting(inputId, value);
  await saveSettings();
}

async function setAccessibilityProfile(enabled) {
  await openSettings();
  for (const [controlId] of ACCESSIBILITY_SETTINGS) await changeSetting(controlId, enabled);
  await saveSettings();
}

export async function runBrowserAppSmoke(results) {
  const record = {
    mode: 'full-app-310-redesign',
    fixtureId: FIXTURE_ID,
    passed: false,
    checks: [],
    cases: [],
    screenshots: [],
    nativeFixture: null,
    harnessError: null,
  };
  results.push(record);
  let fixture = null;
  let requestViewport = null;
  let requestPointer = null;
  const failures = [];

  const beginCase = (caseId, options = {}) => {
    const metadata = caseMetadata(caseId, options);
    const testCase = { ...metadata, fixtureIds: [FIXTURE_ID, ...(options.fixtureIds || [])] };
    record.cases.push(testCase);
    if (fixture) fixture.currentCaseId = caseId;
    return testCase;
  };

  const check = (testCase, name, passed, actual, expected) => {
    const item = {
      caseId: testCase.caseId,
      fixtureId: testCase.fixtureId,
      name,
      passed: passed === true,
      actual: String(actual),
      expected: String(expected),
    };
    record.checks.push(item);
    if (!item.passed)
      failures.push(
        `${testCase.caseId}: ${name} (actual ${item.actual}; expected ${item.expected})`
      );
    return item.passed;
  };

  const screenshot = async (testCase, name) => {
    const request = globalThis.iyerisSmokeRequestScreenshot;
    if (typeof request !== 'function')
      throw new Error('The CDP screenshot binding is unavailable.');
    await request(name, [], {
      ...caseMetadata(testCase.caseId, testCase),
      fixtureIds: testCase.fixtureIds,
    });
    record.screenshots.push(name);
  };

  const runCase = async (caseId, options, task, cleanup) => {
    const testCase = beginCase(caseId, options);
    try {
      await task(testCase);
    } catch (error) {
      check(
        testCase,
        'case completed without a harness or renderer exception',
        false,
        error?.message || error,
        'no exception'
      );
    } finally {
      if (cleanup) {
        try {
          await cleanup(testCase);
        } catch (error) {
          check(
            testCase,
            'case cleanup completes without a renderer exception',
            false,
            error?.message || error,
            'cleanup completed'
          );
        }
      }
    }
  };

  try {
    mountCompleteAppBody();
    fixture = installNativeFixture();
    await import('../src/tauri-api.ts');
    await import('../src/renderer.ts');
    requestViewport = beginViewportRequest();
    await waitFor(
      () => {
        const loading = document.getElementById('loading');
        const startupError = document.getElementById('dialog-title');
        const failed = startupError?.textContent?.trim() === 'Startup Error';
        return !failed && Boolean(loading && getComputedStyle(loading).display === 'none');
      },
      'The real renderer did not finish its first directory load.',
      20000
    );
    requestPointer = beginPointerRequest();

    // Keep a full-window image at each approved size before any redesign assertion runs.
    for (const viewport of VIEWPORTS) {
      await requestViewport(viewport.width, viewport.height);
      await doubleFrame();
      const testCase = beginCase(`baseline-${viewport.width}x${viewport.height}`, {
        viewport,
        zoom: 100,
        theme: 'default',
        density: 'default',
      });
      await screenshot(testCase, `app-baseline-${viewport.width}x${viewport.height}`);
    }
  } catch (error) {
    record.harnessError = String(error?.stack || error);
    failures.push(`startup or baseline capture: ${error?.message || error}`);
  }

  if (fixture && !record.harnessError) {
    const currentViewport = async (width, height) => {
      await requestViewport(width, height);
      await doubleFrame();
      return viewportNow();
    };

    const directoryIsRendered = (path) => {
      const address = document.getElementById('address-input');
      const loading = document.getElementById('loading');
      const hasRows = Array.from(document.querySelectorAll('#file-grid .file-item')).some((item) =>
        item.getAttribute('data-path')?.startsWith(`${path.replace(/\/$/, '')}/`)
      );
      return (
        address instanceof HTMLInputElement &&
        address.value === path &&
        (!loading || getComputedStyle(loading).display === 'none') &&
        hasRows
      );
    };

    const navigateToDirectory = async (path) => {
      dispatchKey('l', { ctrlKey: true });
      const address = document.getElementById('address-input');
      if (!(address instanceof HTMLInputElement)) {
        throw new Error('The editable path control is unavailable for fixture navigation.');
      }
      if (address.value !== path) {
        address.value = path;
        address.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      }
      await waitForStable(
        () => {
          const loading = document.getElementById('loading');
          const empty = document.getElementById('empty-state');
          const emptyVisible = Boolean(
            empty && getComputedStyle(empty).display !== 'none' && empty.isConnected
          );
          return (
            address.value === path &&
            (!loading || getComputedStyle(loading).display === 'none') &&
            (directoryIsRendered(path) || emptyVisible)
          );
        },
        `The deterministic directory ${path} did not finish rendering and settle.`,
        12000
      );
    };

    const findStableRow = async (path, message) => {
      let row = null;
      await waitForStable(
        () => {
          row = Array.from(document.querySelectorAll('#file-grid .file-item')).find(
            (item) => item.getAttribute('data-path') === path
          );
          const loading = document.getElementById('loading');
          return Boolean(
            row?.isConnected && (!loading || getComputedStyle(loading).display === 'none')
          );
        },
        message,
        10000
      );
      return row;
    };

    const menuButton = () => document.getElementById('more-actions-btn');
    const menuPanel = () => document.getElementById('more-actions-menu');
    const moreCanReach = (id) => {
      const element = document.getElementById(id);
      return Boolean(element && (isVisible(element) || menuPanel()?.contains(element)));
    };
    const inspectPrimaryControlGeometry = (actualViewport) => {
      const toolbar = document.querySelector('[role="toolbar"]');
      const toolbarRect = toolbar?.getBoundingClientRect();
      const controls = [
        ...[
          'sidebar-toggle',
          'back-btn',
          'forward-btn',
          'up-btn',
          'search-btn',
          'new-folder-btn',
          'more-actions-btn',
        ].map((id) => document.getElementById(id)),
        document.querySelector('.address-bar-wrapper'),
        ...document.querySelectorAll('#view-options [data-view]'),
      ].filter((element) => element && isVisible(element));
      const elementName = (element) =>
        element.id || (typeof element.className === 'string' ? element.className : element.tagName);
      const boundsFailures = controls
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            !toolbarRect ||
            rect.left < toolbarRect.left - 1 ||
            rect.top < toolbarRect.top - 1 ||
            rect.right > Math.min(toolbarRect.right, actualViewport.width) + 1 ||
            rect.bottom > Math.min(toolbarRect.bottom, actualViewport.height) + 1
          );
        })
        .map(elementName);
      const overlapFailures = [];
      for (let index = 0; index < controls.length; index += 1) {
        const left = controls[index];
        if (!left) continue;
        const leftRect = left.getBoundingClientRect();
        for (let otherIndex = index + 1; otherIndex < controls.length; otherIndex += 1) {
          const right = controls[otherIndex];
          if (!right) continue;
          const rightRect = right.getBoundingClientRect();
          if (
            leftRect.left < rightRect.right - 1 &&
            leftRect.right > rightRect.left + 1 &&
            leftRect.top < rightRect.bottom - 1 &&
            leftRect.bottom > rightRect.top + 1
          ) {
            overlapFailures.push(`${elementName(left)}/${elementName(right)}`);
          }
        }
      }
      return { controls: controls.length, boundsFailures, overlapFailures };
    };
    const capturePreviewSurface = async (testCase, screenshotName, minimumAlpha) => {
      const previewPath = `${WORKSPACE_PATH}/Readme.md`;
      await navigateToDirectory(WORKSPACE_PATH);
      const row = await findStableRow(
        previewPath,
        `Preview fixture row ${previewPath} is not connected to the settled grid.`
      );
      if (!(row instanceof HTMLElement)) {
        throw new Error(`Preview fixture row ${previewPath} is not connected to the current view.`);
      }
      const before = fixture.calls.length;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await waitForStable(
        () =>
          row.isConnected &&
          row.classList.contains('selected') &&
          isVisible(document.getElementById('status-selected')),
        'Selecting the preview fixture did not settle its renderer selection state.'
      );
      let toggle = document.getElementById('preview-toggle-btn');
      if (!isVisible(toggle)) {
        if (menuPanel()?.style.display !== 'block') menuButton()?.click();
        await doubleFrame();
        toggle = document.getElementById('preview-toggle-btn');
      }
      if (!(toggle instanceof HTMLElement) || !isVisible(toggle)) {
        throw new Error('The preview control is not reachable from the toolbar or More.');
      }
      toggle.click();
      const previewPanel = document.getElementById('preview-panel');
      await waitFor(
        () =>
          isVisible(previewPanel) &&
          Boolean(document.querySelector('#preview-content .preview-markdown h1')),
        'The full renderer did not finish the Markdown preview.'
      );
      await waitFor(
        () =>
          fixture.calls
            .slice(before)
            .some(
              (call) =>
                call.command === 'get_item_properties' &&
                call.args.itemPath === previewPath &&
                call.status === 'resolved'
            ),
        'The opened preview did not resolve its raw item-properties IPC fixture.',
        8000
      );
      const propertiesCall = fixture.calls
        .slice(before)
        .find(
          (call) => call.command === 'get_item_properties' && call.args.itemPath === previewPath
        );
      check(
        testCase,
        'opened preview properties resolve through the named raw-schema fixture',
        Boolean(
          propertiesCall &&
          propertiesCall.fixtureId === PROPERTIES_FIXTURE_ID &&
          propertiesCall.status === 'resolved'
        ),
        propertiesCall
          ? `${propertiesCall.fixtureId}:${propertiesCall.status}:${propertiesCall.args.itemPath}`
          : 'missing properties invocation',
        `${PROPERTIES_FIXTURE_ID}:resolved:${previewPath}`
      );
      await waitFor(
        () =>
          fixture.calls
            .slice(before)
            .some(
              (call) => call.command === 'read_file_content' && call.args.filePath === previewPath
            ),
        'Preview content did not reach the deterministic text-file fixture.'
      );
      const readCall = fixture.calls
        .slice(before)
        .find((call) => call.command === 'read_file_content' && call.args.filePath === previewPath);
      check(
        testCase,
        'preview text is read through its named IPC fixture',
        Boolean(
          readCall && readCall.fixtureId === PREVIEW_FIXTURE_ID && readCall.status === 'resolved'
        ),
        readCall ? `${readCall.fixtureId}:${readCall.status}:${readCall.args.filePath}` : 'missing',
        `${PREVIEW_FIXTURE_ID}:resolved:${previewPath}`
      );
      const surfaceColor = getComputedStyle(previewPanel).backgroundColor;
      const surfaceAlpha = computedColorAlpha(surfaceColor);
      await screenshot(testCase, screenshotName);
      check(
        testCase,
        `preview surface opacity is at least ${minimumAlpha}`,
        surfaceAlpha >= minimumAlpha,
        `${surfaceColor}; alpha=${surfaceAlpha}`,
        `alpha >= ${minimumAlpha}`
      );
      document.getElementById('preview-close')?.click();
      await waitFor(
        () => !isVisible(previewPanel),
        'The preview panel did not close after its evidence capture.'
      );
      if (menuPanel()?.style.display === 'block') {
        menuButton()?.click();
        await doubleFrame();
      }
    };
    const captureSettingsSurface = async (testCase, screenshotName, minimumAlpha) => {
      await openSettings();
      const settingsPanel = document.querySelector('#settings-modal .settings-modal');
      await waitFor(
        () => isVisible(settingsPanel),
        'The settings surface did not open for evidence.'
      );
      const surfaceColor = getComputedStyle(settingsPanel).backgroundColor;
      const surfaceAlpha = computedColorAlpha(surfaceColor);
      await screenshot(testCase, screenshotName);
      check(
        testCase,
        `settings surface opacity is at least ${minimumAlpha}`,
        surfaceAlpha >= minimumAlpha,
        `${surfaceColor}; alpha=${surfaceAlpha}`,
        `alpha >= ${minimumAlpha}`
      );
      await closeSettings();
    };
    const runFailedOperation = async (
      testCase,
      buttonId,
      nativeCommand,
      fixtureId,
      minimumSurfaceAlpha,
      screenshotName
    ) => {
      let button = document.getElementById(buttonId);
      if (!button) throw new Error(`Action button #${buttonId} is missing.`);
      if (!isVisible(button)) {
        if (menuPanel()?.style.display !== 'block') menuButton()?.click();
        await doubleFrame();
        button = document.getElementById(buttonId);
      }
      if (!button || !isVisible(button))
        throw new Error(`Action #${buttonId} is not reachable from the toolbar or More.`);
      const before = fixture.calls.length;
      button.click();
      await waitFor(
        () => fixture.calls.slice(before).some((call) => call.command === nativeCommand),
        `${nativeCommand} was not invoked.`,
        8000
      );
      await waitFor(
        () => document.getElementById('dialog-modal')?.style.display === 'flex',
        `${nativeCommand} did not show an error dialog.`
      );
      const message = textOf(document.getElementById('dialog-content'));
      check(
        testCase,
        `${nativeCommand} error is visible and actionable`,
        message.includes('Fixture operation error'),
        message,
        'visible fixture operation error'
      );
      check(
        testCase,
        `${nativeCommand} invocation identifies its deterministic fixture`,
        fixture.calls
          .slice(before)
          .some(
            (call) =>
              call.command === nativeCommand &&
              call.fixtureId === fixtureId &&
              call.status === 'rejected'
          ),
        fixture.calls
          .slice(before)
          .filter((call) => call.command === nativeCommand)
          .map((call) => `${call.fixtureId}:${call.status}`)
          .join(','),
        fixtureId + ':rejected'
      );
      const dialogSurface = document.querySelector('#dialog-modal .dialog-modal');
      if (!(dialogSurface instanceof HTMLElement)) {
        throw new Error(`${nativeCommand} error dialog surface is missing.`);
      }
      const surfaceColor = getComputedStyle(dialogSurface).backgroundColor;
      const surfaceAlpha = computedColorAlpha(surfaceColor);
      await screenshot(testCase, screenshotName);
      check(
        testCase,
        `${nativeCommand} error surface opacity is at least ${minimumSurfaceAlpha}`,
        surfaceAlpha >= minimumSurfaceAlpha,
        `${surfaceColor}; alpha=${surfaceAlpha}`,
        `alpha >= ${minimumSurfaceAlpha}`
      );
      document.getElementById('dialog-ok')?.click();
      await waitFor(
        () => document.getElementById('dialog-modal')?.style.display === 'none',
        'Operation error dialog did not close.'
      );
    };

    for (const viewport of VIEWPORTS) {
      await runCase(
        `layout-${viewport.width}x${viewport.height}`,
        { viewport },
        async (testCase) => {
          const actualViewport = await currentViewport(viewport.width, viewport.height);
          const shell = document.querySelector('.container');
          const toolbar = document.querySelector('[role="toolbar"]');
          const address = document.querySelector('.address-bar-wrapper');
          const more = menuButton();
          check(
            testCase,
            'complete file-browser shell is visible',
            Boolean(shell && isVisible(shell)),
            Boolean(shell && isVisible(shell)),
            true
          );
          check(
            testCase,
            'main toolbar is exposed',
            Boolean(toolbar && isVisible(toolbar)),
            Boolean(toolbar && isVisible(toolbar)),
            true
          );
          check(
            testCase,
            'path field keeps useful width',
            Boolean(address && address.getBoundingClientRect().width >= 100),
            Math.round(address?.getBoundingClientRect().width || 0),
            'at least 100 CSS px'
          );
          check(
            testCase,
            'More control is visible and labelled',
            Boolean(more && isVisible(more) && more.getAttribute('aria-label')),
            more?.getAttribute('aria-label') || 'missing',
            'visible labelled button'
          );
          check(
            testCase,
            'navigation, search, view, and new-folder actions remain reachable',
            ['back-btn', 'forward-btn', 'up-btn', 'search-btn', 'new-folder-btn'].every(
              moreCanReach
            ) && Boolean(document.querySelector('#view-options, #view-toggle-btn')),
            ['back-btn', 'forward-btn', 'up-btn', 'search-btn', 'new-folder-btn']
              .filter((id) => !moreCanReach(id))
              .join(', ') || 'all present',
            'all present in toolbar or More'
          );
          const sidebarActions = Array.from(
            document.querySelectorAll('#sidebar-quick-access-grid .quick-action')
          );
          check(
            testCase,
            'sidebar destinations stay keyboard reachable',
            sidebarActions.length >= 6 &&
              sidebarActions.every(
                (item) => item.getAttribute('role') === 'button' && item.tabIndex >= 0
              ),
            `${sidebarActions.length} rows; ${sidebarActions.filter((item) => item.tabIndex < 0).length} without tab stop`,
            'at least six labelled tab stops'
          );
          check(
            testCase,
            'layout does not introduce horizontal page scrolling',
            document.documentElement.scrollWidth <= actualViewport.width + 1,
            document.documentElement.scrollWidth,
            `<= ${actualViewport.width}`
          );
          const geometry = inspectPrimaryControlGeometry(actualViewport);
          check(
            testCase,
            'visible primary control bounds fit within the toolbar and viewport',
            geometry.boundsFailures.length === 0,
            geometry.boundsFailures.join(', ') || `${geometry.controls} controls within bounds`,
            'all visible controls contained'
          );
          check(
            testCase,
            'visible primary controls do not overlap',
            geometry.overlapFailures.length === 0,
            geometry.overlapFailures.join(', ') || 'no overlapping controls',
            'no overlapping control bounds'
          );
          if (viewport.width === 800) {
            more?.click();
            await doubleFrame();
            const panel = menuPanel();
            const responsiveTargets = ['up-btn', 'new-folder-btn'];
            check(
              testCase,
              'narrow-window Up and New Folder remain available after opening More',
              responsiveTargets.every((id) => {
                const element = document.getElementById(id);
                return (
                  isVisible(element) || Boolean(panel?.contains(element) && isVisible(element))
                );
              }),
              responsiveTargets
                .map((id) => `${id}:${isVisible(document.getElementById(id))}`)
                .join(', '),
              'both visible in the toolbar or open More menu'
            );
            const panelView = document.getElementById('view-toggle-btn');
            const radioView = document.querySelector('#view-options [data-view="grid"]');
            const viewControl = [panelView, radioView].find(
              (element) => element && (isVisible(element) || panel?.contains(element))
            );
            check(
              testCase,
              'narrow-window view control remains available after opening More',
              isVisible(viewControl) ||
                Boolean(panel?.contains(viewControl) && isVisible(viewControl)),
              viewControl instanceof HTMLElement
                ? `${viewControl.id || viewControl.getAttribute('aria-label')}:${isVisible(viewControl)}`
                : 'missing',
              'visible in the toolbar or open More menu'
            );
            dispatchKey('Escape');
            await doubleFrame();
          }
        }
      );
    }

    await runCase(
      'toolbar-priorities-and-more',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        await currentViewport(1200, 800);
        const panel = menuPanel();
        const actions = ['refresh-btn', 'new-file-btn', 'sort-btn'];
        check(
          testCase,
          'refresh, new-file, and sort controls are in More',
          Boolean(panel && actions.every((id) => panel.contains(document.getElementById(id)))),
          actions
            .map((id) => `${id}:${Boolean(panel?.contains(document.getElementById(id)))}`)
            .join(', '),
          'all three inside #more-actions-menu'
        );
        const more = menuButton();
        more?.click();
        await doubleFrame();
        check(
          testCase,
          'More opens with expanded state',
          panel?.style.display === 'block' && more?.getAttribute('aria-expanded') === 'true',
          `${panel?.style.display}; ${more?.getAttribute('aria-expanded')}`,
          'block; true'
        );
        check(
          testCase,
          'More actions are visible when the menu opens',
          actions.every((id) => isVisible(document.getElementById(id))),
          actions.filter((id) => !isVisible(document.getElementById(id))).join(', ') ||
            'all visible',
          'refresh, new file, sort visible'
        );
        dispatchKey('ArrowDown');
        await doubleFrame();
        check(
          testCase,
          'More keyboard navigation keeps focus in the menu',
          Boolean(panel?.contains(document.activeElement)),
          document.activeElement instanceof HTMLElement
            ? document.activeElement.id ||
                document.activeElement.getAttribute('aria-label') ||
                document.activeElement.tagName
            : 'none',
          'focus inside More menu'
        );
        dispatchKey('Escape');
        await doubleFrame();
        check(
          testCase,
          'Escape closes More and restores its trigger focus',
          panel?.style.display !== 'block' && document.activeElement === more,
          `${panel?.style.display}; focus=${document.activeElement instanceof HTMLElement ? document.activeElement.id : 'none'}`,
          'closed; focus=more-actions-btn'
        );
      }
    );

    await runCase(
      'navigation-history-editable-path',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        await currentViewport(1200, 800);
        const docs = Array.from(document.querySelectorAll('#file-grid .file-item')).find(
          (item) => item.getAttribute('data-path') === DOCUMENTS_PATH
        );
        if (!docs) throw new Error('The deterministic Documents row was not rendered.');
        docs.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await waitFor(
          () =>
            fixture.directoryLoads.at(-1) === DOCUMENTS_PATH && directoryIsRendered(DOCUMENTS_PATH),
          'Opening Documents did not finish rendering its fixture directory.'
        );
        check(
          testCase,
          'opening a directory updates its path',
          fixture.directoryLoads.at(-1) === DOCUMENTS_PATH && directoryIsRendered(DOCUMENTS_PATH),
          `${fixture.directoryLoads.at(-1)}; rendered=${directoryIsRendered(DOCUMENTS_PATH)}`,
          DOCUMENTS_PATH
        );
        check(
          testCase,
          'Back is enabled after folder navigation',
          document.getElementById('back-btn')?.hasAttribute('disabled') === false,
          document.getElementById('back-btn')?.hasAttribute('disabled'),
          false
        );
        document.getElementById('back-btn')?.click();
        await waitFor(
          () =>
            fixture.directoryLoads.at(-1) === WORKSPACE_PATH && directoryIsRendered(WORKSPACE_PATH),
          'Back did not finish rendering the starting directory.'
        );
        check(
          testCase,
          'Back returns to the previous directory',
          fixture.directoryLoads.at(-1) === WORKSPACE_PATH && directoryIsRendered(WORKSPACE_PATH),
          `${fixture.directoryLoads.at(-1)}; rendered=${directoryIsRendered(WORKSPACE_PATH)}`,
          WORKSPACE_PATH
        );
        document.getElementById('forward-btn')?.click();
        await waitFor(
          () =>
            fixture.directoryLoads.at(-1) === DOCUMENTS_PATH && directoryIsRendered(DOCUMENTS_PATH),
          'Forward did not finish rendering the next directory.'
        );
        check(
          testCase,
          'Forward restores the next directory',
          fixture.directoryLoads.at(-1) === DOCUMENTS_PATH && directoryIsRendered(DOCUMENTS_PATH),
          `${fixture.directoryLoads.at(-1)}; rendered=${directoryIsRendered(DOCUMENTS_PATH)}`,
          DOCUMENTS_PATH
        );
        document.getElementById('up-btn')?.click();
        await waitFor(
          () =>
            fixture.directoryLoads.at(-1) === WORKSPACE_PATH && directoryIsRendered(WORKSPACE_PATH),
          'Up did not finish rendering the parent directory.'
        );
        check(
          testCase,
          'Up navigates to the parent directory',
          fixture.directoryLoads.at(-1) === WORKSPACE_PATH && directoryIsRendered(WORKSPACE_PATH),
          `${fixture.directoryLoads.at(-1)}; rendered=${directoryIsRendered(WORKSPACE_PATH)}`,
          WORKSPACE_PATH
        );
        dispatchKey('l', { ctrlKey: true });
        const address = document.getElementById('address-input');
        check(
          testCase,
          'Ctrl+L exposes and focuses the editable path',
          Boolean(address && isVisible(address) && document.activeElement === address),
          `${address?.style.display}; focus=${document.activeElement instanceof HTMLElement ? document.activeElement.id : 'none'}`,
          'visible and focused address-input'
        );
        if (address instanceof HTMLInputElement) {
          address.value = PROJECTS_PATH;
          address.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
          );
        }
        await waitFor(
          () =>
            fixture.directoryLoads.at(-1) === PROJECTS_PATH && directoryIsRendered(PROJECTS_PATH),
          'Submitting the editable path did not navigate.'
        );
        check(
          testCase,
          'editable path navigation loads the requested folder',
          fixture.directoryLoads.at(-1) === PROJECTS_PATH && directoryIsRendered(PROJECTS_PATH),
          `${fixture.directoryLoads.at(-1)}; rendered=${directoryIsRendered(PROJECTS_PATH)}`,
          PROJECTS_PATH
        );
        check(
          testCase,
          'address field remains present after direct navigation',
          Boolean(document.getElementById('address-input')),
          Boolean(document.getElementById('address-input')),
          true
        );
      }
    );

    await runCase(
      'views-selection-tabs',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        await currentViewport(1200, 800);
        const modes = ['list', 'column', 'grid'];
        for (const mode of modes) {
          const loadsBefore = fixture.directoryLoads.length;
          const option = document.querySelector(`#view-options [data-view="${mode}"]`);
          const selected = option;
          if (option instanceof HTMLElement && isVisible(option)) option.click();
          else document.getElementById('view-toggle-btn')?.click();
          const isRenderedMode = () => {
            const grid = document.getElementById('file-grid');
            const loading = document.getElementById('loading');
            const loadSettled = !loading || getComputedStyle(loading).display === 'none';
            if (mode === 'column') {
              const columns = document.getElementById('column-view');
              return Boolean(
                columns &&
                isVisible(columns) &&
                columns.querySelectorAll('.column-pane').length >= 4 &&
                loadSettled &&
                selected?.classList.contains('active') &&
                ['/', '/fixture', WORKSPACE_PATH, PROJECTS_PATH].every((path) =>
                  fixture.directoryLoads.slice(loadsBefore).includes(path)
                )
              );
            }
            return Boolean(
              grid &&
              isVisible(grid) &&
              loadSettled &&
              selected?.classList.contains('active') &&
              fixture.directoryLoads.slice(loadsBefore).at(-1) === PROJECTS_PATH &&
              directoryIsRendered(PROJECTS_PATH) &&
              (mode === 'list'
                ? grid.classList.contains('list-view')
                : !grid.classList.contains('list-view'))
            );
          };
          await waitForStable(
            isRenderedMode,
            `${mode} view did not finish rendering and settle.`,
            12000
          );
          check(
            testCase,
            `${mode} view finishes rendering`,
            isRenderedMode(),
            selected?.classList.contains('active') ? `${mode} view is active` : 'view is inactive',
            mode
          );
          check(
            testCase,
            `${mode} view exposes its selected state to assistive technology`,
            selected?.getAttribute('aria-checked') === 'true',
            selected?.getAttribute('aria-checked') || 'missing',
            'true'
          );
        }
        await waitForStable(
          () =>
            directoryIsRendered(PROJECTS_PATH) &&
            document
              .querySelector('#view-options [data-view="grid"]')
              ?.classList.contains('active'),
          'The grid view did not settle its current-directory load before selection.',
          12000
        );
        const filePath = `${PROJECTS_PATH}/Design.md`;
        const file = Array.from(document.querySelectorAll('#file-grid .file-item')).find(
          (item) => item.getAttribute('data-path') === filePath
        );
        if (!(file instanceof HTMLElement) || !file.isConnected) {
          throw new Error(`The deterministic selection row ${filePath} is not connected.`);
        }
        file.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitForStable(
          () =>
            file.isConnected &&
            (file.classList.contains('selected') ||
              file.getAttribute('aria-selected') === 'true') &&
            isVisible(document.getElementById('status-selected')) &&
            directoryIsRendered(PROJECTS_PATH),
          'Selection status did not settle after clicking the connected grid row.',
          8000
        );
        check(
          testCase,
          'selected item is reported in the status bar',
          isVisible(document.getElementById('status-selected')),
          isVisible(document.getElementById('status-selected')),
          true
        );
        check(
          testCase,
          'selected item has selected state',
          file.classList.contains('selected') || file.getAttribute('aria-selected') === 'true',
          `${file.className}; aria-selected=${file.getAttribute('aria-selected')}`,
          'selected'
        );
        const selectionActions = Array.from(
          document.querySelectorAll('[role="toolbar"] .selection-action')
        ).filter(isVisible);
        check(
          testCase,
          'selection state does not add persistent toolbar actions',
          selectionActions.length === 0,
          `${selectionActions.length} visible selection actions`,
          '0 visible selection actions'
        );
        const tabBar = document.getElementById('tab-bar');
        const newTab = document.getElementById('new-tab-btn');
        check(
          testCase,
          'tabs and new-tab control are visible',
          Boolean(tabBar && isVisible(tabBar) && newTab && isVisible(newTab)),
          `${Boolean(tabBar && isVisible(tabBar))}; ${Boolean(newTab && isVisible(newTab))}`,
          true
        );
        newTab?.click();
        await waitFor(
          () => (document.getElementById('tab-list')?.children.length || 0) >= 2,
          'New tab did not create a second tab.'
        );
        check(
          testCase,
          'new tab adds an independently selectable tab',
          (document.getElementById('tab-list')?.children.length || 0) >= 2,
          document.getElementById('tab-list')?.children.length || 0,
          'at least 2'
        );
        const firstTab = document.querySelector('#tab-list [role="tab"]');
        firstTab?.click();
        await doubleFrame();
        check(
          testCase,
          'tab list keeps tab semantics',
          document.querySelectorAll('#tab-list [role="tab"]').length >= 2,
          document.querySelectorAll('#tab-list [role="tab"]').length,
          'at least 2 role=tab items'
        );
      }
    );

    await runCase(
      'dual-pane-active-secondary-copy-move',
      {
        viewport: { width: 1200, height: 800 },
        fixtureIds: [
          DUAL_PANE_FIXTURE_IDS.copy,
          DUAL_PANE_FIXTURE_IDS.move,
          DUAL_PANE_FIXTURE_IDS.dragCleanup,
        ],
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        dispatchKey('l', { ctrlKey: true });
        const address = document.getElementById('address-input');
        if (!(address instanceof HTMLInputElement)) {
          throw new Error('Editable path control is unavailable for the dual-pane case.');
        }
        address.value = WORKSPACE_PATH;
        address.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
        await waitFor(
          () => directoryIsRendered(WORKSPACE_PATH),
          'Dual-pane setup could not finish loading the primary workspace.'
        );
        await setSettingAndSave('dual-pane-toggle', true);
        const secondary = document.getElementById('dual-pane-secondary');
        const secondaryList = document.getElementById('dual-pane-secondary-list');
        const secondaryPath = document.getElementById('dual-pane-secondary-path');
        await waitFor(
          () =>
            isVisible(secondary) &&
            secondaryPath?.textContent?.trim() === WORKSPACE_PATH &&
            Boolean(secondaryList?.querySelector('.dual-pane-item')),
          'The real secondary pane did not load the deterministic workspace.'
        );
        const projectsRow = Array.from(secondaryList.querySelectorAll('.dual-pane-item')).find(
          (item) => item.getAttribute('data-path') === PROJECTS_PATH
        );
        if (!(projectsRow instanceof HTMLElement) || !projectsRow.isConnected) {
          throw new Error('The secondary pane has no connected Projects fixture row.');
        }
        projectsRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await waitFor(
          () =>
            secondaryPath?.textContent?.trim() === PROJECTS_PATH &&
            Boolean(
              Array.from(secondaryList.querySelectorAll('.dual-pane-item')).find(
                (item) => item.getAttribute('data-path') === SECONDARY_COPY_PATH
              )
            ),
          'The secondary pane did not finish opening its Projects directory.'
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        await waitForStable(() => {
          const loading = document.getElementById('loading');
          return !loading || getComputedStyle(loading).display === 'none';
        }, 'Directory work did not settle before selecting in the secondary pane.');

        const selectSecondaryPath = async (itemPath) => {
          const row = Array.from(secondaryList.querySelectorAll('.dual-pane-item')).find(
            (item) => item.getAttribute('data-path') === itemPath
          );
          if (!(row instanceof HTMLElement) || !row.isConnected) {
            throw new Error(`Secondary source row ${itemPath} is not connected.`);
          }
          row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await waitForStable(
            () =>
              row.isConnected &&
              row.classList.contains('selected') &&
              row.getAttribute('aria-selected') === 'true' &&
              document.body.classList.contains('active-pane-right') &&
              textOf(document.getElementById('status-selected')).startsWith('1 selected') &&
              isVisible(document.getElementById('status-selected')),
            `Secondary selection ${itemPath} did not settle in the active right pane.`
          );
          await waitFor(
            () => document.getElementById('copy-to-other-pane-btn')?.disabled === false,
            `The copy command did not enable after the secondary selection ${itemPath}.`,
            2000
          ).catch(() => {});
          return row;
        };
        const invokePaneCommand = async (buttonId, command, itemPath, fixtureId) => {
          let button = document.getElementById(buttonId);
          if (!button) throw new Error(`Dual-pane command #${buttonId} is missing.`);
          if (!isVisible(button)) {
            if (menuPanel()?.style.display !== 'block') menuButton()?.click();
            await doubleFrame();
            button = document.getElementById(buttonId);
          }
          if (!(button instanceof HTMLElement) || !isVisible(button)) {
            throw new Error(`Dual-pane command #${buttonId} is not reachable.`);
          }
          if (button instanceof HTMLInputElement || button instanceof HTMLSelectElement) {
            throw new Error(`Dual-pane command #${buttonId} is not a button.`);
          }
          const before = fixture.calls.length;
          button.click();
          await waitFor(
            () =>
              fixture.calls
                .slice(before)
                .some((call) => call.command === command && call.status === 'resolved'),
            `${command} did not complete through its native fixture.`,
            10000
          );
          const call = fixture.calls
            .slice(before)
            .find((candidate) => candidate.command === command && candidate.status === 'resolved');
          const expectedDestination = WORKSPACE_PATH;
          const expectedArguments =
            call?.args.sourcePaths?.length === 1 &&
            call.args.sourcePaths[0] === itemPath &&
            call.args.destPath === expectedDestination;
          check(
            testCase,
            `${command} keeps the selected secondary source and primary destination`,
            Boolean(call && call.fixtureId === fixtureId && expectedArguments),
            call
              ? `${call.fixtureId}; sources=${JSON.stringify(call.args.sourcePaths)}; destination=${call.args.destPath}; status=${call.status}`
              : 'missing native command invocation',
            `${fixtureId}; sources=[${itemPath}]; destination=${expectedDestination}; resolved`
          );
          if (menuPanel()?.style.display === 'block') {
            menuButton()?.click();
            await doubleFrame();
          }
        };

        await selectSecondaryPath(SECONDARY_COPY_PATH);
        await screenshot(testCase, 'app-dual-pane-active-copy-source');
        const copyButton = document.getElementById('copy-to-other-pane-btn');
        check(
          testCase,
          'copy command is enabled for an active secondary selection',
          copyButton?.hasAttribute('disabled') === false,
          copyButton
            ? `disabled=${copyButton.hasAttribute('disabled')}; display=${copyButton.style.display}; bodyRight=${document.body.classList.contains('active-pane-right')}; status=${textOf(document.getElementById('status-selected'))}; count=${textOf(document.getElementById('selection-count'))}`
            : 'missing',
          false
        );
        if (copyButton?.disabled) copyButton.disabled = false;
        const secondaryLoadsBeforeCopy = fixture.directoryLoads.length;
        await invokePaneCommand(
          'copy-to-other-pane-btn',
          'copy_items',
          SECONDARY_COPY_PATH,
          DUAL_PANE_FIXTURE_IDS.copy
        );
        await waitFor(
          () =>
            fixture.directoryLoads.slice(secondaryLoadsBeforeCopy).includes(PROJECTS_PATH) &&
            fixture.directoryLoads.slice(secondaryLoadsBeforeCopy).includes(WORKSPACE_PATH) &&
            Boolean(
              Array.from(secondaryList.querySelectorAll('.dual-pane-item')).find(
                (item) => item.isConnected && item.getAttribute('data-path') === SECONDARY_MOVE_PATH
              )
            ) &&
            fixture.directoryData
              .get(WORKSPACE_PATH)
              .some((item) => item.path === `${WORKSPACE_PATH}/Design.md`),
          'The copy refresh did not settle the secondary pane, the primary pane, and deterministic primary data.'
        );
        check(
          testCase,
          'successful copy refreshes both panes through the fixture contract',
          fixture.directoryLoads.slice(secondaryLoadsBeforeCopy).includes(PROJECTS_PATH) &&
            fixture.directoryLoads.slice(secondaryLoadsBeforeCopy).includes(WORKSPACE_PATH),
          fixture.directoryLoads.slice(secondaryLoadsBeforeCopy).join(', '),
          `${PROJECTS_PATH} and ${WORKSPACE_PATH}`
        );
        check(
          testCase,
          'successful copy reports visible completion feedback',
          textOf(document.getElementById('toast-container')).includes('Copied 1 item'),
          textOf(document.getElementById('toast-container')) || 'no toast',
          'Copied 1 item'
        );

        await selectSecondaryPath(SECONDARY_MOVE_PATH);
        await screenshot(testCase, 'app-dual-pane-active-move-source');
        await invokePaneCommand(
          'move-to-other-pane-btn',
          'move_items',
          SECONDARY_MOVE_PATH,
          DUAL_PANE_FIXTURE_IDS.move
        );
        check(
          testCase,
          'move fixture updates both deterministic pane directories',
          !fixture.directoryData
            .get(PROJECTS_PATH)
            .some((item) => item.path === SECONDARY_MOVE_PATH) &&
            fixture.directoryData
              .get(WORKSPACE_PATH)
              .some((item) => item.path === `${WORKSPACE_PATH}/Source.txt`),
          `${fixture.directoryData.get(PROJECTS_PATH).some((item) => item.path === SECONDARY_MOVE_PATH)}; ${fixture.directoryData.get(WORKSPACE_PATH).some((item) => item.path === `${WORKSPACE_PATH}/Source.txt`)}`,
          'source removed from Projects and copied to Workspace'
        );
      },
      async () => {
        if (fixture.settingsStore.dualPaneEnabled) {
          await setSettingAndSave('dual-pane-toggle', false);
        }
      }
    );

    await runCase(
      'home-settings-inflight-edit',
      {
        viewport: { width: 1200, height: 800 },
        fixtureIds: [HOME_SETTINGS_SAVE_RACE_FIXTURE_ID],
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        const home = document.querySelector('#sidebar-quick-access-grid [data-action="home"]');
        if (!home) throw new Error('Home sidebar destination is missing for the save-race case.');
        home.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(
          () => isVisible(document.getElementById('home-view')),
          'Home view did not open for the save-race case.'
        );
        check(
          testCase,
          'Home save-race fixture starts with both sections visible',
          fixture.homeSettingsStore.showRecents === true &&
            fixture.homeSettingsStore.showQuickAccess === true,
          `recents=${fixture.homeSettingsStore.showRecents}; quickAccess=${fixture.homeSettingsStore.showQuickAccess}`,
          'recents=true; quickAccess=true'
        );
        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not open for the save-race case.'
        );
        const recentsToggle = document.getElementById('home-toggle-recents');
        const quickAccessToggle = document.getElementById('home-toggle-quick-access');
        if (!(recentsToggle instanceof HTMLInputElement)) {
          throw new Error('Home recents toggle is missing for the save-race case.');
        }
        if (!(quickAccessToggle instanceof HTMLInputElement)) {
          throw new Error('Home Quick Access toggle is missing for the save-race case.');
        }
        recentsToggle.checked = false;
        recentsToggle.dispatchEvent(new Event('change', { bubbles: true }));

        const gate = fixture.homeSettingsSaveGate;
        gate.enabled = true;
        gate.started = false;
        gate.invocations = 0;
        const caseSaves = () =>
          fixture.calls.filter(
            (call) =>
              call.caseId === testCase.caseId &&
              call.command === 'save_home_settings' &&
              call.fixtureId === HOME_SETTINGS_SAVE_RACE_FIXTURE_ID
          );
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => gate.started && caseSaves().length === 1,
          'The first Home save did not reach its deterministic held-response gate.',
          8000
        );

        quickAccessToggle.checked = false;
        quickAccessToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const firstCall = caseSaves()[0];
        const firstSubmitted = JSON.parse(firstCall.args.settings);
        check(
          testCase,
          'held first save contains Recents=false and the earlier Quick Access value',
          firstSubmitted.showRecents === false && firstSubmitted.showQuickAccess === true,
          `submitted recents=${firstSubmitted.showRecents}; quickAccess=${firstSubmitted.showQuickAccess}`,
          'recents=false; quickAccess=true'
        );
        check(
          testCase,
          'the newer Quick Access edit is made while the native response is held',
          gate.started && quickAccessToggle.checked === false,
          `held=${gate.started}; quickAccess=${quickAccessToggle.checked}`,
          'held=true; quickAccess=false'
        );

        gate.release?.();
        await waitFor(
          () => caseSaves()[0]?.status === 'resolved',
          'The held first Home save did not resolve after release.'
        );
        await doubleFrame();
        const homeSettingsModal = document.getElementById('home-settings-modal');
        check(
          testCase,
          'first response commits Recents hidden without persisting the newer Quick Access edit',
          fixture.homeSettingsStore.showRecents === false &&
            fixture.homeSettingsStore.showQuickAccess === true &&
            getComputedStyle(document.getElementById('home-section-recents')).display === 'none',
          `store recents=${fixture.homeSettingsStore.showRecents}; quickAccess=${fixture.homeSettingsStore.showQuickAccess}; section=${getComputedStyle(document.getElementById('home-section-recents')).display}`,
          'recents=false; quickAccess=true; recents section hidden'
        );
        check(
          testCase,
          'newer Quick Access edit remains pending in the open Home preferences dialog',
          homeSettingsModal?.style.display === 'flex' && quickAccessToggle.checked === false,
          `modal=${homeSettingsModal?.style.display}; quickAccess=${quickAccessToggle.checked}`,
          'modal=flex; quickAccess=false'
        );

        if (homeSettingsModal?.style.display !== 'flex') {
          document.getElementById('home-customize-btn')?.click();
          await waitFor(
            () => homeSettingsModal?.style.display === 'flex',
            'Home preferences could not be reopened to complete the second save.'
          );
        }
        if (quickAccessToggle.checked) {
          quickAccessToggle.checked = false;
          quickAccessToggle.dispatchEvent(new Event('change', { bubbles: true }));
        }
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => caseSaves().filter((call) => call.status === 'resolved').length === 2,
          'The second Home save did not resolve both pending preference values.',
          8000
        );
        const secondCall = caseSaves()[1];
        const secondSubmitted = JSON.parse(secondCall.args.settings);
        check(
          testCase,
          'second Home save submits both preferences as hidden',
          secondSubmitted.showRecents === false && secondSubmitted.showQuickAccess === false,
          `submitted recents=${secondSubmitted.showRecents}; quickAccess=${secondSubmitted.showQuickAccess}`,
          'recents=false; quickAccess=false'
        );
        check(
          testCase,
          'exactly two Home saves use the held-response fixture',
          gate.invocations === 2 && caseSaves().length === 2,
          `gate invocations=${gate.invocations}; IPC calls=${caseSaves().length}`,
          '2 gate invocations; 2 IPC calls'
        );
        check(
          testCase,
          'both Home preferences persist after the second save',
          fixture.homeSettingsStore.showRecents === false &&
            fixture.homeSettingsStore.showQuickAccess === false,
          `recents=${fixture.homeSettingsStore.showRecents}; quickAccess=${fixture.homeSettingsStore.showQuickAccess}`,
          'recents=false; quickAccess=false'
        );
        let modalClosed = homeSettingsModal?.style.display === 'none';
        if (!modalClosed) {
          try {
            await waitFor(
              () => homeSettingsModal?.style.display === 'none',
              'Home preferences did not close after the second save.',
              4000
            );
            modalClosed = true;
          } catch {
            modalClosed = false;
          }
        }
        check(
          testCase,
          'Home preferences close after the second save',
          modalClosed,
          homeSettingsModal?.style.display || 'missing',
          'none'
        );
      },
      async () => {
        const gate = fixture.homeSettingsSaveGate;
        gate.release?.();
        gate.enabled = false;
        if (gate.timeout) clearTimeout(gate.timeout);
        gate.timeout = null;
        const modal = document.getElementById('home-settings-modal');
        if (modal?.style.display === 'flex') {
          document.getElementById('home-settings-cancel')?.click();
          const dialog = document.getElementById('dialog-modal');
          await waitFor(
            () => modal.style.display === 'none' || dialog?.style.display === 'flex',
            'Home save-race cleanup did not close preferences or show discard confirmation.',
            4000
          );
          if (dialog?.style.display === 'flex') {
            document.getElementById('dialog-ok')?.click();
            await waitFor(
              () => modal.style.display === 'none',
              'Home save-race discard confirmation did not close preferences.',
              4000
            );
          }
        }
      }
    );

    await runCase(
      'search-and-home',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        await currentViewport(1200, 800);
        const homeDestination = document.querySelector(
          '#sidebar-quick-access-grid [data-action="home"]'
        );
        if (!homeDestination) throw new Error('Home sidebar destination is missing.');
        homeDestination.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(
          () => isVisible(document.getElementById('home-view')),
          'Home view did not open before the search case.'
        );
        const searchButton = document.getElementById('search-btn');
        searchButton?.click();
        await waitFor(
          () => isVisible(document.getElementById('search-input')),
          'Search input did not open.'
        );
        const searchScope = document.getElementById('search-scope-toggle');
        check(
          testCase,
          'search scope is visible and labelled while searching from Home',
          Boolean(
            searchScope &&
            isVisible(searchScope) &&
            searchScope.getAttribute('aria-pressed') === 'true' &&
            searchScope.getAttribute('aria-label')
          ),
          searchScope
            ? `visible=${isVisible(searchScope)}; pressed=${searchScope.getAttribute('aria-pressed')}; label=${searchScope.getAttribute('aria-label')}`
            : 'missing',
          'visible global scope with label'
        );
        const searchInput = document.getElementById('search-input');
        if (!(searchInput instanceof HTMLInputElement)) throw new Error('Search input is missing.');
        searchInput.value = 'meeting';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
        await waitFor(
          () =>
            fixture.calls.some(
              (call) =>
                call.caseId === testCase.caseId &&
                call.status === 'resolved' &&
                (call.command === 'search_files' || call.command === 'search_index')
            ),
          'Search did not reach the deterministic native fixture.',
          8000
        );
        await waitForStable(
          () => {
            const loading = document.getElementById('loading');
            return (
              textOf(document.getElementById('file-grid'))
                .toLowerCase()
                .includes('meeting-notes.txt') &&
              (!loading || getComputedStyle(loading).display === 'none')
            );
          },
          'The native search result did not finish rendering its expected match.',
          10000
        );
        check(
          testCase,
          'search fixture returns a rendered match',
          textOf(document.getElementById('file-grid')).toLowerCase().includes('meeting-notes.txt'),
          textOf(document.getElementById('file-grid')),
          'contains Meeting-Notes.txt'
        );
        document.getElementById('search-close')?.click();
        await doubleFrame();
        const home = document.querySelector('#sidebar-quick-access-grid [data-action="home"]');
        if (!home) throw new Error('Home sidebar destination is missing.');
        home.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(
          () => isVisible(document.getElementById('home-view')),
          'Home view did not open.'
        );
        check(
          testCase,
          'Home opens with its primary content',
          isVisible(document.getElementById('home-view')) &&
            Boolean(document.getElementById('home-quick-access')),
          `${isVisible(document.getElementById('home-view'))}; quick access=${Boolean(document.getElementById('home-quick-access'))}`,
          true
        );
        const homeModalButton = document.getElementById('home-customize-btn');
        homeModalButton?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not open.'
        );
        const recentsToggle = document.getElementById('home-toggle-recents');
        if (!(recentsToggle instanceof HTMLInputElement))
          throw new Error('Home recents preference is missing.');
        recentsToggle.checked = false;
        recentsToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const savesBefore = fixture.saveHomeSettingsCount;
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => fixture.saveHomeSettingsCount > savesBefore,
          'Home preferences did not reach the deterministic save fixture.'
        );
        await doubleFrame();
        const homeModal = document.getElementById('home-settings-modal');
        const homeModalClosed = homeModal?.style.display === 'none';
        check(
          testCase,
          'Home preferences close after saving changes',
          homeModalClosed,
          homeModal?.style.display || 'missing',
          'none'
        );
        const savedHome = await window.tauriAPI.getHomeSettings();
        check(
          testCase,
          'Home visibility preference persists through native settings storage',
          savedHome.success &&
            savedHome.settings.showRecents === false &&
            fixture.homeSettingsStore.showRecents === false,
          `${savedHome.success}; recents=${savedHome.settings?.showRecents}; fixture=${fixture.homeSettingsStore.showRecents}`,
          'saved showRecents=false'
        );
        check(
          testCase,
          'Home hides the saved recents section cleanly',
          getComputedStyle(document.getElementById('home-section-recents')).display === 'none',
          getComputedStyle(document.getElementById('home-section-recents')).display,
          'none'
        );
        if (!homeModalClosed && homeModal) {
          document.getElementById('home-settings-cancel')?.click();
          const dialog = document.getElementById('dialog-modal');
          await waitFor(
            () => homeModal.style.display === 'none' || dialog?.style.display === 'flex',
            'Home preferences cleanup did not close or request discard confirmation.'
          );
          if (dialog?.style.display === 'flex') {
            check(
              testCase,
              'Home discard confirmation is shown during failed-save cleanup',
              document.getElementById('dialog-title')?.textContent === 'Unsaved Changes',
              document.getElementById('dialog-title')?.textContent || 'missing',
              'Unsaved Changes'
            );
            document.getElementById('dialog-ok')?.click();
          }
          await waitFor(
            () => homeModal.style.display === 'none',
            'Home preferences cleanup did not close after confirming discard.'
          );
        }
        await screenshot(testCase, 'app-home-quiet');
      }
    );

    await runCase(
      'representative-operation-errors',
      {
        viewport: { width: 1200, height: 800 },
        fixtureIds: [
          EXPECTED_OPERATION_FIXTURES['create-folder'],
          EXPECTED_OPERATION_FIXTURES['create-file'],
        ],
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        const navigateHome = document.querySelector(
          '#sidebar-quick-access-grid [data-action="home"]'
        );
        if (navigateHome && isVisible(navigateHome)) {
          // Return to the working directory using the real editable path control below.
          navigateHome.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        dispatchKey('l', { ctrlKey: true });
        const address = document.getElementById('address-input');
        if (!(address instanceof HTMLInputElement))
          throw new Error('Editable path control is unavailable for operation cases.');
        address.value = WORKSPACE_PATH;
        address.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
        await waitFor(
          () =>
            fixture.directoryLoads.at(-1) === WORKSPACE_PATH && directoryIsRendered(WORKSPACE_PATH),
          'Operation cases could not finish rendering the workspace.'
        );

        await runFailedOperation(
          testCase,
          'new-folder-btn',
          'create_folder',
          EXPECTED_OPERATION_FIXTURES['create-folder'],
          0.94,
          'app-create-folder-error'
        );
        await runFailedOperation(
          testCase,
          'new-file-btn',
          'create_file',
          EXPECTED_OPERATION_FIXTURES['create-file'],
          0.94,
          'app-create-file-error'
        );
      }
    );

    for (const theme of THEME_VALUES) {
      await runCase(
        `theme-${theme}`,
        {
          viewport: { width: 1200, height: 800 },
          theme,
          fixtureIds: [
            PREVIEW_FIXTURE_ID,
            PROPERTIES_FIXTURE_ID,
            EXPECTED_OPERATION_FIXTURES['create-folder'],
          ],
        },
        async (testCase) => {
          await currentViewport(1200, 800);
          await openSettings();
          await changeSetting('theme-select', theme);
          await saveSettings();
          const expectedClass = theme === 'default' ? '' : `theme-${theme}`;
          const hasExpectedClass = expectedClass
            ? document.body.classList.contains(expectedClass)
            : !Array.from(document.body.classList).some((value) => value.startsWith('theme-'));
          const roundTrip = await window.tauriAPI.getSettings();
          await screenshot(testCase, `app-theme-${theme}`);
          check(
            testCase,
            'selected theme is applied to the complete renderer',
            hasExpectedClass,
            Array.from(document.body.classList)
              .filter((value) => value.startsWith('theme-'))
              .join(' ') || 'default',
            expectedClass || 'default theme'
          );
          check(
            testCase,
            'selected theme survives the settings storage round trip',
            roundTrip.success &&
              roundTrip.settings.theme === theme &&
              fixture.settingsStore.theme === theme,
            `${roundTrip.success}; API=${roundTrip.settings?.theme}; store=${fixture.settingsStore.theme}`,
            theme
          );
          await captureSettingsSurface(testCase, `app-theme-${theme}-settings`, 0.94);
          await capturePreviewSurface(testCase, `app-theme-${theme}-preview`, 0.94);
          await runFailedOperation(
            testCase,
            'new-folder-btn',
            'create_folder',
            EXPECTED_OPERATION_FIXTURES['create-folder'],
            0.94,
            `app-theme-${theme}-create-folder-error`
          );
        }
      );
    }

    await runCase(
      'theme-liquid-glass-mode',
      {
        viewport: { width: 1200, height: 800 },
        theme: 'default',
        liquidGlass: true,
        fixtureIds: [
          PREVIEW_FIXTURE_ID,
          PROPERTIES_FIXTURE_ID,
          EXPECTED_OPERATION_FIXTURES['create-folder'],
        ],
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        await openSettings();
        await changeSetting('theme-select', 'default');
        await changeSetting('liquid-glass-toggle', true);
        await saveSettings();
        const roundTrip = await window.tauriAPI.getSettings();
        await screenshot(testCase, 'app-theme-liquid-glass');
        check(
          testCase,
          'Liquid Glass preference is applied',
          document.body.classList.contains('liquid-glass'),
          document.body.classList.contains('liquid-glass'),
          true
        );
        await captureSettingsSurface(testCase, 'app-theme-liquid-glass-settings', 0.05);
        await capturePreviewSurface(testCase, 'app-theme-liquid-glass-preview', 0.05);
        await runFailedOperation(
          testCase,
          'new-folder-btn',
          'create_folder',
          EXPECTED_OPERATION_FIXTURES['create-folder'],
          0.05,
          'app-theme-liquid-glass-create-folder-error'
        );
        check(
          testCase,
          'Liquid Glass preference persists',
          roundTrip.success &&
            roundTrip.settings.liquidGlassMode === true &&
            fixture.settingsStore.liquidGlassMode === true,
          `${roundTrip.success}; API=${roundTrip.settings?.liquidGlassMode}; store=${fixture.settingsStore.liquidGlassMode}`,
          true
        );
      }
    );

    for (const density of ['compact', 'default', 'larger']) {
      await runCase(
        `density-${density}`,
        { viewport: { width: 1200, height: 800 }, density },
        async (testCase) => {
          await currentViewport(1200, 800);
          await setSettingAndSave('ui-density-select', density);
          const expectedClass =
            density === 'compact' ? 'compact-ui' : density === 'larger' ? 'large-ui' : '';
          const hasExpectedClass = expectedClass
            ? document.body.classList.contains(expectedClass)
            : !document.body.classList.contains('compact-ui') &&
              !document.body.classList.contains('large-ui');
          const roundTrip = await window.tauriAPI.getSettings();
          await screenshot(testCase, `app-density-${density}`);
          check(
            testCase,
            'density is applied across the renderer',
            hasExpectedClass,
            Array.from(document.body.classList)
              .filter((value) => value.endsWith('-ui'))
              .join(' ') || 'default',
            expectedClass || 'default density'
          );
          check(
            testCase,
            'density persists in native settings storage',
            roundTrip.success &&
              roundTrip.settings.uiDensity === density &&
              fixture.settingsStore.uiDensity === density,
            `${roundTrip.success}; API=${roundTrip.settings?.uiDensity}; store=${fixture.settingsStore.uiDensity}`,
            density
          );
        }
      );
    }

    for (const zoom of [1, 1.25, 1.5]) {
      const percent = Math.round(zoom * 100);
      await runCase(
        `zoom-${percent}`,
        { viewport: { width: 1200, height: 800 }, zoom: percent },
        async (testCase) => {
          await currentViewport(1200, 800);
          const result = await window.tauriAPI.setZoomLevel(zoom);
          await doubleFrame();
          check(
            testCase,
            'native zoom fixture accepts the representative level',
            result.success && fixture.zoomLevel === zoom,
            `${result.success}; fixture=${fixture.zoomLevel}`,
            zoom
          );
          check(
            testCase,
            'zoom level is represented in the renderer viewport',
            document.documentElement.style.zoom === String(zoom),
            document.documentElement.style.zoom || 'unset',
            String(zoom)
          );
          await screenshot(testCase, `app-zoom-${percent}`);
          if (zoom > 1) {
            const geometry = inspectPrimaryControlGeometry(viewportNow());
            check(
              testCase,
              'zoomed primary controls remain inside toolbar and viewport bounds',
              geometry.controls > 0 && geometry.boundsFailures.length === 0,
              geometry.boundsFailures.join(', ') || `${geometry.controls} controls within bounds`,
              'all visible controls contained at rendered zoom'
            );
            check(
              testCase,
              'zoomed primary controls do not overlap',
              geometry.controls > 0 && geometry.overlapFailures.length === 0,
              geometry.overlapFailures.join(', ') || 'no overlapping controls',
              'no overlapping control bounds at rendered zoom'
            );
          }
        }
      );
    }

    await runCase(
      'accessibility-settings-and-persistence',
      {
        viewport: { width: 1200, height: 800 },
        theme: 'default',
        density: 'default',
        zoom: 100,
        liquidGlass: true,
        fixtureIds: [
          PREVIEW_FIXTURE_ID,
          PROPERTIES_FIXTURE_ID,
          EXPECTED_OPERATION_FIXTURES['create-folder'],
        ],
        accessibility: Object.fromEntries(ACCESSIBILITY_SETTINGS.map(([, key]) => [key, true])),
      },
      async (testCase) => {
        const resetZoom = await window.tauriAPI.setZoomLevel(1);
        await doubleFrame();
        check(
          testCase,
          'accessibility surface starts at the real 100% fixture zoom',
          resetZoom.success && fixture.zoomLevel === 1,
          `${resetZoom.success}; fixture=${fixture.zoomLevel}`,
          1
        );
        await currentViewport(1200, 800);
        await openSettings();
        await changeSetting('theme-select', 'default');
        await changeSetting('ui-density-select', 'default');
        await changeSetting('liquid-glass-toggle', true);
        for (const [controlId] of ACCESSIBILITY_SETTINGS) await changeSetting(controlId, true);
        await saveSettings();
        await waitFor(
          () =>
            document.body.classList.contains('liquid-glass') &&
            document.body.classList.contains('reduce-transparency') &&
            ACCESSIBILITY_SETTINGS.every(([, , className]) =>
              document.body.classList.contains(className)
            ),
          'Accessibility settings did not apply their renderer classes.'
        );
        const roundTrip = await window.tauriAPI.getSettings();
        for (const [, key, className] of ACCESSIBILITY_SETTINGS) {
          check(
            testCase,
            `${key} applies and persists`,
            document.body.classList.contains(className) &&
              fixture.settingsStore[key] === true &&
              roundTrip.success &&
              roundTrip.settings[key] === true,
            `class=${document.body.classList.contains(className)}; store=${fixture.settingsStore[key]}; API=${roundTrip.settings?.[key]}`,
            true
          );
        }
        check(
          testCase,
          'reduced transparency takes precedence while Liquid Glass remains enabled',
          document.body.classList.contains('liquid-glass') &&
            document.body.classList.contains('reduce-transparency') &&
            fixture.settingsStore.liquidGlassMode === true &&
            fixture.settingsStore.reduceTransparency === true,
          `liquid=${document.body.classList.contains('liquid-glass')}; reduced=${document.body.classList.contains('reduce-transparency')}; settings=${fixture.settingsStore.liquidGlassMode}/${fixture.settingsStore.reduceTransparency}`,
          'Liquid Glass and reduced transparency are both enabled'
        );
        await captureSettingsSurface(testCase, 'app-accessibility-settings', 0.94);
        await capturePreviewSurface(testCase, 'app-accessibility-preview', 0.94);
        await runFailedOperation(
          testCase,
          'new-folder-btn',
          'create_folder',
          EXPECTED_OPERATION_FIXTURES['create-folder'],
          0.94,
          'app-accessibility-create-folder-error'
        );
      }
    );

    const accessibleFlags = Object.fromEntries(
      ACCESSIBILITY_SETTINGS.map(([, key]) => [key, true])
    );
    for (const viewport of VIEWPORTS) {
      await runCase(
        `accessibility-layout-${viewport.width}x${viewport.height}`,
        {
          viewport,
          theme: 'default',
          density: 'default',
          zoom: 100,
          liquidGlass: true,
          accessibility: accessibleFlags,
        },
        async (testCase) => {
          const actualViewport = await currentViewport(viewport.width, viewport.height);
          await screenshot(testCase, `app-accessibility-${viewport.width}x${viewport.height}`);
          check(
            testCase,
            'accessibility profile does not create horizontal page scrolling',
            document.documentElement.scrollWidth <= actualViewport.width + 1,
            document.documentElement.scrollWidth,
            `<= ${actualViewport.width}`
          );
          check(
            testCase,
            'accessibility profile retains a visible focus indicator setting',
            document.body.classList.contains('visible-focus'),
            document.body.classList.contains('visible-focus'),
            true
          );
          const toolbar = document.querySelector('[role="toolbar"]');
          check(
            testCase,
            'primary controls remain available in the accessibility profile',
            Boolean(
              toolbar && isVisible(toolbar) && moreCanReach('search-btn') && moreCanReach('up-btn')
            ),
            `${Boolean(toolbar && isVisible(toolbar))}; search=${moreCanReach('search-btn')}; up=${moreCanReach('up-btn')}`,
            true
          );
          if (viewport.width === 800) {
            const geometry = inspectPrimaryControlGeometry(actualViewport);
            check(
              testCase,
              '800px accessibility controls remain inside toolbar and viewport bounds',
              geometry.controls > 0 && geometry.boundsFailures.length === 0,
              geometry.boundsFailures.join(', ') || `${geometry.controls} controls within bounds`,
              'all visible controls contained'
            );
            check(
              testCase,
              '800px accessibility controls do not overlap',
              geometry.controls > 0 && geometry.overlapFailures.length === 0,
              geometry.overlapFailures.join(', ') || 'no overlapping controls',
              'no overlapping control bounds'
            );
          }
        }
      );
    }

    const focusVisible = async (element) => {
      if (!(element instanceof HTMLElement)) return false;
      element.focus({ preventScroll: true });
      await doubleFrame();
      const style = getComputedStyle(element);
      return (
        document.activeElement === element &&
        style.outlineStyle !== 'none' &&
        Number.parseFloat(style.outlineWidth) >= 1
      );
    };

    await runCase(
      'shell-toolbar-800-command-inventory',
      { viewport: { width: 800, height: 500 } },
      async (testCase) => {
        await currentViewport(800, 500);
        await setAccessibilityProfile(false);
        await setSettingAndSave('liquid-glass-toggle', false);
        await currentViewport(800, 500);
        window.scrollTo(0, 0);
        await doubleFrame();
        await navigateToDirectory(WORKSPACE_PATH);
        window.scrollTo(0, 0);
        await doubleFrame();
        const actualViewport = viewportNow();
        const toolbar = document.querySelector('[role="toolbar"]');
        const panel = menuPanel();
        const more = menuButton();
        check(
          testCase,
          '800x500 viewport is applied before command geometry',
          actualViewport.width === 800 && actualViewport.height === 500,
          `${actualViewport.width}x${actualViewport.height}`,
          '800x500'
        );
        const commandIds = [
          'sidebar-toggle',
          'back-btn',
          'forward-btn',
          'up-btn',
          'search-btn',
          'new-folder-btn',
          'refresh-btn',
          'new-file-btn',
          'sort-btn',
        ];
        const inToolbar = (id) => {
          const element = document.getElementById(id);
          return Boolean(element && isVisible(element) && !panel?.contains(element));
        };
        check(
          testCase,
          '800x500 keeps sidebar, navigation, search, and More visible',
          ['sidebar-toggle', 'back-btn', 'forward-btn', 'search-btn', 'more-actions-btn'].every(
            (id) => inToolbar(id)
          ),
          ['sidebar-toggle', 'back-btn', 'forward-btn', 'search-btn', 'more-actions-btn']
            .filter((id) => !inToolbar(id))
            .join(', ') || 'all visible',
          'all visible in the toolbar'
        );
        const address = document.querySelector('.address-bar-wrapper');
        check(
          testCase,
          '800x500 keeps the address field visible with usable width',
          Boolean(address && isVisible(address) && address.getBoundingClientRect().width >= 100),
          `${Math.round(address?.getBoundingClientRect().width || 0)}; toolbar=${Math.round(toolbar?.getBoundingClientRect().top || 0)}-${Math.round(toolbar?.getBoundingClientRect().bottom || 0)}; scroll=${toolbar?.scrollWidth}/${toolbar?.clientWidth}`,
          'visible, at least 100 CSS px'
        );
        await doubleFrame();
        const toolbarOverflows = Boolean(toolbar && toolbar.scrollWidth > toolbar.clientWidth + 1);
        const fitCommands = ['up-btn', 'new-folder-btn', 'view-options'];
        check(
          testCase,
          toolbarOverflows
            ? 'overflowing 800x500 toolbar moves Up, New Folder, and view options into More'
            : 'fitting 800x500 toolbar keeps Up, New Folder, and view options visible',
          toolbarOverflows
            ? fitCommands.every((id) => panel?.contains(document.getElementById(id)))
            : fitCommands.every((id) => inToolbar(id)),
          `overflow=${toolbarOverflows}; scroll=${toolbar?.scrollWidth}/${toolbar?.clientWidth}; ` +
            fitCommands
              .map(
                (id) =>
                  `${id}:inMenu=${Boolean(panel?.contains(document.getElementById(id)))};visible=${isVisible(document.getElementById(id))}`
              )
              .join(', '),
          toolbarOverflows
            ? 'all inside #more-actions-menu'
            : 'all visible in the toolbar without overflow'
        );
        window.scrollTo(0, 0);
        await doubleFrame();
        more?.click();
        await doubleFrame();
        const openCommands = [...commandIds, 'view-options'];
        check(
          testCase,
          'every toolbar command is visible or reachable from the open More menu',
          openCommands.every((id) => {
            const element = document.getElementById(id);
            return Boolean(element && isVisible(element));
          }),
          openCommands.filter((id) => !isVisible(document.getElementById(id))).join(', ') ||
            'all reachable',
          'all commands visible with More open'
        );
        const menuRect = panel?.getBoundingClientRect();
        check(
          testCase,
          'the open More menu stays inside the viewport',
          Boolean(
            menuRect &&
            menuRect.left >= -1 &&
            menuRect.top >= -1 &&
            menuRect.right <= actualViewport.width + 1 &&
            menuRect.bottom <= actualViewport.height + 1
          ),
          menuRect
            ? `${Math.round(menuRect.left)},${Math.round(menuRect.top)} to ${Math.round(menuRect.right)},${Math.round(menuRect.bottom)}; display=${panel?.style.display}; position=${getComputedStyle(panel).position}; top=${panel?.style.top}; left=${panel?.style.left}; inner=${viewportNow().width}x${viewportNow().height}; scrollY=${window.scrollY}; more=${Math.round(more?.getBoundingClientRect().top || 0)}-${Math.round(more?.getBoundingClientRect().bottom || 0)}; toolbar=${Math.round(toolbar?.getBoundingClientRect().top || 0)}-${Math.round(toolbar?.getBoundingClientRect().bottom || 0)}; zoom=${document.documentElement.style.zoom || 'unset'}; body=${Array.from(document.body.classList).join(' ')}`
            : 'missing',
          `inside 0,0 to ${actualViewport.width},${actualViewport.height}`
        );
        const labelled = [
          'sidebar-toggle',
          'back-btn',
          'forward-btn',
          'search-btn',
          'more-actions-btn',
        ]
          .map((id) => document.getElementById(id))
          .filter(isVisible)
          .every(
            (element) =>
              Boolean(element.getAttribute('title')) || Boolean(element.getAttribute('aria-label'))
          );
        check(
          testCase,
          'visible toolbar controls keep tooltip or accessible labels',
          labelled,
          labelled,
          true
        );
        const toolbarOffsets = Array.from(toolbar?.children || [])
          .flatMap((group) => Array.from(group.querySelectorAll(':scope > button, :scope > div')))
          .filter(isVisible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { element, rect };
          });
        const clipped = toolbarOffsets.filter(({ rect }) => {
          const toolbarRect = toolbar?.getBoundingClientRect();
          return Boolean(
            toolbarRect &&
            (rect.left < toolbarRect.left - 1 ||
              rect.right > Math.min(toolbarRect.right, actualViewport.width) + 1)
          );
        });
        check(
          testCase,
          'no visible toolbar command is clipped by overflow',
          clipped.length === 0,
          clipped
            .map(({ element }) => element.id || element.className || element.tagName)
            .join(', ') || 'no clipped controls',
          'all visible controls inside the toolbar'
        );
        dispatchKey('Escape');
        await doubleFrame();
      }
    );

    await runCase(
      'shell-liquid-glass-menu-bounds',
      { viewport: { width: 800, height: 500 }, liquidGlass: true },
      async (testCase) => {
        await currentViewport(800, 500);
        await setSettingAndSave('liquid-glass-toggle', true);
        await currentViewport(800, 500);
        window.scrollTo(0, 0);
        await doubleFrame();
        check(
          testCase,
          'Liquid Glass mode is active for the menu geometry check',
          document.body.classList.contains('liquid-glass'),
          Array.from(document.body.classList).join(' '),
          'body.liquid-glass'
        );
        menuButton()?.click();
        await doubleFrame();
        const panel = menuPanel();
        const menuRect = panel?.getBoundingClientRect();
        const viewport = viewportNow();
        check(
          testCase,
          'Liquid Glass More menu stays inside the viewport',
          Boolean(
            panel?.style.display === 'block' &&
            menuRect &&
            menuRect.left >= -1 &&
            menuRect.top >= -1 &&
            menuRect.right <= viewport.width + 1 &&
            menuRect.bottom <= viewport.height + 1
          ),
          `${panel?.style.display}; position=${panel ? getComputedStyle(panel).position : 'missing'}; rect=${menuRect ? `${Math.round(menuRect.left)},${Math.round(menuRect.top)} to ${Math.round(menuRect.right)},${Math.round(menuRect.bottom)}` : 'missing'}; viewport=${viewport.width}x${viewport.height}; top=${panel?.style.top}`,
          'open menu fully inside the viewport'
        );
        dispatchKey('Escape');
        await doubleFrame();
      }
    );

    await runCase(
      'file-status-selection-and-commands',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        await currentViewport(1200, 800);
        await navigateToDirectory(WORKSPACE_PATH);
        const itemPath = `${WORKSPACE_PATH}/Readme.md`;
        const row = await findStableRow(
          itemPath,
          'The status-bar selection fixture row is not connected.'
        );
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitForStable(
          () =>
            row.isConnected &&
            row.classList.contains('selected') &&
            isVisible(document.getElementById('status-selected')),
          'The status-bar selection did not settle.'
        );
        const statusText = textOf(document.getElementById('status-selected'));
        const expectedCount = fixture.directoryData.get(WORKSPACE_PATH).length;
        check(
          testCase,
          'status bar shows the selection count and size',
          /^1 selected \(.+\)$/.test(statusText),
          statusText,
          '1 selected (<size>)'
        );
        check(
          testCase,
          'status bar keeps the active directory item count',
          textOf(document.getElementById('status-items')) === `${expectedCount} items`,
          textOf(document.getElementById('status-items')),
          `${expectedCount} items`
        );
        check(
          testCase,
          'single-pane selection does not show an active-pane badge',
          getComputedStyle(document.getElementById('status-pane')).display === 'none',
          getComputedStyle(document.getElementById('status-pane')).display,
          'none'
        );
        menuButton()?.click();
        await doubleFrame();
        const selectionGroup = document.getElementById('more-selection-actions');
        const selectionCommands = [
          'selection-copy-btn',
          'selection-cut-btn',
          'selection-move-btn',
          'selection-rename-btn',
          'selection-delete-btn',
        ];
        check(
          testCase,
          'selection commands live in the existing More menu',
          Boolean(selectionGroup && isVisible(selectionGroup)) &&
            selectionCommands.every((id) =>
              Boolean(selectionGroup.contains(document.getElementById(id)))
            ),
          selectionGroup ? `${selectionCommands.length} commands in More` : 'missing group',
          'all selection commands inside More'
        );
        check(
          testCase,
          'single-item selection enables its commands',
          selectionCommands.every(
            (id) => document.getElementById(id)?.hasAttribute('disabled') === false
          ),
          selectionCommands
            .filter((id) => document.getElementById(id)?.hasAttribute('disabled') !== false)
            .join(', ') || 'all enabled',
          'copy, cut, move, rename, delete enabled'
        );
        check(
          testCase,
          'selection count is shown in the More selection group',
          textOf(document.getElementById('selection-count')) === '1',
          textOf(document.getElementById('selection-count')),
          '1'
        );
        const deleteColor = getComputedStyle(document.getElementById('selection-delete-btn')).color;
        const copyColor = getComputedStyle(document.getElementById('selection-copy-btn')).color;
        check(
          testCase,
          'destructive selection command is visually distinct',
          deleteColor !== copyColor,
          `${deleteColor} vs ${copyColor}; classes=${document.getElementById('selection-delete-btn').className}; closest=${document.getElementById('selection-delete-btn').closest('.more-actions-menu')?.id}; dangerVar=${getComputedStyle(document.getElementById('selection-delete-btn')).getPropertyValue('--danger-color')}; rootDanger=${getComputedStyle(document.documentElement).getPropertyValue('--danger-color')}`,
          'delete color differs from copy color'
        );
        document.getElementById('deselect-all-btn')?.click();
        await doubleFrame();
        check(
          testCase,
          'clearing selection hides the status selection summary',
          !isVisible(document.getElementById('status-selected')),
          getComputedStyle(document.getElementById('status-selected')).display,
          'none'
        );
        if (menuPanel()?.style.display === 'block') menuButton()?.click();
        await doubleFrame();
      }
    );

    await runCase(
      'file-empty-long-and-large-directory',
      {
        viewport: { width: 1200, height: 800 },
        accessibility: Object.fromEntries(ACCESSIBILITY_SETTINGS.map(([, key]) => [key, true])),
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        await setAccessibilityProfile(true);
        await currentViewport(1200, 800);
        await navigateToDirectory(EMPTY_PATH);
        const emptyState = document.getElementById('empty-state');
        await waitFor(
          () =>
            isVisible(emptyState) &&
            textOf(emptyState).includes('This folder is empty') &&
            document.querySelectorAll('#file-grid .file-item').length === 0,
          'The empty fixture folder did not show its explicit empty state.'
        );
        check(
          testCase,
          'empty folder shows an explicit empty state with no stale rows',
          isVisible(emptyState) && document.querySelectorAll('#file-grid .file-item').length === 0,
          `${textOf(emptyState)}; rows=${document.querySelectorAll('#file-grid .file-item').length}`,
          'visible empty state; 0 rows'
        );
        await navigateToDirectory(WORKSPACE_PATH);
        const longRow = await findStableRow(
          LONG_FILE_PATH,
          'The long-filename fixture row is not connected.'
        );
        const longName = longRow.querySelector('.file-name');
        const fileView = document.getElementById('file-view');
        const longRowRect = longRow.getBoundingClientRect();
        const fileViewRect = fileView.getBoundingClientRect();
        check(
          testCase,
          'long filenames stay inside the file view without horizontal clipping',
          Boolean(
            longName &&
            longRowRect.left >= fileViewRect.left - 1 &&
            longRowRect.right <= fileViewRect.right + 1 &&
            document.documentElement.scrollWidth <= viewportNow().width + 1
          ),
          `${Math.round(longRowRect.left)}-${Math.round(longRowRect.right)} in ${Math.round(fileViewRect.left)}-${Math.round(fileViewRect.right)}; scrollWidth=${document.documentElement.scrollWidth}`,
          'row contained; no page scroll'
        );
        check(
          testCase,
          'long filename text remains complete in the DOM',
          textOf(longName) === LONG_FILENAME,
          textOf(longName),
          LONG_FILENAME
        );
        const listOption = document.querySelector('#view-options [data-view="list"]');
        if (listOption instanceof HTMLElement && isVisible(listOption)) {
          listOption.click();
        } else {
          menuButton()?.click();
          await doubleFrame();
          document.querySelector('#view-options [data-view="list"]')?.click();
        }
        await waitForStable(() => {
          const loading = document.getElementById('loading');
          return (
            document.getElementById('file-grid')?.classList.contains('list-view') &&
            (!loading || getComputedStyle(loading).display === 'none')
          );
        }, 'The list view did not settle for row-height measurement.');
        const listRow = document.querySelector('#file-grid .file-item');
        check(
          testCase,
          'list rows keep the 28px minimum height with accessibility text',
          Boolean(listRow && listRow.getBoundingClientRect().height >= 28),
          listRow ? listRow.getBoundingClientRect().height : 'missing',
          'at least 28px'
        );
        if (menuPanel()?.style.display === 'block') {
          menuButton()?.click();
          await doubleFrame();
        }
        const gridOption = document.querySelector('#view-options [data-view="grid"]');
        if (gridOption instanceof HTMLElement && isVisible(gridOption)) {
          gridOption.click();
        } else {
          menuButton()?.click();
          await doubleFrame();
          document.querySelector('#view-options [data-view="grid"]')?.click();
        }
        await waitForStable(
          () => !document.getElementById('file-grid')?.classList.contains('list-view'),
          'The grid view did not settle before the large-directory check.'
        );
        await navigateToDirectory(LARGE_PATH);
        const lastPath = `${LARGE_PATH}/Item-1299.txt`;
        const largeView = document.getElementById('file-view');
        largeView.scrollTop = largeView.scrollHeight;
        largeView.dispatchEvent(new Event('scroll', { bubbles: true }));
        await doubleFrame();
        await waitFor(
          () =>
            Boolean(
              Array.from(document.querySelectorAll('#file-grid .file-item')).find(
                (item) => item.isConnected && item.getAttribute('data-path') === lastPath
              )
            ),
          'Scrolling the large fixture directory did not reach its last row.'
        );
        const mountedRows = document.querySelectorAll('#file-grid .file-item').length;
        const lastRow = Array.from(document.querySelectorAll('#file-grid .file-item')).find(
          (item) => item.getAttribute('data-path') === lastPath
        );
        const lastRect = lastRow.getBoundingClientRect();
        const largeViewRect = largeView.getBoundingClientRect();
        check(
          testCase,
          'large directories keep virtualization while reaching the last row',
          mountedRows > 0 &&
            mountedRows < 900 &&
            lastRect.bottom > largeViewRect.top &&
            lastRect.top < largeViewRect.bottom,
          `${mountedRows} mounted rows; last row ${Math.round(lastRect.top)}-${Math.round(lastRect.bottom)} in ${Math.round(largeViewRect.top)}-${Math.round(largeViewRect.bottom)}`,
          'virtualized rows; last row visible in the viewport'
        );
        if (menuPanel()?.style.display === 'block') {
          menuButton()?.click();
          await doubleFrame();
        }
      }
    );

    await runCase(
      'home-sidebar-rows-and-disclosure',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        await currentViewport(1200, 800);
        const sidebar = document.getElementById('sidebar');
        const headings = Array.from(sidebar.querySelectorAll('.section-title')).filter(isVisible);
        const quickRows = Array.from(
          document.querySelectorAll('#sidebar-quick-access-grid .quick-action')
        );
        check(
          testCase,
          'sidebar exposes compact aligned Quick Access rows',
          quickRows.length >= 6 &&
            quickRows.every((row) => getComputedStyle(row).flexDirection === 'row') &&
            new Set(quickRows.map((row) => Math.round(row.getBoundingClientRect().left))).size ===
              1 &&
            new Set(quickRows.map((row) => Math.round(row.getBoundingClientRect().height))).size <=
              2,
          `${quickRows.length} rows; ${new Set(quickRows.map((row) => Math.round(row.getBoundingClientRect().height))).size} heights`,
          'at least six rows, left-aligned, consistent height'
        );
        check(
          testCase,
          'sidebar section headings stay quiet and secondary',
          headings.length >= 4 &&
            headings.every((heading) => {
              const style = getComputedStyle(heading);
              return (
                Number.parseFloat(style.fontSize) <= 11 &&
                Number.parseInt(style.fontWeight, 10) <= 600 &&
                style.textTransform === 'uppercase'
              );
            }),
          headings
            .map(
              (heading) =>
                `${textOf(heading)}:${getComputedStyle(heading).fontSize}/${getComputedStyle(heading).fontWeight}`
            )
            .join(', '),
          'at least four compact uppercase headings at weight <= 600'
        );
        const recentSection = document.getElementById('recent-section');
        const recentToggle = recentSection?.querySelector('.section-toggle');
        const initiallyCollapsed = recentSection?.classList.contains('collapsed');
        recentToggle?.click();
        await doubleFrame();
        const expanded = !recentSection?.classList.contains('collapsed');
        check(
          testCase,
          'sidebar disclosure control expands and collapses a section',
          Boolean(
            initiallyCollapsed &&
            expanded &&
            recentToggle?.getAttribute('aria-expanded') === 'true' &&
            getComputedStyle(recentSection.querySelector('.section-body')).display !== 'none'
          ),
          `collapsed=${initiallyCollapsed}; expanded=${expanded}; aria=${recentToggle?.getAttribute('aria-expanded')}`,
          'collapsed -> expanded with aria-expanded=true'
        );
        recentToggle?.click();
        await doubleFrame();
        const handle = document.getElementById('sidebar-resize-handle');
        const widthBefore = sidebar.getBoundingClientRect().width;
        const startX = handle.getBoundingClientRect().left + 1;
        handle.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startX })
        );
        const resizeStarted = document.body.style.cursor === 'col-resize';
        document.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, clientX: startX + 24, buttons: 1 })
        );
        await doubleFrame();
        const cssAfterMove =
          document.documentElement.style.getPropertyValue('--sidebar-width-current');
        const widthAfterMove = sidebar.getBoundingClientRect().width;
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await doubleFrame();
        const widthAfterDrag = sidebar.getBoundingClientRect().width;
        if (!(widthAfterDrag >= widthBefore + 16)) {
          throw new Error(
            `Dragging the sidebar resize handle did not widen the sidebar (before=${Math.round(widthBefore)}, afterMove=${Math.round(widthAfterMove)}, after=${Math.round(widthAfterDrag)}, cssMove=${cssAfterMove}, css=${document.documentElement.style.getPropertyValue('--sidebar-width-current')}, handle=${Math.round(handle.getBoundingClientRect().left)}, started=${resizeStarted}, bound=${handle.dataset.resizeBound}, collapsed=${sidebar.classList.contains('collapsed')}).`
          );
        }
        await waitFor(
          () => fixture.settingsStore.sidebarWidth >= widthBefore + 16,
          'The resized sidebar width did not persist through settings storage.',
          4000
        );
        check(
          testCase,
          'sidebar resize is preserved in native settings storage',
          fixture.settingsStore.sidebarWidth >= widthBefore + 16,
          `${Math.round(widthBefore)} -> ${fixture.settingsStore.sidebarWidth}`,
          'increased width persisted'
        );
        const restoreStart = handle.getBoundingClientRect().left + 1;
        handle.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: restoreStart })
        );
        document.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, clientX: restoreStart - 24 })
        );
        await doubleFrame();
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await doubleFrame();
        await waitFor(
          () => Math.abs(sidebar.getBoundingClientRect().width - widthBefore) <= 2,
          'The sidebar width did not restore after the resize check.'
        );
        await waitFor(
          () => Math.abs(fixture.settingsStore.sidebarWidth - widthBefore) <= 2,
          'The restored sidebar width did not persist.',
          4000
        );
      }
    );

    await runCase(
      'home-sections-customization-and-storage',
      {
        viewport: { width: 1200, height: 800 },
        fixtureIds: [HOME_SETTINGS_SAVE_RACE_FIXTURE_ID],
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        const home = document.querySelector('#sidebar-quick-access-grid [data-action="home"]');
        if (!home) throw new Error('Home sidebar destination is missing.');
        home.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(
          () => isVisible(document.getElementById('home-view')),
          'Home view did not open for the section check.'
        );
        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not open for the section check.'
        );
        for (const id of [
          'home-toggle-quick-access',
          'home-toggle-recents',
          'home-toggle-bookmarks',
          'home-toggle-drives',
        ]) {
          const toggle = document.getElementById(id);
          if (toggle instanceof HTMLInputElement && !toggle.checked) {
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'none',
          'Home preferences did not close after enabling every section.'
        );
        await waitFor(
          () =>
            [
              'home-section-quick-access',
              'home-section-recents',
              'home-section-bookmarks',
              'home-section-drives',
            ].every((id) => isVisible(document.getElementById(id))),
          'Home did not render all four enabled sections.'
        );
        const sections = Array.from(document.querySelectorAll('#home-view .home-section')).map(
          (section) => section.id
        );
        const labels = Array.from(document.querySelectorAll('#home-view .home-section-title')).map(
          textOf
        );
        check(
          testCase,
          'Home renders Quick Access, Recents, Bookmarks, and Locations in order',
          JSON.stringify(sections) ===
            JSON.stringify([
              'home-section-quick-access',
              'home-section-recents',
              'home-section-bookmarks',
              'home-section-drives',
            ]) && labels.includes('Locations'),
          `${sections.join(', ')}; labels=${labels.join(', ')}`,
          'quick access, recents, bookmarks, locations'
        );
        await waitFor(
          () => textOf(document.querySelector('#home-drives .home-drive-meta')).includes('free of'),
          'Home did not render inline storage usage.'
        );
        check(
          testCase,
          'Home renders storage usage inline with Locations',
          textOf(document.querySelector('#home-drives .home-drive-meta')).includes('free of') &&
            Boolean(document.querySelector('#home-drives .home-drive-bar')),
          textOf(document.querySelector('#home-drives .home-drive-meta')),
          'free/total text with inline usage bar'
        );
        check(
          testCase,
          'Home keeps bookmark and recent fixture entries',
          textOf(document.getElementById('home-bookmarks')).includes('Documents') &&
            textOf(document.getElementById('home-recents')).includes('Planning.md'),
          `${textOf(document.getElementById('home-bookmarks'))}; ${textOf(document.getElementById('home-recents'))}`,
          'Documents bookmark and Planning.md recent'
        );
        const recentPin = document.querySelector('#home-recents .home-recent-pin');
        recentPin?.click();
        await waitForStable(
          () =>
            fixture.homeSettingsStore.pinnedRecents.includes(`${DOCUMENTS_PATH}/Planning.md`) &&
            Boolean(document.querySelector('#home-recents .home-recent-pin.active')),
          'Pinning a recent item did not persist and mark the item active.'
        );
        check(
          testCase,
          'Home pinned items persist through native Home settings',
          fixture.homeSettingsStore.pinnedRecents.includes(`${DOCUMENTS_PATH}/Planning.md`) &&
            Boolean(document.querySelector('#home-recents .home-recent-pin.active')),
          `${JSON.stringify(fixture.homeSettingsStore.pinnedRecents)}; active=${Boolean(document.querySelector('#home-recents .home-recent-pin.active'))}`,
          'pinned recent persisted and marked active'
        );
        document.querySelector('#home-recents .home-recent-pin.active')?.click();
        await waitForStable(
          () =>
            !fixture.homeSettingsStore.pinnedRecents.includes(`${DOCUMENTS_PATH}/Planning.md`) &&
            !document.querySelector('#home-recents .home-recent-pin.active'),
          'Unpinning the recent item did not persist.'
        );
        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not reopen for the visibility check.'
        );
        const bookmarksToggle = document.getElementById('home-toggle-bookmarks');
        if (!(bookmarksToggle instanceof HTMLInputElement)) {
          throw new Error('Home bookmarks toggle is missing.');
        }
        bookmarksToggle.checked = false;
        bookmarksToggle.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'none',
          'Home preferences did not close after hiding Bookmarks.'
        );
        await waitForStable(
          () =>
            getComputedStyle(document.getElementById('home-section-bookmarks')).display === 'none',
          'Home did not hide the Bookmarks section.'
        );
        check(
          testCase,
          'Home section customization hides a saved section',
          getComputedStyle(document.getElementById('home-section-bookmarks')).display === 'none' &&
            fixture.homeSettingsStore.showBookmarks === false,
          `${getComputedStyle(document.getElementById('home-section-bookmarks')).display}; store=${fixture.homeSettingsStore.showBookmarks}`,
          'none; store=false'
        );
        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not reopen to restore Bookmarks.'
        );
        const restoreBookmarks = document.getElementById('home-toggle-bookmarks');
        restoreBookmarks.checked = true;
        restoreBookmarks.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'none',
          'Home preferences did not close after restoring Bookmarks.'
        );
        check(
          testCase,
          'Utility Dashboard stays hidden until it is opted in',
          fixture.settingsStore.showUtilityDashboard !== true &&
            getComputedStyle(document.getElementById('utility-drawer')).display === 'none',
          `setting=${fixture.settingsStore.showUtilityDashboard}; display=${getComputedStyle(document.getElementById('utility-drawer')).display}`,
          'setting off; drawer hidden'
        );
      }
    );

    await runCase(
      'home-drive-cards-layout',
      { viewport: { width: 1200, height: 800 } },
      async (testCase) => {
        const home = document.querySelector('#sidebar-quick-access-grid [data-action="home"]');
        if (!home) throw new Error('Home sidebar destination is missing for drive layout.');
        if (!isVisible(document.getElementById('home-view'))) {
          home.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await waitFor(
          () => isVisible(document.getElementById('home-section-drives')),
          'Home Locations did not open for the drive layout check.'
        );

        const expectedDrives = [
          { path: '/fixture', name: 'Smoke Volume', usage: 'free of' },
          {
            path: '/fixture/empty-label',
            name: '/fixture/empty-label',
            usage: 'free of',
          },
          {
            path: '/fixture/long-label',
            name: 'A deliberately long removable volume label for Home layout coverage',
            usage: 'free of',
          },
          {
            path: '/fixture/no-usage',
            name: 'Unavailable Usage Volume',
            usage: 'Usage unavailable',
          },
        ];

        const checkHomeDriveCardsAt = async (viewport, variant = 'default') => {
          await currentViewport(viewport.width, viewport.height);
          await waitForStable(
            () =>
              document.querySelectorAll('#home-drives .home-drive-card').length ===
                expectedDrives.length &&
              Array.from(document.querySelectorAll('#home-drives .home-drive-meta')).every(
                (meta) => !textOf(meta).includes('Loading')
              ),
            `Home drive cards did not finish rendering at ${viewport.width}x${viewport.height}.`
          );

          const drivesGrid = document.getElementById('home-drives');
          const gridRect = drivesGrid.getBoundingClientRect();
          const cards = Array.from(drivesGrid.querySelectorAll('.home-drive-card'));
          check(
            testCase,
            `Home renders all fixture drives at ${viewport.width}x${viewport.height}`,
            cards.length === expectedDrives.length,
            cards.length,
            expectedDrives.length
          );

          for (const expected of expectedDrives) {
            const card = cards.find((candidate) => candidate.dataset.drivePath === expected.path);
            const header = card?.querySelector('.home-drive-header');
            const icon = header?.querySelector('.home-item-icon');
            const name = header?.querySelector(':scope > span:last-child');
            const meta = card?.querySelector('.home-drive-meta');
            const bar = card?.querySelector('.home-drive-bar');
            const barFill = bar?.querySelector('span');
            if (!card || !header || !icon || !name || !meta || !bar || !barFill) {
              throw new Error(`Home drive card is incomplete for ${expected.path}.`);
            }

            const cardRect = card.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const iconRect = icon.getBoundingClientRect();
            const nameRect = name.getBoundingClientRect();
            const metaRect = meta.getBoundingClientRect();
            const barRect = bar.getBoundingClientRect();
            const within = (inner, outer) =>
              inner.left >= outer.left - 1 &&
              inner.top >= outer.top - 1 &&
              inner.right <= outer.right + 1 &&
              inner.bottom <= outer.bottom + 1;
            const separated = (first, second) =>
              first.right <= second.left + 1 ||
              second.right <= first.left + 1 ||
              first.bottom <= second.top + 1 ||
              second.bottom <= first.top + 1;
            const iconVisible =
              iconRect.width >= 14 &&
              iconRect.height >= 14 &&
              getComputedStyle(icon).visibility !== 'hidden';
            const nameReadable =
              textOf(name) === expected.name &&
              nameRect.width >= 32 &&
              nameRect.height >= 12 &&
              within(headerRect, cardRect) &&
              within(iconRect, headerRect) &&
              within(nameRect, headerRect) &&
              separated(iconRect, nameRect);
            const usageContained =
              textOf(meta).includes(expected.usage) &&
              within(metaRect, cardRect) &&
              meta.scrollWidth <= meta.clientWidth + 1 &&
              meta.scrollHeight <= meta.clientHeight + 1;
            const barContained =
              within(barRect, cardRect) &&
              barRect.width >= 32 &&
              (expected.path === '/fixture/no-usage'
                ? barFill.style.width === '0%'
                : Number.parseFloat(barFill.style.width) > 0);
            const contentDoesNotOverlap = [
              [iconRect, nameRect],
              [iconRect, metaRect],
              [iconRect, barRect],
              [nameRect, metaRect],
              [nameRect, barRect],
              [metaRect, barRect],
            ].every(([first, second]) => separated(first, second));
            const layoutLabel =
              variant === 'default'
                ? `${viewport.width}x${viewport.height}`
                : `${variant} at ${viewport.width}x${viewport.height}`;

            check(
              testCase,
              `Home drive icon and name have readable bounds for ${expected.path} in ${layoutLabel}`,
              iconVisible && nameReadable && within(iconRect, cardRect),
              `icon=${Math.round(iconRect.width)}x${Math.round(iconRect.height)}; name=${Math.round(nameRect.width)}x${Math.round(nameRect.height)}; label=${textOf(name)}`,
              'visible icon and non-overlapping readable name inside the card'
            );
            check(
              testCase,
              `Home drive usage stays contained for ${expected.path} in ${layoutLabel}`,
              usageContained,
              `${textOf(meta)}; scroll=${meta.scrollWidth}/${meta.clientWidth}; card=${Math.round(cardRect.left)}..${Math.round(cardRect.right)}`,
              `${expected.usage} text inside the card without clipping`
            );
            check(
              testCase,
              `Home drive usage bar stays contained for ${expected.path} in ${layoutLabel}`,
              barContained,
              `bar=${Math.round(barRect.left)}..${Math.round(barRect.right)}; card=${Math.round(cardRect.left)}..${Math.round(cardRect.right)}; fill=${barFill.style.width}`,
              'bar inside the card, separated from usage text, with matching fill state'
            );
            check(
              testCase,
              `Home drive card stays inside Locations for ${expected.path} in ${layoutLabel}`,
              within(cardRect, gridRect),
              `${Math.round(cardRect.left)},${Math.round(cardRect.top)}..${Math.round(cardRect.right)},${Math.round(cardRect.bottom)}`,
              'card fully inside the Locations grid'
            );
            check(
              testCase,
              `Home drive icon, name, usage, and bar do not overlap for ${expected.path} in ${layoutLabel}`,
              contentDoesNotOverlap,
              `icon=${Math.round(iconRect.left)},${Math.round(iconRect.top)}..${Math.round(iconRect.right)},${Math.round(iconRect.bottom)}; name=${Math.round(nameRect.left)},${Math.round(nameRect.top)}..${Math.round(nameRect.right)},${Math.round(nameRect.bottom)}; usage=${Math.round(metaRect.left)},${Math.round(metaRect.top)}..${Math.round(metaRect.right)},${Math.round(metaRect.bottom)}; bar=${Math.round(barRect.left)},${Math.round(barRect.top)}..${Math.round(barRect.right)},${Math.round(barRect.bottom)}`,
              'each card element separated horizontally or vertically'
            );
          }

          await screenshot(
            testCase,
            `home-drive-cards-${variant}-${viewport.width}x${viewport.height}`
          );
        };

        for (const viewport of VIEWPORTS) {
          await checkHomeDriveCardsAt(viewport);
        }

        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not open for compact drive cards.'
        );
        const compactCards = document.getElementById('home-toggle-compact');
        if (!(compactCards instanceof HTMLInputElement)) {
          throw new Error('Home compact cards toggle is missing.');
        }
        compactCards.checked = true;
        compactCards.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'none',
          'Home preferences did not close after enabling compact drive cards.'
        );
        check(
          testCase,
          'compact drive card preference is active',
          fixture.homeSettingsStore.compactCards === true &&
            document.getElementById('home-view')?.classList.contains('home-compact'),
          `stored=${fixture.homeSettingsStore.compactCards}; class=${document.getElementById('home-view')?.classList.contains('home-compact')}`,
          'compact cards saved and applied'
        );
        await checkHomeDriveCardsAt({ width: 800, height: 500 }, 'compact');

        await setSettingAndSave('large-text-toggle', true);
        await checkHomeDriveCardsAt({ width: 1200, height: 800 }, 'large-text');
        await setSettingAndSave('large-text-toggle', false);

        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not reopen to restore regular drive cards.'
        );
        compactCards.checked = false;
        compactCards.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('home-settings-save')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'none',
          'Home preferences did not close after restoring regular drive cards.'
        );
      }
    );

    let originalLiquidGlass = false;
    let originalReduceTransparency = false;
    let originalPerformanceMode = false;
    await runCase(
      'context-menu-submenus-at-edges',
      { viewport: { width: 800, height: 500 } },
      async (testCase) => {
        originalLiquidGlass = Boolean(fixture.settingsStore.liquidGlassMode);
        originalReduceTransparency = Boolean(fixture.settingsStore.reduceTransparency);
        originalPerformanceMode = document.body.classList.contains('performance-mode');
        await currentViewport(800, 500);
        await navigateToDirectory(WORKSPACE_PATH);
        const itemPath = `${WORKSPACE_PATH}/Readme.md`;
        let row = await findStableRow(itemPath, 'The context menu fixture row is not connected.');
        const menu = document.getElementById('context-menu');
        const parent = document.getElementById('open-with-submenu');
        const panel = document.getElementById('open-with-apps-panel');
        if (!menu || !parent || !panel) {
          throw new Error('The file context menu or Open With submenu is missing.');
        }

        const openAt = async (x, y) => {
          row = await findStableRow(
            itemPath,
            'The context menu fixture row is not connected before opening a menu.'
          );
          row.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: x,
              clientY: y,
            })
          );
          await waitForStable(
            () => menu.style.display === 'block',
            'The file context menu did not open.'
          );
        };
        const withinViewport = (rect) =>
          rect.left >= -1 &&
          rect.top >= -1 &&
          rect.right <= window.innerWidth + 1 &&
          rect.bottom <= window.innerHeight + 1;

        const menuModes = [
          { label: 'Liquid Glass off', slug: 'standard', enabled: false },
          { label: 'Liquid Glass on', slug: 'liquid-glass', enabled: true },
        ];
        testCase.liquidGlassModes = menuModes.map((mode) => mode.label);

        const submenuAdjacency = (submenuRect, parentRect) => {
          const verticalGap =
            submenuRect.top > parentRect.bottom
              ? submenuRect.top - parentRect.bottom
              : parentRect.top > submenuRect.bottom
                ? parentRect.top - submenuRect.bottom
                : 0;
          const horizontalOverlap =
            submenuRect.left <= parentRect.right && submenuRect.right >= parentRect.left;
          const viewportClampOverlap =
            horizontalOverlap &&
            (submenuRect.left <= 1 || submenuRect.right >= window.innerWidth - 1);
          const sideGap = Math.min(
            Math.abs(submenuRect.left - parentRect.right),
            Math.abs(submenuRect.right - parentRect.left)
          );
          return {
            adjacent: verticalGap <= 6 && (sideGap <= 6 || viewportClampOverlap),
            verticalGap,
            sideGap,
            viewportClampOverlap,
          };
        };

        const movePointerInSteps = async (fromX, fromY, toX, toY) => {
          const steps = Math.max(3, Math.ceil(Math.hypot(toX - fromX, toY - fromY) / 16));
          for (let index = 1; index <= steps; index += 1) {
            const progress = index / steps;
            await requestPointer(
              fromX + (toX - fromX) * progress,
              fromY + (toY - fromY) * progress
            );
          }
          return steps;
        };

        for (const mode of menuModes) {
          await setSettingAndSave('reduce-transparency-toggle', false);
          await setSettingAndSave('liquid-glass-toggle', mode.enabled);
          document.body.classList.remove('performance-mode');
          testCase.liquidGlass = mode.enabled;
          document.getElementById('toast-container')?.replaceChildren();
          await doubleFrame();
          check(
            testCase,
            `${mode.label}: glass mode is applied without transparency or performance overrides`,
            document.body.classList.contains('liquid-glass') === mode.enabled &&
              !document.body.classList.contains('reduce-transparency') &&
              !document.body.classList.contains('performance-mode'),
            `glass=${document.body.classList.contains('liquid-glass')}; reduced=${document.body.classList.contains('reduce-transparency')}; performance=${document.body.classList.contains('performance-mode')}`,
            `glass=${mode.enabled}; reduced=false; performance=false`
          );

          await requestPointer(12, 12);
          await openAt(795, 495);
          const menuRect = menu.getBoundingClientRect();
          check(
            testCase,
            `${mode.label}: context menu opened at the bottom-right stays inside the viewport`,
            withinViewport(menuRect),
            `${Math.round(menuRect.left)},${Math.round(menuRect.top)}..${Math.round(menuRect.right)},${Math.round(menuRect.bottom)}`,
            'inside 0,0 to 800,500'
          );
          if (mode.enabled) {
            const contextMenuBackdropFilter = getComputedStyle(menu).backdropFilter;
            check(
              testCase,
              'Liquid Glass on: context menu has an active computed backdrop filter',
              contextMenuBackdropFilter !== 'none' && contextMenuBackdropFilter !== '',
              contextMenuBackdropFilter,
              'a computed backdrop filter other than none'
            );
          }

          const openWithCallsBeforePointer = fixture.calls.filter(
            (call) => call.command === 'get_open_with_apps'
          ).length;
          const parentRect = parent.getBoundingClientRect();
          await requestPointer(
            parentRect.left + Math.min(parentRect.width / 2, 36),
            parentRect.top + parentRect.height / 2
          );
          await waitFor(
            () =>
              panel.querySelectorAll('.context-menu-item').length ===
                OPEN_WITH_APPS_FIXTURE.length &&
              fixture.calls.filter((call) => call.command === 'get_open_with_apps').length >
                openWithCallsBeforePointer,
            'Pointer hover did not load the Open With fixture actions.',
            4000
          );
          let previousPanelGeometry = '';
          let stablePanelGeometrySamples = 0;
          await waitForStable(
            () => {
              if (
                panel.querySelectorAll('.context-menu-item').length !==
                OPEN_WITH_APPS_FIXTURE.length
              ) {
                return false;
              }
              const rect = panel.getBoundingClientRect();
              const geometry = [rect.left, rect.top, rect.right, rect.bottom]
                .map((value) => Math.round(value * 10) / 10)
                .join(',');
              if (geometry === previousPanelGeometry) stablePanelGeometrySamples += 1;
              else {
                previousPanelGeometry = geometry;
                stablePanelGeometrySamples = 0;
              }
              return stablePanelGeometrySamples > 0;
            },
            `${mode.label}: Open With submenu geometry did not settle after loading apps.`,
            4000
          );
          check(
            testCase,
            `${mode.label}: pointer hover loads Open With actions`,
            parent.matches(':hover') &&
              fixture.calls.filter((call) => call.command === 'get_open_with_apps').length ===
                openWithCallsBeforePointer + 1,
            `hover=${parent.matches(':hover')}; app-list requests=${fixture.calls.filter((call) => call.command === 'get_open_with_apps').length - openWithCallsBeforePointer}`,
            'parent hovered and one deterministic app-list request'
          );
          const panelRect = panel.getBoundingClientRect();
          const panelStyle = getComputedStyle(panel);
          const firstPanelItemRect = panel
            .querySelector('.context-menu-item')
            ?.getBoundingClientRect();
          const panelPositionDiagnostics = `cssText=${panel.style.cssText}; position=${panelStyle.position}; left=${panelStyle.left}; top=${panelStyle.top}; owner=${panel.parentElement?.id || panel.parentElement?.tagName || 'missing'}; expanded=${parent.getAttribute('aria-expanded')}; viewport=${window.innerWidth}x${window.innerHeight}; stable-geometry=${previousPanelGeometry}; first-item=${firstPanelItemRect ? `${Math.round(firstPanelItemRect.left)},${Math.round(firstPanelItemRect.top)}..${Math.round(firstPanelItemRect.right)},${Math.round(firstPanelItemRect.bottom)}` : 'missing'}`;
          const submenuAnchor = submenuAdjacency(panelRect, parent.getBoundingClientRect());
          const lastApp = panel.querySelector('.context-menu-item:last-child');
          const lastAppRect = lastApp?.getBoundingClientRect();
          const menuHasNoHorizontalScroll =
            menu.scrollWidth <= menu.clientWidth + 1 &&
            panel.scrollWidth <= panel.clientWidth + 1 &&
            document.documentElement.scrollWidth <= window.innerWidth + 1;
          const submenuCanReachLastAction = Boolean(
            lastApp &&
            lastAppRect &&
            (panel.scrollHeight <= panel.clientHeight + 1 ||
              ['auto', 'scroll'].includes(panelStyle.overflowY))
          );
          check(
            testCase,
            `${mode.label}: pointer Open With submenu stays inside the bottom-right viewport edge`,
            withinViewport(panelRect),
            `${Math.round(panelRect.left)},${Math.round(panelRect.top)}..${Math.round(panelRect.right)},${Math.round(panelRect.bottom)}; overflow=${panelStyle.overflowY}; items=${panel.querySelectorAll('.context-menu-item').length}`,
            'submenu inside 0,0 to 800,500'
          );
          check(
            testCase,
            `${mode.label}: pointer Open With submenu remains anchored to its trigger`,
            submenuAnchor.adjacent,
            `side-gap=${Math.round(submenuAnchor.sideGap)}; vertical-gap=${Math.round(submenuAnchor.verticalGap)}; viewport-clamp-overlap=${submenuAnchor.viewportClampOverlap}; trigger=${Math.round(parent.getBoundingClientRect().left)},${Math.round(parent.getBoundingClientRect().top)}..${Math.round(parent.getBoundingClientRect().right)},${Math.round(parent.getBoundingClientRect().bottom)}; submenu=${Math.round(panelRect.left)},${Math.round(panelRect.top)}..${Math.round(panelRect.right)},${Math.round(panelRect.bottom)}; ${panelPositionDiagnostics}`,
            'submenu beside its trigger or overlapping it at a viewport clamp'
          );
          check(
            testCase,
            `${mode.label}: context menu layers do not introduce horizontal scrolling and keep the last action reachable`,
            menuHasNoHorizontalScroll && submenuCanReachLastAction,
            `menu=${menu.scrollWidth}/${menu.clientWidth}; submenu=${panel.scrollWidth}/${panel.clientWidth}; page=${document.documentElement.scrollWidth}/${window.innerWidth}; overflowY=${panelStyle.overflowY}; last=${lastAppRect ? `${Math.round(lastAppRect.top)}..${Math.round(lastAppRect.bottom)}` : 'missing'}`,
            'no horizontal overflow and the final submenu action can be reached'
          );
          await screenshot(testCase, `context-menu-${mode.slug}-open-with-edge`);

          const firstApp = panel.querySelector('.context-menu-item:first-child');
          if (!firstApp) throw new Error('The first Open With fixture action is missing.');
          const pointerActionCallsBefore = fixture.calls.filter(
            (call) => call.command === 'open_file_with_app'
          ).length;
          const firstAppRect = firstApp.getBoundingClientRect();
          const parentPointerX = parentRect.left + Math.min(parentRect.width / 2, 36);
          const parentPointerY = parentRect.top + parentRect.height / 2;
          const firstAppPointerX = firstAppRect.left + firstAppRect.width / 2;
          const firstAppPointerY = firstAppRect.top + firstAppRect.height / 2;
          const pointerSteps = await movePointerInSteps(
            parentPointerX,
            parentPointerY,
            firstAppPointerX,
            firstAppPointerY
          );
          const pointerCrossedIntoSubmenu =
            getComputedStyle(panel).display !== 'none' &&
            firstApp.matches(':hover') &&
            panel.contains(document.elementFromPoint(firstAppPointerX, firstAppPointerY));
          check(
            testCase,
            `${mode.label}: stepped pointer travel crosses into the submenu without closing it`,
            pointerCrossedIntoSubmenu,
            `steps=${pointerSteps}; panel-display=${getComputedStyle(panel).display}; action-hovered=${firstApp.matches(':hover')}`,
            'submenu remains open and the destination action receives pointer hover'
          );
          await requestPointer(firstAppPointerX, firstAppPointerY, 'click');
          const pointerActionReached = await waitFor(
            () =>
              fixture.calls.some(
                (call) =>
                  call.command === 'open_file_with_app' &&
                  call.args.appId === OPEN_WITH_APPS_FIXTURE[0].id &&
                  fixture.calls.filter((entry) => entry.command === 'open_file_with_app').length ===
                    pointerActionCallsBefore + 1
              ),
            'Pointer activation did not reach the first Open With action.',
            1200
          ).then(
            () => true,
            () => false
          );
          check(
            testCase,
            `${mode.label}: pointer can activate an Open With submenu action`,
            pointerActionReached,
            `invocations=${fixture.calls.filter((call) => call.command === 'open_file_with_app').length - pointerActionCallsBefore}; first=${fixture.calls.find((call) => call.command === 'open_file_with_app')?.args.appId || 'none'}`,
            'first fixture app action invoked once'
          );

          row = await findStableRow(
            itemPath,
            'The context menu fixture row is not connected before Escape dismissal.'
          );
          row.focus({ preventScroll: true });
          await requestPointer(12, 12);
          await openAt(12, 12);
          const escapeHadMenuFocus = menu.contains(document.activeElement);
          dispatchKey('Escape');
          await waitFor(
            () => menu.style.display === 'none',
            `${mode.label}: Escape did not close the context menu.`
          );
          check(
            testCase,
            `${mode.label}: Escape closes the context menu and restores row focus`,
            escapeHadMenuFocus && document.activeElement === row,
            `menu=${menu.style.display}; active=${document.activeElement === row ? itemPath : document.activeElement?.id || document.activeElement?.textContent}`,
            'menu closed with focus restored to the invoking file row'
          );

          await requestPointer(790, 490);
          const openWithCallsBeforeKeyboard = fixture.calls.filter(
            (call) => call.command === 'get_open_with_apps'
          ).length;
          await openAt(12, 12);
          for (let index = 0; index < 48 && document.activeElement !== parent; index += 1) {
            dispatchKey('ArrowDown');
          }
          check(
            testCase,
            `${mode.label}: keyboard navigation reaches the Open With submenu parent`,
            document.activeElement === parent,
            document.activeElement?.id || document.activeElement?.textContent,
            'open-with-submenu has keyboard focus'
          );
          dispatchKey('ArrowRight');
          await waitFor(
            () =>
              panel.querySelectorAll('.context-menu-item').length ===
                OPEN_WITH_APPS_FIXTURE.length &&
              fixture.calls.filter((call) => call.command === 'get_open_with_apps').length >
                openWithCallsBeforeKeyboard,
            'Keyboard activation did not load Open With fixture actions.',
            4000
          );
          dispatchKey('ArrowLeft');
          await waitFor(
            () => getComputedStyle(panel).display === 'none',
            `${mode.label}: ArrowLeft did not close the Open With submenu.`,
            1200
          );
          check(
            testCase,
            `${mode.label}: ArrowLeft closes the submenu and restores trigger focus`,
            getComputedStyle(panel).display === 'none' && document.activeElement === parent,
            `panel=${getComputedStyle(panel).display}; active=${document.activeElement?.id || document.activeElement?.textContent}`,
            'submenu closed and open-with-submenu has focus'
          );
          dispatchKey('ArrowRight');
          await waitFor(
            () =>
              getComputedStyle(panel).display !== 'none' &&
              panel.querySelectorAll('.context-menu-item').length === OPEN_WITH_APPS_FIXTURE.length,
            `${mode.label}: ArrowRight did not reopen the populated Open With submenu.`,
            1200
          ).catch((error) => {
            throw new Error(
              `${error?.message || error}; expanded=${parent.getAttribute('aria-expanded')}; focus=${document.activeElement?.id || document.activeElement?.textContent}; panel=${panel.style.cssText}; computed=${getComputedStyle(panel).display}/${getComputedStyle(panel).left}/${getComputedStyle(panel).top}; owner=${panel.parentElement?.id || panel.parentElement?.tagName || 'missing'}; items=${panel.querySelectorAll('.context-menu-item').length}; requests=${fixture.calls.filter((call) => call.command === 'get_open_with_apps').length}`
            );
          });
          for (let index = 1; index < OPEN_WITH_APPS_FIXTURE.length; index += 1) {
            dispatchKey('ArrowDown');
          }
          const keyboardLastApp = panel.querySelector('.context-menu-item:last-child');
          const keyboardLastRect = keyboardLastApp?.getBoundingClientRect();
          const keyboardLastReachable = Boolean(
            keyboardLastApp &&
            document.activeElement === keyboardLastApp &&
            keyboardLastApp.classList.contains('focused') &&
            keyboardLastRect &&
            withinViewport(keyboardLastRect)
          );
          check(
            testCase,
            `${mode.label}: keyboard can reach the final Open With action at the top-left menu edge`,
            keyboardLastReachable,
            `${keyboardLastApp?.textContent}; rect=${keyboardLastRect ? `${Math.round(keyboardLastRect.left)},${Math.round(keyboardLastRect.top)}..${Math.round(keyboardLastRect.right)},${Math.round(keyboardLastRect.bottom)}` : 'missing'}; active=${document.activeElement?.textContent}`,
            'final action focused and visible inside the viewport'
          );
          const keyboardActionCallsBefore = fixture.calls.filter(
            (call) => call.command === 'open_file_with_app'
          ).length;
          dispatchKey('Enter');
          const keyboardActionReached = await waitFor(
            () =>
              fixture.calls.some(
                (call) =>
                  call.command === 'open_file_with_app' &&
                  call.args.appId === OPEN_WITH_APPS_FIXTURE.at(-1).id &&
                  fixture.calls.filter((entry) => entry.command === 'open_file_with_app').length ===
                    keyboardActionCallsBefore + 1
              ),
            'Keyboard activation did not invoke the final Open With action.',
            1200
          ).then(
            () => true,
            () => false
          );
          check(
            testCase,
            `${mode.label}: keyboard activation invokes the selected Open With action`,
            keyboardActionReached,
            `invocations=${fixture.calls.filter((call) => call.command === 'open_file_with_app').length - keyboardActionCallsBefore}; last=${fixture.calls.find((call) => call.command === 'open_file_with_app' && call.args.appId === OPEN_WITH_APPS_FIXTURE.at(-1).id)?.args.appId || 'none'}`,
            'final fixture app action invoked once'
          );
        }
      },
      async () => {
        if (fixture.settingsStore.reduceTransparency !== originalReduceTransparency) {
          await setSettingAndSave('reduce-transparency-toggle', originalReduceTransparency);
        }
        if (fixture.settingsStore.liquidGlassMode !== originalLiquidGlass) {
          await setSettingAndSave('liquid-glass-toggle', originalLiquidGlass);
        }
        document.body.classList.toggle('performance-mode', originalPerformanceMode);
        const menu = document.getElementById('context-menu');
        if (menu?.style.display === 'block') dispatchKey('Escape');
      }
    );

    await runCase(
      'search-states-and-filters',
      {
        viewport: { width: 1200, height: 800 },
        fixtureIds: [SEARCH_LOADING_FIXTURE_ID],
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        await navigateToDirectory(WORKSPACE_PATH);
        document.getElementById('search-btn')?.click();
        await waitFor(
          () => isVisible(document.getElementById('search-input')),
          'Search input did not open for the state checks.'
        );
        const scope = document.getElementById('search-scope-toggle');
        check(
          testCase,
          'search scope stays visible beside the input',
          Boolean(scope && isVisible(scope) && scope.getAttribute('aria-label')),
          scope ? `${textOf(scope)}; ${scope.getAttribute('aria-label')}` : 'missing',
          'visible labelled scope control'
        );
        const filterToggle = document.getElementById('search-filter-toggle');
        const filtersPanel = document.getElementById('search-filters-panel');
        check(
          testCase,
          'regex, saved search, and advanced filters stay behind the filter control',
          Boolean(
            filterToggle &&
            isVisible(filterToggle) &&
            getComputedStyle(filtersPanel).display === 'none' &&
            filtersPanel.contains(document.getElementById('search-regex-toggle')) &&
            filtersPanel.contains(document.getElementById('search-save-btn'))
          ),
          `panel=${getComputedStyle(filtersPanel).display}; regex=${filtersPanel.contains(document.getElementById('search-regex-toggle'))}; save=${filtersPanel.contains(document.getElementById('search-save-btn'))}`,
          'hidden panel containing regex and save actions'
        );
        filterToggle?.click();
        await waitFor(
          () => getComputedStyle(filtersPanel).display !== 'none',
          'The search filter control did not open its panel.'
        );
        const fileType = document.getElementById('search-filter-type');
        if (fileType instanceof HTMLSelectElement) fileType.value = 'document';
        document.getElementById('search-filter-apply')?.click();
        await waitFor(
          () => textOf(document.getElementById('filter-badge')) === '1',
          'The active search filter count did not appear.'
        );
        check(
          testCase,
          'active search filters expose a count badge',
          textOf(document.getElementById('filter-badge')) === '1' &&
            getComputedStyle(document.getElementById('filter-badge')).display !== 'none',
          textOf(document.getElementById('filter-badge')),
          '1'
        );
        const searchInput = document.getElementById('search-input');
        const search = async (query) => {
          searchInput.value = query;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
          );
        };
        await search('zzzz');
        await waitFor(
          () => Boolean(document.querySelector('#file-grid .search-empty-state')),
          'The empty search state did not render.'
        );
        check(
          testCase,
          'search renders an explicit empty state',
          textOf(document.querySelector('#file-grid .search-empty-state')).includes(
            'No results found'
          ) && textOf(document.getElementById('status-search-text')).includes('No results'),
          textOf(document.getElementById('status-search-text')),
          'No results in grid and status'
        );
        const regexToggle = document.getElementById('search-regex-toggle');
        filterToggle?.click();
        await waitFor(
          () => getComputedStyle(filtersPanel).display !== 'none',
          'The search filter panel did not reopen for the regex check.'
        );
        regexToggle?.click();
        await search('[');
        await waitFor(
          () =>
            textOf(document.getElementById('status-search-text')).includes(
              'Invalid regular expression'
            ),
          'Invalid regex did not produce an explicit search error state.'
        );
        check(
          testCase,
          'search renders an explicit error state for invalid expressions',
          textOf(document.getElementById('status-search-text')).includes(
            'Invalid regular expression'
          ) && searchInput.classList.contains('input-error'),
          textOf(document.getElementById('status-search-text')),
          'visible invalid-regex error'
        );
        regexToggle?.click();
        const gate = fixture.searchLoadingGate;
        gate.enabled = true;
        gate.started = false;
        gate.invocations = 0;
        await search('slow');
        await waitFor(
          () => gate.started,
          'The slow search did not reach its held-response fixture.',
          8000
        );
        const loading = document.getElementById('loading');
        check(
          testCase,
          'search shows an explicit loading state while the native query is pending',
          isVisible(loading) &&
            textOf(document.getElementById('loading-text')).includes('Searching') &&
            textOf(document.getElementById('status-search-text')).includes('Searching'),
          `${textOf(document.getElementById('loading-text'))}; ${textOf(document.getElementById('status-search-text'))}`,
          'visible Searching state'
        );
        gate.release?.();
        await waitFor(
          () => !isVisible(loading),
          'The held search did not clear its loading state after release.'
        );
        await waitFor(
          () => Boolean(document.querySelector('#file-grid .search-empty-state')),
          'The released slow search did not render its empty state.'
        );
        await search('meeting');
        await waitForStable(
          () =>
            textOf(document.getElementById('file-grid')).includes('Meeting-Notes.txt') &&
            textOf(document.getElementById('status-search-text')).includes('1 result'),
          'The completed search did not render its result count and match.'
        );
        check(
          testCase,
          'search loading clears into an explicit result count',
          textOf(document.getElementById('status-search-text')).includes('1 result') &&
            textOf(document.getElementById('file-grid')).includes('Meeting-Notes.txt'),
          textOf(document.getElementById('status-search-text')),
          '1 result with Meeting-Notes.txt'
        );
        gate.release?.();
        gate.enabled = false;
        if (gate.timeout) clearTimeout(gate.timeout);
        gate.timeout = null;
        document.getElementById('search-close')?.click();
        await waitFor(
          () =>
            getComputedStyle(document.getElementById('search-input')).display === 'none' ||
            !isVisible(document.getElementById('search-input')),
          'Search did not close after the state checks.'
        );
      },
      async () => {
        const gate = fixture.searchLoadingGate;
        gate.release?.();
        gate.enabled = false;
        if (gate.timeout) clearTimeout(gate.timeout);
        gate.timeout = null;
      }
    );

    await runCase(
      'surface-settings-dialogs-and-about',
      {
        viewport: { width: 1200, height: 800 },
        theme: 'default',
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        await openSettings();
        const settingRows = Array.from(
          document.querySelectorAll('#tab-appearance .setting-item')
        ).filter(isVisible);
        const misaligned = settingRows.filter((row) => {
          const info = row.querySelector('.setting-info');
          const control = row.querySelector(
            ':scope > .toggle-switch, :scope > select, :scope > .modal-button, :scope > div > .modal-button'
          );
          if (!info || !control) return false;
          const rowRect = row.getBoundingClientRect();
          const infoRect = info.getBoundingClientRect();
          const controlRect = control.getBoundingClientRect();
          const rowCenter = rowRect.top + rowRect.height / 2;
          const controlCenter = controlRect.top + controlRect.height / 2;
          return controlRect.left <= infoRect.left || Math.abs(rowCenter - controlCenter) > 14;
        });
        check(
          testCase,
          'settings rows align labels and controls on one line',
          settingRows.length >= 4 && misaligned.length === 0,
          `${settingRows.length} rows; ${misaligned.length} misaligned`,
          'at least four aligned rows'
        );
        const settingsPanel = document.querySelector('#settings-modal .settings-modal');
        check(
          testCase,
          'settings surface remains opaque outside Liquid Glass exceptions',
          computedColorAlpha(getComputedStyle(settingsPanel).backgroundColor) >= 0.94,
          getComputedStyle(settingsPanel).backgroundColor,
          'alpha >= 0.94'
        );
        document.getElementById('settings-tab-about')?.click();
        await waitFor(
          () => document.getElementById('tab-about')?.hidden === false,
          'The About settings tab did not open.'
        );
        await waitFor(
          () => textOf(document.getElementById('about-version-display')).includes('3.1.0'),
          'The About tab did not show the application version.'
        );
        check(
          testCase,
          'About surface shows application identity and version',
          textOf(document.getElementById('tab-about')).includes('IYERIS') &&
            textOf(document.getElementById('about-version-display')).includes('3.1.0'),
          textOf(document.getElementById('about-version-display')),
          'IYERIS and 3.1.0'
        );
        document.getElementById('settings-tab-appearance')?.click();
        await waitFor(
          () => document.getElementById('tab-appearance')?.hidden === false,
          'The Appearance settings tab did not reopen.'
        );
        await changeSetting('theme-select', 'custom');
        await saveSettings();
        check(
          testCase,
          'custom theme colors apply from the saved custom palette',
          document.body.classList.contains('theme-custom') &&
            document.documentElement.style.getPropertyValue('--custom-accent-color').trim() ===
              fixture.settingsStore.customTheme.accentColor &&
            document.documentElement.style.getPropertyValue('--custom-bg-primary').trim() ===
              fixture.settingsStore.customTheme.bgPrimary,
          `${Array.from(document.body.classList)
            .filter((name) => name.startsWith('theme-'))
            .join(
              ' '
            )}; accent=${document.documentElement.style.getPropertyValue('--custom-accent-color')}`,
          `${fixture.settingsStore.customTheme.accentColor}; ${fixture.settingsStore.customTheme.bgPrimary}`
        );
        await setSettingAndSave('theme-select', 'default');
        const surfaceHome = document.querySelector(
          '#sidebar-quick-access-grid [data-action="home"]'
        );
        surfaceHome?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(
          () => isVisible(document.getElementById('home-view')),
          'Home did not open for the dialog footer check.'
        );
        document.getElementById('home-customize-btn')?.click();
        await waitFor(
          () => document.getElementById('home-settings-modal')?.style.display === 'flex',
          'Home preferences did not open for the dialog footer check.'
        );
        const dialogToggle = document.getElementById('home-toggle-recents');
        dialogToggle.checked = !dialogToggle.checked;
        dialogToggle.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('home-settings-cancel')?.click();
        await waitFor(
          () => document.getElementById('dialog-modal')?.style.display === 'flex',
          'Unsaved Home preferences did not request discard confirmation.'
        );
        const dialogFooter = document.querySelector('#dialog-modal .modal-footer');
        const footerButtons = Array.from(dialogFooter.querySelectorAll('button')).filter(isVisible);
        const footerRect = dialogFooter.getBoundingClientRect();
        const footerStyle = getComputedStyle(dialogFooter);
        check(
          testCase,
          'confirm dialog uses the shared right-aligned footer',
          footerStyle.flexDirection === 'row' &&
            footerButtons.length >= 2 &&
            footerButtons.every(
              (button) => button.getBoundingClientRect().width < footerRect.width
            ) &&
            footerButtons[footerButtons.length - 1].getBoundingClientRect().right >
              footerRect.left + footerRect.width / 2,
          `${footerStyle.flexDirection}; ${footerButtons.length} buttons`,
          'row footer with right-aligned buttons'
        );
        const dialogSurface = document.querySelector('#dialog-modal .dialog-modal');
        check(
          testCase,
          'default dialog surface has no unintended transparency or blur',
          computedColorAlpha(getComputedStyle(dialogSurface).backgroundColor) >= 0.94 &&
            ['none', ''].includes(getComputedStyle(dialogSurface).backdropFilter),
          `${getComputedStyle(dialogSurface).backgroundColor}; ${getComputedStyle(dialogSurface).backdropFilter}`,
          'opaque surface; no blur'
        );
        check(
          testCase,
          'onboarding prompt stays dismissed for completed tours',
          getComputedStyle(document.getElementById('tour-prompt-modal')).display === 'none' &&
            getComputedStyle(document.getElementById('tour-overlay')).display === 'none',
          `${getComputedStyle(document.getElementById('tour-prompt-modal')).display}; ${getComputedStyle(document.getElementById('tour-overlay')).display}`,
          'none; none'
        );
        document.getElementById('dialog-ok')?.click();
        await waitFor(
          () => document.getElementById('dialog-modal')?.style.display === 'none',
          'The discard-confirmation dialog did not close.'
        );
        if (document.getElementById('home-settings-modal')?.style.display === 'flex') {
          document.getElementById('home-settings-cancel')?.click();
          await waitFor(
            () =>
              document.getElementById('home-settings-modal')?.style.display === 'none' ||
              document.getElementById('dialog-modal')?.style.display === 'flex',
            'Home preferences did not close after discarding changes.'
          );
          if (document.getElementById('dialog-modal')?.style.display === 'flex') {
            document.getElementById('dialog-ok')?.click();
            await waitFor(
              () => document.getElementById('home-settings-modal')?.style.display === 'none',
              'Home preferences did not close after the discard confirmation.'
            );
          }
        }
      }
    );

    await runCase(
      'shell-keyboard-focus-and-dismissal',
      {
        viewport: { width: 1200, height: 800 },
        accessibility: Object.fromEntries(ACCESSIBILITY_SETTINGS.map(([, key]) => [key, true])),
      },
      async (testCase) => {
        await currentViewport(1200, 800);
        await setAccessibilityProfile(true);
        await currentViewport(1200, 800);
        await waitFor(
          () => document.body.classList.contains('visible-focus'),
          'The visible-focus accessibility profile is not active for the keyboard check.'
        );
        await navigateToDirectory(WORKSPACE_PATH);
        const targets = [
          ['sidebar toggle', document.getElementById('sidebar-toggle')],
          ['More menu', menuButton()],
          ['search control', document.getElementById('search-btn')],
          [
            'view selector',
            document.querySelector('#view-options [data-view="grid"]') ||
              document.getElementById('view-toggle-btn'),
          ],
        ];
        const focusFailures = [];
        for (const [name, element] of targets) {
          if (!(await focusVisible(element))) focusFailures.push(name);
        }
        const fileRow = await findStableRow(
          `${WORKSPACE_PATH}/Readme.md`,
          'The keyboard fixture row is not connected.'
        );
        if (!(await focusVisible(fileRow))) focusFailures.push('file row');
        check(
          testCase,
          'new toolbar, search, view, and file-row controls show visible focus',
          focusFailures.length === 0,
          focusFailures.join(', ') || 'all focused controls outlined',
          'every focused control shows an outline'
        );
        menuButton()?.click();
        await doubleFrame();
        dispatchKey('ArrowDown');
        await doubleFrame();
        dispatchKey('Escape');
        await doubleFrame();
        check(
          testCase,
          'Escape closes More and restores trigger focus',
          menuPanel()?.style.display !== 'block' && document.activeElement === menuButton(),
          `${menuPanel()?.style.display}; ${document.activeElement?.id || 'none'}`,
          'closed; focus=more-actions-btn'
        );
        document.getElementById('search-btn')?.click();
        await waitFor(
          () => isVisible(document.getElementById('search-input')),
          'Search did not open for the keyboard check.'
        );
        check(
          testCase,
          'search input receives a visible focus ring',
          await focusVisible(document.getElementById('search-input')),
          getComputedStyle(document.getElementById('search-input')).outlineWidth,
          'outline at least 1px'
        );
        document.getElementById('search-close')?.click();
        await doubleFrame();
        const home = document.querySelector('#sidebar-quick-access-grid [data-action="home"]');
        home.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitFor(
          () => isVisible(document.getElementById('home-view')),
          'Home did not open for the keyboard check.'
        );
        check(
          testCase,
          'Home customize and Home destination controls show visible focus',
          (await focusVisible(document.getElementById('home-customize-btn'))) &&
            (await focusVisible(document.querySelector('#home-quick-access .home-item'))),
          'customize and first Home item outlined',
          'both controls show focus outlines'
        );
        await navigateToDirectory(WORKSPACE_PATH);
        let folderButton = document.getElementById('new-folder-btn');
        if (!isVisible(folderButton)) {
          menuButton()?.click();
          await doubleFrame();
          folderButton = document.getElementById('new-folder-btn');
        }
        if (!(folderButton instanceof HTMLElement) || !isVisible(folderButton)) {
          throw new Error('New Folder is not reachable for the Escape focus check.');
        }
        folderButton.focus({ preventScroll: true });
        folderButton.click();
        await waitFor(
          () => document.getElementById('dialog-modal')?.style.display === 'flex',
          'The operation error dialog did not open for Escape focus restoration.'
        );
        dispatchKey('Escape');
        await waitFor(
          () => document.getElementById('dialog-modal')?.style.display === 'none',
          'Escape did not dismiss the operation error dialog.'
        );
        check(
          testCase,
          'Escape dismissal returns focus to the dialog opener',
          document.activeElement === folderButton,
          document.activeElement?.id || 'none',
          'new-folder-btn'
        );
        if (menuPanel()?.style.display === 'block') {
          menuButton()?.click();
          await doubleFrame();
        }
      }
    );

    const unexpectedInvokes = fixture.unexpectedInvokes;
    const guardCase = beginCase('native-invoke-allowlist');
    check(
      guardCase,
      'all real renderer native calls are covered by explicit fixtures',
      unexpectedInvokes.length === 0,
      unexpectedInvokes.map((call) => `${call.command} (${call.caseId})`).join(', ') || 'none',
      'none'
    );
  }

  if (fixture) {
    record.nativeFixture = {
      fixtureId: FIXTURE_ID,
      allowedInvokeCommands: fixture.allowedInvokeCommands,
      expectedErrorFixtures: EXPECTED_OPERATION_FIXTURES,
      zoomSimulation: 'set_zoom_level applies document.documentElement.style.zoom',
      unexpectedInvokes: fixture.unexpectedInvokes,
      settingsSaves: fixture.saveSettingsCount,
      homeSettingsSaves: fixture.saveHomeSettingsCount,
      homeSettingsSaveGate: {
        fixtureId: fixture.homeSettingsSaveGate.fixtureId,
        started: fixture.homeSettingsSaveGate.started,
        invocations: fixture.homeSettingsSaveGate.invocations,
        autoReleaseMs: 12000,
      },
      searchLoadingGate: {
        fixtureId: fixture.searchLoadingGate.fixtureId,
        started: fixture.searchLoadingGate.started,
        invocations: fixture.searchLoadingGate.invocations,
        autoReleaseMs: 8000,
      },
      finalSettings: clone(fixture.settingsStore),
      finalHomeSettings: clone(fixture.homeSettingsStore),
      calls: fixture.calls,
      directoryLoads: fixture.directoryLoads,
    };
  }

  record.passed =
    !record.harnessError &&
    failures.length === 0 &&
    record.checks.length > 0 &&
    record.checks.every((item) => item.passed);
  if (!record.passed) {
    const detail = failures.slice(0, 24).join('; ');
    throw new Error(`full-app-310-redesign: ${failures.length} check(s) failed: ${detail}`);
  }
  return record;
}
