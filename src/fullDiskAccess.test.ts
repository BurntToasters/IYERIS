import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from './types';

const hoisted = vi.hoisted(() => ({
  appMock: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/Users/test';
      if (name === 'exe') return '/Applications/IYERIS.app/Contents/MacOS/IYERIS';
      return '/tmp';
    }),
  },
  dialogMock: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
  shellMock: {
    openExternal: vi.fn(),
  },
  fsPromisesMock: {
    open: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
  },
  mainWindowRef: { value: null as { isDestroyed: () => boolean } | null },
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

vi.mock('electron', () => ({
  app: hoisted.appMock,
  dialog: hoisted.dialogMock,
  shell: hoisted.shellMock,
}));

vi.mock('fs', () => ({
  promises: hoisted.fsPromisesMock,
}));

vi.mock('./appState', () => ({
  getMainWindow: vi.fn(() => hoisted.mainWindowRef.value),
}));

import { checkFullDiskAccess, showFullDiskAccessDialog } from './fullDiskAccess';

describe('fullDiskAccess', () => {
  beforeEach(() => {
    setPlatform(originalPlatform);
    hoisted.appMock.getPath.mockReset();
    hoisted.appMock.getPath.mockImplementation((name: string) => {
      if (name === 'home') return '/Users/test';
      if (name === 'exe') return '/Applications/IYERIS.app/Contents/MacOS/IYERIS';
      return '/tmp';
    });
    hoisted.dialogMock.showMessageBox.mockReset();
    hoisted.dialogMock.showMessageBox.mockResolvedValue({ response: 1 });
    hoisted.shellMock.openExternal.mockReset();
    hoisted.fsPromisesMock.open.mockReset();
    hoisted.fsPromisesMock.stat.mockReset();
    hoisted.fsPromisesMock.readdir.mockReset();
    hoisted.mainWindowRef.value = null;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('returns true outside macOS without probing paths', async () => {
    setPlatform('linux');

    const result = await checkFullDiskAccess();

    expect(result).toBe(true);
    expect(hoisted.fsPromisesMock.open).not.toHaveBeenCalled();
  });

  it('returns true on macOS when TCC.db can be opened', async () => {
    setPlatform('darwin');
    hoisted.fsPromisesMock.open.mockResolvedValue({
      close: vi.fn(async () => undefined),
    });

    const result = await checkFullDiskAccess();

    expect(result).toBe(true);
    expect(hoisted.fsPromisesMock.open).toHaveBeenCalled();
  });

  it('returns false on macOS when protected locations are inaccessible', async () => {
    setPlatform('darwin');
    hoisted.fsPromisesMock.open.mockRejectedValue(new Error('denied'));
    hoisted.fsPromisesMock.stat.mockRejectedValue(new Error('denied'));

    const result = await checkFullDiskAccess();

    expect(result).toBe(false);
  });

  it('does nothing when full-disk-access dialog cannot be shown', async () => {
    hoisted.mainWindowRef.value = null;

    await showFullDiskAccessDialog(
      async () => ({ skipFullDiskAccessPrompt: false }) as unknown as Settings,
      async () => ({ success: true })
    );

    expect(hoisted.dialogMock.showMessageBox).not.toHaveBeenCalled();
  });

  it('opens system settings when user chooses open settings', async () => {
    const mainWindow = { isDestroyed: () => false };
    hoisted.mainWindowRef.value = mainWindow;
    hoisted.dialogMock.showMessageBox.mockResolvedValue({ response: 0 });

    await showFullDiskAccessDialog(
      async () => ({ skipFullDiskAccessPrompt: false }) as unknown as Settings,
      async () => ({ success: true })
    );

    expect(hoisted.shellMock.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    );
  });

  it('persists skip flag when user chooses do-not-ask-again', async () => {
    const mainWindow = { isDestroyed: () => false };
    hoisted.mainWindowRef.value = mainWindow;
    hoisted.dialogMock.showMessageBox.mockResolvedValue({ response: 2 });
    const settings = { skipFullDiskAccessPrompt: false } as unknown as Settings;
    const saveSettings = vi.fn(async () => ({ success: true }));

    await showFullDiskAccessDialog(async () => settings, saveSettings);

    expect(settings.skipFullDiskAccessPrompt).toBe(true);
    expect(saveSettings).toHaveBeenCalledWith(settings);
  });
});
