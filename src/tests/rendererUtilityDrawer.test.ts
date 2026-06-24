// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUtilityDrawerController } from '../rendererUtilityDrawer';
import type { Settings } from '../types';

describe('rendererUtilityDrawer', () => {
  let settings: Settings;
  let mockTauriAPI: any;
  let showToastMock: any;
  let saveSettingsMock: any;

  function buildDOM(): void {
    // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
    document.body.innerHTML = `
      <div id="utility-drawer">
        <div id="utility-drawer-header">
          <button id="utility-drawer-toggle-btn" aria-expanded="false">Toggle</button>
          <div id="utility-drawer-status">No selection</div>
        </div>
        <div id="utility-drawer-body">
          <span id="utility-meta-path">-</span>
          <span id="utility-meta-size">-</span>
          
          <button id="utility-copy-path-btn">Copy Path</button>
          <button id="utility-copy-name-btn">Copy Name</button>
          <button id="utility-copy-uri-btn">Copy URI</button>
          
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
          
          <select id="utility-checksum-algo">
            <option value="sha256">SHA-256</option>
            <option value="md5">MD5</option>
          </select>
          <button id="utility-calc-checksum-btn">Calculate</button>
          <textarea id="utility-checksum-value"></textarea>
          <button id="utility-copy-checksum-btn">Copy</button>
        </div>
      </div>
    `;
  }

  beforeEach(() => {
    buildDOM();
    settings = {
      utilityDrawerCollapsed: false,
      enableAutoChecksum: true,
      defaultChecksumAlgorithm: 'sha256',
    } as any;

    showToastMock = vi.fn();
    saveSettingsMock = vi.fn().mockResolvedValue(true);

    mockTauriAPI = {
      getPlatform: vi.fn().mockResolvedValue('darwin'),
      writeToSystemClipboard: vi.fn().mockResolvedValue(true),
      getItemProperties: vi.fn().mockResolvedValue({
        success: true,
        properties: {
          size: 1024,
          isDirectory: false,
          mode: 0o755,
        },
      }),
      setPermissions: vi.fn().mockResolvedValue({ success: true }),
      setAttributes: vi.fn().mockResolvedValue({ success: true }),
      calculateChecksum: vi.fn(
        () =>
          new Promise((resolve) => {
            (window as any)._resolveChecksumPromise = resolve;
          })
      ),
      cancelChecksumCalculation: vi.fn().mockResolvedValue(true),
      onChecksumProgress: vi.fn((callback) => {
        (window as any)._triggerChecksumProgress = callback;
        return () => {};
      }),
    };

    (window as any).tauriAPI = mockTauriAPI;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as any).tauriAPI;
    delete (window as any)._triggerChecksumProgress;
  });

  it('initializes layout and state from settings', async () => {
    settings.utilityDrawerCollapsed = true;
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();

    expect(mockTauriAPI.getPlatform).toHaveBeenCalled();
    const drawer = document.getElementById('utility-drawer');
    expect(drawer?.classList.contains('collapsed')).toBe(true);
  });

  it('toggles collapse/expand state when header is clicked', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();

    const header = document.getElementById('utility-drawer-header');
    header?.click();

    expect(settings.utilityDrawerCollapsed).toBe(true);
    expect(saveSettingsMock).toHaveBeenCalledWith(settings);
  });

  it('updates selection to null (no selection)', () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection(null);

    expect(document.getElementById('utility-drawer-status')?.textContent).toBe('No selection');
    expect(document.getElementById('utility-meta-path')?.textContent).toBe('-');
    expect(document.getElementById('utility-no-perms-placeholder')?.style.display).not.toBe('none');
  });

  it('updates selection to a POSIX path and renders fields', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');

    // Wait for the async tauriAPI mock to resolve properties
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(document.getElementById('utility-drawer-status')?.textContent).toBe(
      'Selected: file.txt'
    );
    expect(document.getElementById('utility-meta-path')?.textContent).toBe('/path/to/file.txt');
    expect(document.getElementById('utility-meta-size')?.textContent).toBe('1 KB');

    // POSIX Wrapper should be visible, Windows hidden
    expect(document.getElementById('utility-posix-perms')?.style.display).toBe('flex');
    expect(document.getElementById('utility-win-attrs')?.style.display).toBe('none');

    // Check octal mode translation (0o755 => "755")
    const octal = document.getElementById('posix-octal-input') as HTMLInputElement;
    expect(octal.value).toBe('755');
  });

  it('renders Windows attributes on Windows', async () => {
    mockTauriAPI.getPlatform.mockResolvedValue('win32');
    mockTauriAPI.getItemProperties.mockResolvedValue({
      success: true,
      properties: {
        size: 2048,
        isDirectory: false,
        isReadOnly: true,
        isHiddenAttr: false,
        isSystemAttr: true,
      },
    });

    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    // Re-trigger platform detection mock load
    await new Promise((resolve) => setTimeout(resolve, 10));

    ctrl.updateSelection('C:\\path\\to\\file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Windows attributes panel visible
    expect(document.getElementById('utility-posix-perms')?.style.display).toBe('none');
    expect(document.getElementById('utility-win-attrs')?.style.display).toBe('flex');

    const readonlyBox = document.getElementById('attr-readonly') as HTMLInputElement;
    const systemBox = document.getElementById('attr-system') as HTMLInputElement;
    const hiddenBox = document.getElementById('attr-hidden') as HTMLInputElement;

    expect(readonlyBox.checked).toBe(true);
    expect(systemBox.checked).toBe(true);
    expect(hiddenBox.checked).toBe(false);
  });

  it('renders Windows attributes before platform detection resolves when path is Windows-shaped', async () => {
    mockTauriAPI.getPlatform.mockReturnValue(new Promise(() => {}));
    mockTauriAPI.getItemProperties.mockResolvedValue({
      success: true,
      properties: {
        size: 2048,
        isDirectory: false,
        isReadOnly: true,
        isHiddenAttr: true,
        isSystemAttr: false,
      },
    });

    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('C:\\path\\to\\file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(document.getElementById('utility-posix-perms')?.style.display).toBe('none');
    expect(document.getElementById('utility-win-attrs')?.style.display).toBe('flex');
  });

  it('syncs checkboxes when octal input changes', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const octal = document.getElementById('posix-octal-input') as HTMLInputElement;
    octal.value = '644';
    octal.dispatchEvent(new Event('input'));

    const ur = document.getElementById('perm-ur') as HTMLInputElement;
    const uw = document.getElementById('perm-uw') as HTMLInputElement;
    const ux = document.getElementById('perm-ux') as HTMLInputElement;
    const gr = document.getElementById('perm-gr') as HTMLInputElement;
    const gw = document.getElementById('perm-gw') as HTMLInputElement;
    const gx = document.getElementById('perm-gx') as HTMLInputElement;

    expect(ur.checked).toBe(true);
    expect(uw.checked).toBe(true);
    expect(ux.checked).toBe(false); // 6
    expect(gr.checked).toBe(true);
    expect(gw.checked).toBe(false);
    expect(gx.checked).toBe(false); // 4
  });

  it('applies POSIX permissions change successfully', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const applyBtn = document.getElementById('utility-apply-posix-btn');
    applyBtn?.click();

    expect(mockTauriAPI.setPermissions).toHaveBeenCalledWith('/path/to/file.txt', 0o755);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(showToastMock).toHaveBeenCalledWith(
      'POSIX permissions updated successfully',
      'Success',
      'success'
    );
  });

  it('applies Windows attributes change successfully', async () => {
    mockTauriAPI.getPlatform.mockResolvedValue('win32');
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    await new Promise((resolve) => setTimeout(resolve, 10));

    ctrl.updateSelection('C:\\path\\to\\file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const readonlyBox = document.getElementById('attr-readonly') as HTMLInputElement;
    readonlyBox.checked = true;

    const applyBtn = document.getElementById('utility-apply-win-btn');
    applyBtn?.click();

    expect(mockTauriAPI.setAttributes).toHaveBeenCalledWith('C:\\path\\to\\file.txt', {
      readOnly: true,
      hidden: false,
      system: false,
    });
  });

  it('copies path to clipboard', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    document.getElementById('utility-copy-path-btn')?.click();
    expect(mockTauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('/path/to/file.txt');
  });

  it('copies filename to clipboard', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    document.getElementById('utility-copy-name-btn')?.click();
    expect(mockTauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('file.txt');
  });

  it('copies file URI to clipboard', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    document.getElementById('utility-copy-uri-btn')?.click();
    expect(mockTauriAPI.writeToSystemClipboard).toHaveBeenCalledWith('file:///path/to/file.txt');
  });

  it('copies Windows file URI with encoded characters', async () => {
    mockTauriAPI.getPlatform.mockResolvedValue('win32');
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('C:\\Users\\test user\\file name.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    document.getElementById('utility-copy-uri-btn')?.click();
    expect(mockTauriAPI.writeToSystemClipboard).toHaveBeenCalledWith(
      'file:///C:/Users/test%20user/file%20name.txt'
    );
  });

  it('ignores stale selection responses', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    let resolveSecond: ((value: unknown) => void) | null = null;
    mockTauriAPI.getItemProperties = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/first.txt');
    ctrl.updateSelection('/path/to/second.txt');

    resolveSecond?.({
      success: true,
      properties: {
        size: 2048,
        isDirectory: false,
        mode: 0o644,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    resolveFirst?.({
      success: true,
      properties: {
        size: 1024,
        isDirectory: false,
        mode: 0o755,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(document.getElementById('utility-drawer-status')?.textContent).toBe(
      'Selected: second.txt'
    );
    expect(document.getElementById('utility-meta-path')?.textContent).toBe('/path/to/second.txt');
    expect(document.getElementById('utility-meta-size')?.textContent).toBe('2 KB');
    expect(mockTauriAPI.calculateChecksum).toHaveBeenCalledTimes(1);
    expect(mockTauriAPI.calculateChecksum).toHaveBeenCalledWith(
      '/path/to/second.txt',
      expect.any(String),
      ['sha256']
    );
  });

  it('calculates checksum auto/manual and listens to progress', async () => {
    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/file.txt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Auto-calculate is triggered on selection because file < 50MB and auto settings is enabled
    expect(mockTauriAPI.calculateChecksum).toHaveBeenCalled();

    // Mock progress event triggering
    const trigger = (window as any)._triggerChecksumProgress;
    expect(trigger).toBeDefined();

    const checksumId = mockTauriAPI.calculateChecksum.mock.calls[0][1];

    // Simulate 50% progress
    trigger({ operationId: checksumId, percent: 50 });
    const txtArea = document.getElementById('utility-checksum-value') as HTMLTextAreaElement;
    expect(txtArea.value).toBe('Calculating... 50%');

    // Resolve the checksum call
    (window as any)._resolveChecksumPromise({
      success: true,
      result: { sha256: 'abc123hash' },
    });

    // Wait for the checksum call to resolve completely
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(txtArea.value).toBe('abc123hash');
  });

  it('does not auto-calculate checksum for large files when algorithm changes', async () => {
    mockTauriAPI.getItemProperties.mockResolvedValue({
      success: true,
      properties: {
        size: 60 * 1024 * 1024,
        isDirectory: false,
        mode: 0o755,
      },
    });

    const ctrl = createUtilityDrawerController({
      getCurrentSettings: () => settings,
      saveSettingsWithTimestamp: saveSettingsMock,
      showToast: showToastMock,
    });

    ctrl.init();
    ctrl.updateSelection('/path/to/big-file.iso');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockTauriAPI.calculateChecksum).not.toHaveBeenCalled();

    const algoSelect = document.getElementById('utility-checksum-algo') as HTMLSelectElement;
    algoSelect.value = 'md5';
    algoSelect.dispatchEvent(new Event('change'));

    expect(mockTauriAPI.calculateChecksum).not.toHaveBeenCalled();
  });
});
