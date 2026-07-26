// @vitest-environment jsdom
//
// Audit follow-up: the existing rendererUtilityDrawer suite covered the POSIX and
// Windows success paths plus one stale-selection case. Everything that happens
// when the backend says no was untested — failed permission writes, checksum
// errors, cancellation of superseded hashes, storage lookups that fail, and the
// gating that stops a passive selection from hashing a file in the background.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Settings } from '../types';

/** Controllable foreground signal; auto-checksum is gated on it. */
const activity = vi.hoisted(() => ({ foreground: true }));
vi.mock('../rendererActivityState.js', () => ({
  isForeground: () => activity.foreground,
}));

import { createUtilityDrawerController } from '../rendererUtilityDrawer';

function buildDom(): void {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="utility-drawer">
      <div id="utility-drawer-header">
        <button id="utility-drawer-toggle-btn" aria-expanded="false">Toggle</button>
        <div id="utility-drawer-status">No selection</div>
        <button id="utility-customize-btn" class="utility-customize-btn">Customize</button>
      </div>
      <div id="utility-drawer-body">
        <div class="utility-section utility-meta-section">
          <span id="utility-meta-path">-</span>
          <span id="utility-meta-size">-</span>
          <button id="utility-copy-path-btn">Copy Path</button>
          <button id="utility-copy-name-btn">Copy Name</button>
          <button id="utility-copy-uri-btn">Copy URI</button>
        </div>
        <div class="utility-section utility-perms-section">
          <div id="utility-no-perms-placeholder"></div>
          <div id="utility-posix-perms" style="display:none">
            <input type="checkbox" id="perm-ur" />
            <input type="checkbox" id="perm-uw" />
            <input type="checkbox" id="perm-ux" />
            <input type="checkbox" id="perm-gr" />
            <input type="checkbox" id="perm-gw" />
            <input type="checkbox" id="perm-gx" />
            <input type="checkbox" id="perm-or" />
            <input type="checkbox" id="perm-ow" />
            <input type="checkbox" id="perm-ox" />
            <input type="text" id="posix-octal-input" />
            <button id="utility-apply-posix-btn">Apply POSIX</button>
          </div>
          <div id="utility-win-attrs" style="display:none">
            <input type="checkbox" id="attr-readonly" />
            <input type="checkbox" id="attr-hidden" />
            <input type="checkbox" id="attr-system" />
            <button id="utility-apply-win-btn">Apply Windows</button>
          </div>
        </div>
        <div class="utility-section utility-checksum-section">
          <select id="utility-checksum-algo">
            <option value="sha256">SHA-256</option>
            <option value="md5">MD5</option>
          </select>
          <button id="utility-calc-checksum-btn">Calculate</button>
          <textarea id="utility-checksum-value"></textarea>
          <button id="utility-copy-checksum-btn">Copy</button>
        </div>
      </div>
    </div>
  `;
}

let settings: Settings;
let showToast: ReturnType<typeof vi.fn>;
let api: any;
let progressHandler: ((progress: { operationId: string; percent: number }) => void) | undefined;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const checksumBox = () => el<HTMLTextAreaElement>('utility-checksum-value');
const statusText = () => el('utility-drawer-status').textContent;

/** Settle promise chains on the fake clock (see the F5 conversion in this suite). */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

function makeController(overrides: Record<string, unknown> = {}) {
  const controller = createUtilityDrawerController({
    getCurrentSettings: () => settings,
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue(true),
    showToast,
    getCurrentPath: () => '/home/user',
    navigateTo: vi.fn(),
    ...overrides,
  } as any);
  controller.init();
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  activity.foreground = true;
  progressHandler = undefined;
  buildDom();

  settings = {
    utilityDrawerCollapsed: false,
    enableAutoChecksum: true,
    defaultChecksumAlgorithm: 'sha256',
    dashboardWidgets: ['quick-info', 'storage-overview'],
    bookmarks: [],
  } as any;

  showToast = vi.fn();
  api = {
    getPlatform: vi.fn().mockResolvedValue('darwin'),
    writeToSystemClipboard: vi.fn().mockResolvedValue(true),
    getItemProperties: vi.fn().mockResolvedValue({
      success: true,
      properties: { size: 1024, isDirectory: false, mode: 0o644 },
    }),
    setPermissions: vi.fn().mockResolvedValue({ success: true }),
    setAttributes: vi.fn().mockResolvedValue({ success: true }),
    calculateChecksum: vi.fn().mockResolvedValue({
      success: true,
      result: { sha256: 'abc123' },
    }),
    cancelChecksumCalculation: vi.fn().mockResolvedValue(true),
    getDiskSpace: vi.fn().mockResolvedValue({ success: true, total: 1000, free: 400 }),
    onChecksumProgress: vi.fn((handler: typeof progressHandler) => {
      progressHandler = handler;
    }),
  };
  (window as any).tauriAPI = api;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as any).tauriAPI;
});

describe('clipboard failures', () => {
  it.each([
    ['utility-copy-path-btn', 'path'],
    ['utility-copy-name-btn', 'filename'],
    ['utility-copy-uri-btn', 'uri'],
  ])('surfaces a clipboard rejection from %s', async (buttonId) => {
    api.writeToSystemClipboard.mockRejectedValue(new Error('clipboard busy'));
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();
    showToast.mockClear();

    el(buttonId).click();
    await settle();

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('clipboard busy'),
      'Error',
      'error'
    );
  });

  it('does nothing when there is no selection to copy', async () => {
    const controller = makeController();
    controller.updateSelection(null);
    await settle();

    el('utility-copy-path-btn').click();
    await settle();

    expect(api.writeToSystemClipboard).not.toHaveBeenCalled();
  });

  it('copies only the basename for the filename button', async () => {
    const controller = makeController();
    controller.updateSelection('/home/user/deep/report.pdf');
    await settle();

    el('utility-copy-name-btn').click();
    await settle();

    expect(api.writeToSystemClipboard).toHaveBeenCalledWith('report.pdf');
  });

  it('builds a file URI for posix, windows and UNC paths', async () => {
    const controller = makeController();

    const cases: Array<[string, string]> = [
      ['/home/user/a b.txt', 'file:///home/user/a%20b.txt'],
      ['C:\\Users\\me\\a.txt', 'file:///C:/Users/me/a.txt'],
      ['\\\\server\\share\\a.txt', 'file://server/share/a.txt'],
    ];

    for (const [input, expected] of cases) {
      controller.updateSelection(input);
      await settle();
      api.writeToSystemClipboard.mockClear();
      el('utility-copy-uri-btn').click();
      await settle();
      expect(api.writeToSystemClipboard).toHaveBeenCalledWith(expected);
    }
  });

  it('passes an already-formed file URI through unchanged', async () => {
    const controller = makeController();
    controller.updateSelection('file:///already/encoded.txt');
    await settle();

    el('utility-copy-uri-btn').click();
    await settle();

    expect(api.writeToSystemClipboard).toHaveBeenCalledWith('file:///already/encoded.txt');
  });

  it('surfaces a clipboard rejection when copying the checksum', async () => {
    api.writeToSystemClipboard.mockRejectedValue(new Error('denied'));
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();
    checksumBox().value = 'abc123';
    showToast.mockClear();

    el('utility-copy-checksum-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('denied'), 'Error', 'error');
  });
});

describe('permission write failures', () => {
  it('reports the backend error when a POSIX write fails', async () => {
    api.setPermissions.mockResolvedValue({ success: false, error: 'EPERM' });
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    el('utility-apply-posix-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith('EPERM', 'Error', 'error');
  });

  it('falls back to a generic message when the backend gives no reason', async () => {
    api.setPermissions.mockResolvedValue({ success: false });
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    el('utility-apply-posix-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith('Failed to update permissions', 'Error', 'error');
  });

  it('surfaces a rejected POSIX write', async () => {
    api.setPermissions.mockRejectedValue(new Error('ipc down'));
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    el('utility-apply-posix-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('ipc down'), 'Error', 'error');
  });

  it('reports the backend error when a Windows attribute write fails', async () => {
    api.setAttributes.mockResolvedValue({ success: false, error: 'ACCESS_DENIED' });
    const controller = makeController();
    controller.updateSelection('C:\\Users\\me\\a.txt');
    await settle();

    el('utility-apply-win-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith('ACCESS_DENIED', 'Error', 'error');
  });

  it('falls back to a generic message for a reasonless attribute failure', async () => {
    api.setAttributes.mockResolvedValue({ success: false });
    const controller = makeController();
    controller.updateSelection('C:\\Users\\me\\a.txt');
    await settle();

    el('utility-apply-win-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith('Failed to update attributes', 'Error', 'error');
  });

  it('surfaces a rejected attribute write', async () => {
    api.setAttributes.mockRejectedValue(new Error('ipc down'));
    const controller = makeController();
    controller.updateSelection('C:\\Users\\me\\a.txt');
    await settle();

    el('utility-apply-win-btn').click();
    await settle();

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('ipc down'), 'Error', 'error');
  });

  it('does not write permissions without a selection', async () => {
    const controller = makeController();
    controller.updateSelection(null);
    await settle();

    el('utility-apply-posix-btn').click();
    el('utility-apply-win-btn').click();
    await settle();

    expect(api.setPermissions).not.toHaveBeenCalled();
    expect(api.setAttributes).not.toHaveBeenCalled();
  });
});

describe('checksum cancellation', () => {
  it('cancels an in-flight hash when the selection changes', async () => {
    api.calculateChecksum.mockReturnValue(new Promise(() => {}));
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();
    expect(api.calculateChecksum).toHaveBeenCalledTimes(1);
    const startedId = api.calculateChecksum.mock.calls[0][1];

    controller.updateSelection('/home/user/b.txt');
    await settle();

    expect(api.cancelChecksumCalculation).toHaveBeenCalledWith(startedId);
  });

  it('cancels the previous hash before starting a new one', async () => {
    api.calculateChecksum.mockReturnValue(new Promise(() => {}));
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();
    const firstId = api.calculateChecksum.mock.calls[0][1];
    api.cancelChecksumCalculation.mockClear();

    // Distinct clock reading so the new operation id differs from the first.
    await vi.advanceTimersByTimeAsync(5);
    el('utility-calc-checksum-btn').click();
    await settle();

    expect(api.cancelChecksumCalculation).toHaveBeenCalledWith(firstId);
    expect(api.calculateChecksum).toHaveBeenCalledTimes(2);
  });

  it('ignores a hash result that has already been superseded', async () => {
    let releaseFirst!: (value: unknown) => void;
    api.calculateChecksum
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseFirst = resolve;
        })
      )
      .mockResolvedValue({ success: true, result: { sha256: 'second-hash' } });

    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    await vi.advanceTimersByTimeAsync(5);
    el('utility-calc-checksum-btn').click();
    await settle();
    expect(checksumBox().value).toBe('second-hash');

    // The abandoned first request resolving must not overwrite the newer hash.
    releaseFirst({ success: true, result: { sha256: 'stale-hash' } });
    await settle();

    expect(checksumBox().value).toBe('second-hash');
  });

  it('routes progress events only to the operation that is still running', async () => {
    api.calculateChecksum.mockReturnValue(new Promise(() => {}));
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();
    const activeId = api.calculateChecksum.mock.calls[0][1];

    progressHandler?.({ operationId: 'checksum-someone-else', percent: 12 });
    expect(checksumBox().value).toBe('Calculating...');

    progressHandler?.({ operationId: activeId, percent: 42 });
    expect(checksumBox().value).toBe('Calculating... 42%');
  });
});

describe('checksum failures', () => {
  it('shows the backend error when hashing fails', async () => {
    api.calculateChecksum.mockResolvedValue({ success: false, error: 'read error' });
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(checksumBox().value).toBe('Error: read error');
  });

  it('falls back to a generic message when hashing fails without a reason', async () => {
    api.calculateChecksum.mockResolvedValue({ success: false });
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(checksumBox().value).toBe('Error: Operation failed');
  });

  it('reports a response that omits the requested algorithm', async () => {
    api.calculateChecksum.mockResolvedValue({ success: true, result: { md5: 'only-md5' } });
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(checksumBox().value).toBe('Error: hash missing for sha256');
  });

  it('surfaces a rejected hash request', async () => {
    api.calculateChecksum.mockRejectedValue(new Error('worker died'));
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(checksumBox().value).toContain('worker died');
  });

  it('enables the copy button only once a hash is available', async () => {
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(checksumBox().value).toBe('abc123');
    expect(el<HTMLButtonElement>('utility-copy-checksum-btn').disabled).toBe(false);
  });

  it('does not hash manually without a selection', async () => {
    const controller = makeController();
    controller.updateSelection(null);
    await settle();

    el('utility-calc-checksum-btn').click();
    await settle();

    expect(api.calculateChecksum).not.toHaveBeenCalled();
  });
});

describe('auto-checksum gating', () => {
  it('skips hashing when auto-checksum is disabled', async () => {
    settings.enableAutoChecksum = false;
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(api.calculateChecksum).not.toHaveBeenCalled();
  });

  it('skips hashing while the drawer is collapsed', async () => {
    settings.utilityDrawerCollapsed = true;
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(api.calculateChecksum).not.toHaveBeenCalled();
  });

  it('skips hashing while the window is in the background', async () => {
    activity.foreground = false;
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(api.calculateChecksum).not.toHaveBeenCalled();
  });

  it('skips hashing for files at or beyond the auto-checksum size cap', async () => {
    api.getItemProperties.mockResolvedValue({
      success: true,
      properties: { size: 10 * 1024 * 1024, isDirectory: false, mode: 0o644 },
    });
    const controller = makeController();

    controller.updateSelection('/home/user/big.bin');
    await settle();

    expect(api.calculateChecksum).not.toHaveBeenCalled();
  });

  it('still allows a manual hash when auto-checksum is disabled', async () => {
    settings.enableAutoChecksum = false;
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    el('utility-calc-checksum-btn').click();
    await settle();

    expect(api.calculateChecksum).toHaveBeenCalledTimes(1);
  });
});

describe('selection state', () => {
  it('resets the panel and disables actions when the selection is cleared', async () => {
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();

    controller.updateSelection(null);
    await settle();

    expect(statusText()).toBe('No selection');
    expect(el('utility-meta-path').textContent).toBe('-');
    expect(el('utility-meta-size').textContent).toBe('-');
    expect(checksumBox().value).toBe('');
    expect(el('utility-posix-perms').style.display).toBe('none');
    expect(el('utility-win-attrs').style.display).toBe('none');
    expect(el('utility-no-perms-placeholder').style.display).toBe('flex');
    for (const id of [
      'utility-copy-path-btn',
      'utility-copy-name-btn',
      'utility-copy-uri-btn',
      'utility-calc-checksum-btn',
      'utility-copy-checksum-btn',
    ]) {
      expect(el<HTMLButtonElement>(id).disabled).toBe(true);
    }
  });

  it('cancels a running hash when the selection is cleared', async () => {
    api.calculateChecksum.mockReturnValue(new Promise(() => {}));
    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();
    const startedId = api.calculateChecksum.mock.calls[0][1];

    controller.updateSelection(null);
    await settle();

    expect(api.cancelChecksumCalculation).toHaveBeenCalledWith(startedId);
  });

  it('reports a failure to read the selected item', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getItemProperties.mockRejectedValue(new Error('stat failed'));
    const controller = makeController();

    controller.updateSelection('/home/user/a.txt');
    await settle();

    expect(statusText()).toBe('Failed to read selection details');
  });

  it('marks checksums as not applicable for a folder', async () => {
    api.getItemProperties.mockResolvedValue({
      success: true,
      properties: { size: 0, isDirectory: true, mode: 0o755 },
    });
    const controller = makeController();

    controller.updateSelection('/home/user/folder');
    await settle();

    expect(el('utility-meta-size').textContent).toBe('Folder');
    expect(checksumBox().value).toBe('Not applicable for folders');
    expect(el<HTMLButtonElement>('utility-calc-checksum-btn').disabled).toBe(true);
    expect(el<HTMLSelectElement>('utility-checksum-algo').disabled).toBe(true);
    expect(api.calculateChecksum).not.toHaveBeenCalled();
  });

  it('ignores a properties response for a selection that has moved on', async () => {
    let releaseFirst!: (value: unknown) => void;
    api.getItemProperties
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseFirst = resolve;
        })
      )
      .mockResolvedValue({
        success: true,
        properties: { size: 2048, isDirectory: false, mode: 0o600 },
      });

    const controller = makeController();
    controller.updateSelection('/home/user/first.txt');
    controller.updateSelection('/home/user/second.txt');
    await settle();
    expect(el('utility-meta-size').textContent).toBe('2 KB');

    releaseFirst({ success: true, properties: { size: 999, isDirectory: true, mode: 0o644 } });
    await settle();

    // The stale response must not relabel the panel as a folder.
    expect(el('utility-meta-size').textContent).toBe('2 KB');
  });
});

describe('storage overview widget', () => {
  const storageContent = () =>
    document.querySelector('.storage-overview-content') as HTMLElement | null;

  it('renders usage when the backend reports space', async () => {
    makeController();
    await settle();

    expect(storageContent()?.textContent).toContain('free of');
    expect(storageContent()?.querySelector('.storage-progress-fill')).not.toBeNull();
  });

  it('shows a fallback when the disk lookup is unsuccessful', async () => {
    api.getDiskSpace.mockResolvedValue({ success: false });
    makeController();
    await settle();

    expect(storageContent()?.textContent).toContain('Storage info unavailable');
  });

  it('shows a fallback when the disk lookup rejects', async () => {
    api.getDiskSpace.mockRejectedValue(new Error('no volume'));
    makeController();
    await settle();

    expect(storageContent()?.textContent).toContain('Storage info unavailable');
  });

  it('shows a fallback for a nonsensical zero-capacity volume', async () => {
    api.getDiskSpace.mockResolvedValue({ success: true, total: 0, free: 0 });
    makeController();
    await settle();

    expect(storageContent()?.textContent).toContain('Storage info unavailable');
  });

  it('ignores a disk response that a newer request has superseded', async () => {
    let releaseFirst!: (value: unknown) => void;
    api.getDiskSpace
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseFirst = resolve;
        })
      )
      .mockResolvedValue({ success: true, total: 1000, free: 400 });

    const controller = makeController();
    controller.updateSelection('/home/user/a.txt');
    await settle();
    const rendered = storageContent()?.innerHTML;

    releaseFirst({ success: false });
    await settle();

    expect(storageContent()?.innerHTML).toBe(rendered);
    expect(storageContent()?.textContent).not.toContain('Storage info unavailable');
  });
});
