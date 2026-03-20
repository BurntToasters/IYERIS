import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  appGetVersion: vi.fn(() => '1.0.5'),
  getMainWindow: vi.fn(),
  getIsDev: vi.fn(() => false),
  safeSendToWindow: vi.fn(),
  isTrustedIpcEvent: vi.fn(() => true),
  isRunningInFlatpak: vi.fn(() => false),
  checkMsiInstallation: vi.fn(() => Promise.resolve(false)),
  isInstalledViaMsi: vi.fn(() => false),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcMainHandle },
  app: {
    getVersion: mocks.appGetVersion,
  },
}));

vi.mock('../main/appState', () => ({
  getMainWindow: mocks.getMainWindow,
  getIsDev: mocks.getIsDev,
}));

vi.mock('../main/platformUtils', () => ({
  isRunningInFlatpak: mocks.isRunningInFlatpak,
  checkMsiInstallation: mocks.checkMsiInstallation,
  isInstalledViaMsi: mocks.isInstalledViaMsi,
}));

vi.mock('../main/ipcUtils', () => ({
  safeSendToWindow: mocks.safeSendToWindow,
  isTrustedIpcEvent: mocks.isTrustedIpcEvent,
}));

vi.mock('../main/security', () => ({
  getErrorMessage: mocks.getErrorMessage,
}));

import { compareVersions, setupUpdateHandlers, initializeAutoUpdater } from '../main/updateManager';

type HandlerMap = Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;

function mockGithubLatestRelease(tagName: string, htmlUrl?: string) {
  const payload = {
    tag_name: tagName,
    html_url: htmlUrl ?? `https://github.com/BurntToasters/IYERIS/releases/tag/${tagName}`,
    body: 'release notes',
    published_at: '2026-03-20T00:00:00.000Z',
  };

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('compareVersions extended', () => {
  it('handles v prefix and equality', () => {
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
  });

  it('treats prerelease as lower precedence than stable', () => {
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(-1);
  });

  it('orders patch/minor/major correctly', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });
});

describe('setupUpdateHandlers', () => {
  let handlers: HandlerMap;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};

    mocks.ipcMainHandle.mockImplementation(
      (channel: string, handler: (...args: unknown[]) => Promise<Record<string, unknown>>) => {
        handlers[channel] = handler;
      }
    );

    setupUpdateHandlers(() => Promise.resolve({ updateChannel: 'auto' } as any));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (process as any).mas = false;
    (process as any).windowsStore = false;
  });

  it('registers all update IPC handlers', () => {
    expect(handlers['check-for-updates']).toBeDefined();
    expect(handlers['download-update']).toBeDefined();
    expect(handlers['install-update']).toBeDefined();
  });

  it('rejects untrusted check-for-updates sender', async () => {
    mocks.isTrustedIpcEvent.mockReturnValueOnce(false);
    const result = await handlers['check-for-updates']({ sender: { id: 1 } } as any);
    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
  });

  it('returns store-managed response for Flatpak installs', async () => {
    mocks.isRunningInFlatpak.mockReturnValueOnce(true);
    const result = await handlers['check-for-updates']({ sender: { id: 1 } } as any);
    expect(result.success).toBe(true);
    expect(result.hasUpdate).toBe(false);
    expect(result.isFlatpak).toBe(true);
  });

  it('returns manual-install update info when newer release tag exists', async () => {
    const fetchMock = mockGithubLatestRelease('v2.0.0');
    const result = await handlers['check-for-updates']({ sender: { id: 1 } } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.hasUpdate).toBe(true);
    expect(result.currentVersion).toBe('v1.0.5');
    expect(result.latestVersion).toBe('v2.0.0');
    expect(result.requiresManualInstall).toBe(true);
    expect(result.releaseUrl).toContain('/releases/tag/v2.0.0');
    expect(String(result.manualUpdateMessage)).toContain('manually download and install');
  });

  it('returns no update when latest release matches current version', async () => {
    mockGithubLatestRelease('v1.0.5');
    const result = await handlers['check-for-updates']({ sender: { id: 1 } } as any);

    expect(result.success).toBe(true);
    expect(result.hasUpdate).toBe(false);
    expect(result.requiresManualInstall).toBe(false);
  });

  it('returns an error when GitHub latest release lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })
    );

    const result = await handlers['check-for-updates']({ sender: { id: 1 } } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('503');
  });

  it('download-update returns manual install required message', async () => {
    const result = await handlers['download-update']({ sender: { id: 1 } } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('manually download and install');
  });

  it('install-update returns manual install required message', async () => {
    const result = await handlers['install-update']({ sender: { id: 1 } } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('manually download and install');
  });
});

describe('initializeAutoUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    (process as any).mas = false;
    (process as any).windowsStore = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (process as any).mas = false;
    (process as any).windowsStore = false;
  });

  it('emits update-available on startup when a newer release exists', async () => {
    mockGithubLatestRelease('v2.0.0');
    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mocks.safeSendToWindow).toHaveBeenCalledWith(
      mocks.getMainWindow(),
      'update-available',
      expect.objectContaining({ version: '2.0.0' })
    );
  });

  it('emits update-not-available on startup when up to date', async () => {
    mockGithubLatestRelease('v1.0.5');
    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mocks.safeSendToWindow).toHaveBeenCalledWith(
      mocks.getMainWindow(),
      'update-not-available',
      { version: '1.0.5' }
    );
  });

  it('skips startup check when autoCheckUpdates is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await initializeAutoUpdater({ autoCheckUpdates: false } as any);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.safeSendToWindow).not.toHaveBeenCalled();
  });

  it('skips startup check for Flatpak installs', async () => {
    mocks.isRunningInFlatpak.mockReturnValueOnce(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await initializeAutoUpdater({ autoCheckUpdates: true } as any);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.safeSendToWindow).not.toHaveBeenCalled();
  });

  it('emits update-error if GitHub check throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
    await initializeAutoUpdater({ autoCheckUpdates: true } as any);

    expect(mocks.safeSendToWindow).toHaveBeenCalledWith(
      mocks.getMainWindow(),
      'update-error',
      'Network down'
    );
  });
});
