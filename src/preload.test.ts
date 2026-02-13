import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

describe('preload bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('exposes electronAPI on the main world', async () => {
    const electron = await import('electron');
    await import('./preload');

    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'electronAPI',
      expect.any(Object)
    );
  });

  it('forwards invoke and sync channels correctly', async () => {
    const electron = await import('electron');
    await import('./preload');

    const exposedApi = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls[0][1] as {
      getDirectoryContents: (...args: unknown[]) => unknown;
      saveSettingsSync: (...args: unknown[]) => unknown;
    };

    exposedApi.getDirectoryContents('/tmp', 'op-1', true, false);
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'get-directory-contents',
      '/tmp',
      'op-1',
      true,
      false
    );

    exposedApi.saveSettingsSync({ theme: 'dark' });
    expect(electron.ipcRenderer.sendSync).toHaveBeenCalledWith('save-settings-sync', {
      theme: 'dark',
    });
  });

  it('registers and unregisters event listeners via onClipboardChanged', async () => {
    const electron = await import('electron');
    await import('./preload');

    const exposedApi = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls[0][1] as {
      onClipboardChanged: (
        callback: (value: { operation: 'copy' | 'cut'; paths: string[] } | null) => void
      ) => () => void;
    };
    const callback = vi.fn();
    const unsubscribe = exposedApi.onClipboardChanged(callback);

    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('clipboard-changed', expect.any(Function));

    const handler = vi.mocked(electron.ipcRenderer.on).mock.calls[0][1] as (
      event: unknown,
      data: { operation: 'copy' | 'cut'; paths: string[] } | null
    ) => void;
    handler({}, { operation: 'copy', paths: ['/a'] });

    expect(callback).toHaveBeenCalledWith({ operation: 'copy', paths: ['/a'] });

    unsubscribe();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('clipboard-changed', handler);
  });
});
