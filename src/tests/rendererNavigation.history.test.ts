// @vitest-environment jsdom
/**
 * Coverage for the directory-history dropdown and async breadcrumb-menu
 * contracts introduced after v3.0.4. These complement the restored
 * breadcrumb interaction suite, which predates the history keyboard model
 * and the operation-id cancellation path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: () => '<img data-icon="folder">',
}));

import { createNavigationController } from '../rendererNavigation';

HTMLElement.prototype.scrollIntoView ??= function () {};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setupDom(): void {
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
    <div id="file-grid"></div>
  `;
}

function createDeps(
  options: {
    history?: string[];
    save?: { success: boolean; error?: string };
    navigate?: (path: string) => void | Promise<void>;
  } = {}
) {
  const settings = {
    enableSearchHistory: true,
    directoryHistory: options.history ?? ['/one', '/two'],
    showHiddenFiles: false,
  };
  let operationCounter = 0;
  return {
    settings,
    getCurrentPath: vi.fn(() => '/workspace'),
    getCurrentSettings: vi.fn(() => settings),
    getBreadcrumbContainer: () => document.getElementById('breadcrumb-container'),
    getBreadcrumbMenu: () => document.getElementById('breadcrumb-menu'),
    getAddressInput: () => document.getElementById('address-input') as HTMLInputElement | null,
    getPathDisplayValue: (path: string) => path,
    isHomeViewPath: (path: string) => path === 'home-view',
    homeViewLabel: 'Home',
    homeViewPath: 'home-view',
    navigateTo: vi.fn(options.navigate ?? (() => {})),
    createDirectoryOperationId: vi.fn(() => `op-${++operationCounter}`),
    cancelDirectoryContents: vi.fn().mockResolvedValue(undefined),
    nameCollator: new Intl.Collator(),
    getFolderIcon: () => '<img data-icon="folder">',
    getDragOperation: vi.fn(() => 'copy' as const),
    showDropIndicator: vi.fn(),
    hideDropIndicator: vi.fn(),
    getDraggedPaths: vi.fn().mockResolvedValue([]),
    handleDrop: vi.fn().mockResolvedValue(true),
    debouncedSaveSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue(options.save ?? { success: true }),
    showToast: vi.fn(),
    directoryHistoryMax: 10,
  };
}

function keydown(el: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

function directoryResult(names: string[]) {
  return {
    success: true,
    contents: names.map((name) => ({
      name,
      path: `/workspace/${name}`,
      isDirectory: true,
      isFile: false,
      isHidden: false,
    })),
  };
}

describe('navigation directory history', () => {
  beforeEach(() => {
    setupDom();
    (window as any).tauriAPI = {
      getDirectoryContents: vi.fn().mockResolvedValue(directoryResult([])),
    };
  });

  function setup(options: Parameters<typeof createDeps>[0] = {}) {
    const deps = createDeps(options);
    const controller = createNavigationController(deps as any);
    controller.updateBreadcrumb('/workspace');
    controller.setupBreadcrumbListeners();
    const input = document.getElementById('address-input') as HTMLInputElement;
    const dropdown = document.getElementById('directory-history-dropdown')!;
    return { controller, deps, input, dropdown };
  }

  it('opens history on focus and reflects the expanded state', () => {
    const { input, dropdown } = setup();

    input.focus();

    expect(dropdown.style.display).toBe('block');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(dropdown.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it('moves the active option with ArrowDown and exposes aria-activedescendant', () => {
    const { input, dropdown } = setup();
    input.focus();

    const first = keydown(input, 'ArrowDown');
    const options = dropdown.querySelectorAll<HTMLElement>('[role="option"]');

    expect(first.defaultPrevented).toBe(true);
    expect(options[0]!.classList.contains('dropdown-active')).toBe(true);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);

    keydown(input, 'ArrowDown');
    expect(options[0]!.getAttribute('aria-selected')).toBe('false');
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('wraps ArrowUp and supports Home and End', () => {
    const { input, dropdown } = setup();
    input.focus();
    const options = dropdown.querySelectorAll<HTMLElement>('[role="option"]');

    keydown(input, 'ArrowUp');
    expect(options[2]!.getAttribute('aria-selected')).toBe('true');

    keydown(input, 'Home');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    keydown(input, 'End');
    expect(options[2]!.getAttribute('aria-selected')).toBe('true');

    keydown(input, 'ArrowDown');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('navigates to the active history option on Enter', async () => {
    const { input, dropdown, deps } = setup();
    input.focus();
    keydown(input, 'ArrowDown');

    keydown(input, 'Enter');
    await flushPromises();

    expect(deps.navigateTo).toHaveBeenCalledWith('/one');
    expect(dropdown.style.display).toBe('none');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('navigates to the typed address on Enter when no option is active', async () => {
    const { input, deps } = setup();
    input.focus();
    input.value = '/typed/path';

    keydown(input, 'Enter');
    await flushPromises();

    expect(deps.navigateTo).toHaveBeenCalledWith('/typed/path');
  });

  it('maps the Home label to the home view path', async () => {
    const { input, deps } = setup();
    input.focus();
    input.value = 'Home';

    keydown(input, 'Enter');
    await flushPromises();

    expect(deps.navigateTo).toHaveBeenCalledWith('home-view');
  });

  it('reports navigation failures and restores breadcrumb focus', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('cannot navigate')));
    const { input, deps } = setup({ navigate: failing });
    input.focus();
    input.value = '/bad';

    keydown(input, 'Enter');
    await flushPromises();

    expect(deps.showToast).toHaveBeenCalledWith('cannot navigate', 'Navigation', 'error');
    expect(document.activeElement).toBe(
      document.querySelector('#breadcrumb-container .breadcrumb-label')
    );
  });

  it('navigates when a history option is clicked', async () => {
    const { input, dropdown, deps } = setup();
    input.focus();

    dropdown.querySelector<HTMLElement>('.history-item')!.click();
    await flushPromises();

    expect(deps.navigateTo).toHaveBeenCalledWith('/one');
    expect(dropdown.style.display).toBe('none');
  });

  it('clears history from the clear option', async () => {
    const { input, dropdown, deps } = setup();
    input.focus();

    dropdown.querySelector<HTMLElement>('.history-clear')!.click();
    await flushPromises();

    expect(deps.settings.directoryHistory).toEqual([]);
    expect(deps.saveSettingsWithTimestamp).toHaveBeenCalledWith(deps.settings);
    expect(deps.showToast).toHaveBeenCalledWith('Directory history cleared', 'History', 'success');
  });

  it('reports a failed history clear', async () => {
    const { input, dropdown, deps } = setup({ save: { success: false, error: 'denied' } });
    input.focus();

    dropdown.querySelector<HTMLElement>('.history-clear')!.click();
    await flushPromises();

    expect(deps.showToast).toHaveBeenCalledWith(
      'Failed to clear directory history',
      'History',
      'error'
    );
  });

  it('reports a thrown history clear', async () => {
    const { input, dropdown, deps } = setup();
    deps.saveSettingsWithTimestamp.mockRejectedValue(new Error('disk gone'));
    input.focus();

    dropdown.querySelector<HTMLElement>('.history-clear')!.click();
    await flushPromises();

    expect(deps.showToast).toHaveBeenCalledWith('disk gone', 'Navigation', 'error');
  });

  it('keeps focus in the address input when the dropdown is pressed', () => {
    const { input, dropdown } = setup();
    input.focus();

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    dropdown.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe('navigation breadcrumb menu lifecycle', () => {
  beforeEach(() => {
    setupDom();
  });

  it('cancels the active listing when hidden', async () => {
    const pending = deferred<ReturnType<typeof directoryResult>>();
    (window as any).tauriAPI = {
      getDirectoryContents: vi.fn(() => pending.promise),
    };
    const deps = createDeps();
    const controller = createNavigationController(deps as any);
    const anchor = document.createElement('button');
    document.getElementById('breadcrumb-container')!.appendChild(anchor);

    const opening = controller.showBreadcrumbMenu('/workspace', anchor);
    controller.hideBreadcrumbMenu();

    expect(deps.cancelDirectoryContents).toHaveBeenCalledWith('op-1');
    pending.resolve(directoryResult(['late']));
    await opening;

    expect(document.getElementById('breadcrumb-menu')!.style.display).toBe('none');
    expect(document.querySelectorAll('.breadcrumb-menu-item')).toHaveLength(0);
  });

  it('ignores a stale response when a newer listing replaced it', async () => {
    const first = deferred<ReturnType<typeof directoryResult>>();
    const second = deferred<ReturnType<typeof directoryResult>>();
    (window as any).tauriAPI = {
      getDirectoryContents: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const deps = createDeps();
    const controller = createNavigationController(deps as any);
    const anchor = document.createElement('button');
    document.getElementById('breadcrumb-container')!.appendChild(anchor);

    const openingFirst = controller.showBreadcrumbMenu('/workspace', anchor);
    const openingSecond = controller.showBreadcrumbMenu('/other', anchor);
    second.resolve(directoryResult(['fresh']));
    await openingSecond;
    first.resolve(directoryResult(['stale']));
    await openingFirst;

    const items = document.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('fresh');
  });

  it('shows a failure message and toast when listing throws', async () => {
    (window as any).tauriAPI = {
      getDirectoryContents: vi.fn().mockRejectedValue(new Error('bridge down')),
    };
    const deps = createDeps();
    const controller = createNavigationController(deps as any);
    const anchor = document.createElement('button');
    document.getElementById('breadcrumb-container')!.appendChild(anchor);

    await controller.showBreadcrumbMenu('/workspace', anchor);

    const menu = document.getElementById('breadcrumb-menu')!;
    expect(menu.textContent).toContain('Failed to load');
    expect(menu.getAttribute('aria-busy')).toBe('false');
    expect(deps.showToast).toHaveBeenCalledWith('bridge down', 'Navigation', 'error');
  });

  it('collapses long breadcrumbs and exposes the hidden segments', async () => {
    (window as any).tauriAPI = {
      getDirectoryContents: vi.fn().mockResolvedValue(directoryResult(['hidden-a', 'hidden-b'])),
    };
    const deps = createDeps();
    const controller = createNavigationController(deps as any);
    const container = document.getElementById('breadcrumb-container')!;
    Object.defineProperty(container, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(container, 'scrollWidth', { value: 300, configurable: true });

    controller.updateBreadcrumb('/a/b/c/d/e');
    const overflow = container.querySelector<HTMLElement>('.breadcrumb-overflow');
    expect(overflow).not.toBeNull();

    overflow!.click();
    await flushPromises();

    const menu = document.getElementById('breadcrumb-menu')!;
    const items = menu.querySelectorAll<HTMLElement>('.breadcrumb-menu-item');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('b');
    expect(items[1]!.textContent).toContain('c');
    expect(menu.style.display).toBe('block');
    expect(overflow!.getAttribute('aria-expanded')).toBe('true');
  });

  it('navigates to a collapsed segment and closes the menu', async () => {
    const deps = createDeps();
    const controller = createNavigationController(deps as any);
    const container = document.getElementById('breadcrumb-container')!;
    Object.defineProperty(container, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(container, 'scrollWidth', { value: 300, configurable: true });
    controller.updateBreadcrumb('/a/b/c/d/e');

    container.querySelector<HTMLElement>('.breadcrumb-overflow')!.click();
    await flushPromises();
    document.querySelectorAll<HTMLElement>('.breadcrumb-menu-item')[1]!.click();
    await flushPromises();

    expect(deps.navigateTo).toHaveBeenCalledWith('/a/b/c');
    expect(document.getElementById('breadcrumb-menu')!.style.display).toBe('none');
  });

  it('opens the collapsed menu from the keyboard and closes it with Escape', async () => {
    const deps = createDeps();
    const controller = createNavigationController(deps as any);
    const container = document.getElementById('breadcrumb-container')!;
    Object.defineProperty(container, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(container, 'scrollWidth', { value: 300, configurable: true });
    controller.updateBreadcrumb('/a/b/c/d/e');

    const overflow = container.querySelector<HTMLElement>('.breadcrumb-overflow')!;
    keydown(overflow, 'ArrowDown');
    await flushPromises();
    expect(document.getElementById('breadcrumb-menu')!.style.display).toBe('block');

    keydown(overflow, 'Escape');
    expect(document.getElementById('breadcrumb-menu')!.style.display).toBe('none');
  });
});
