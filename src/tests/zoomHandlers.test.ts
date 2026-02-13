import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  browserWindowMock: {
    fromWebContents: vi.fn(),
  },
  trusted: { value: true },
}));
const handlers = hoisted.handlers;
const browserWindowMock = hoisted.browserWindowMock;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      hoisted.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: hoisted.browserWindowMock,
}));

vi.mock('../main/appState', () => ({
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 2,
}));

vi.mock('../main/security', () => ({
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('../main/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => hoisted.trusted.value),
}));

import { setupZoomHandlers } from '../main/zoomHandlers';

describe('setupZoomHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    hoisted.trusted.value = true;
    browserWindowMock.fromWebContents.mockReset();
    setupZoomHandlers();
  });

  it('rejects untrusted set-zoom-level events', async () => {
    hoisted.trusted.value = false;
    const handler = handlers.get('set-zoom-level');
    if (!handler) throw new Error('set-zoom-level handler missing');

    const result = (await handler({ sender: {} } as unknown, 1.2)) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
  });

  it('clamps zoom level to max and min bounds', async () => {
    const setZoomFactor = vi.fn();
    browserWindowMock.fromWebContents.mockReturnValue({
      isDestroyed: () => false,
      webContents: { setZoomFactor, getZoomFactor: vi.fn(() => 1) },
    });
    const handler = handlers.get('set-zoom-level');
    if (!handler) throw new Error('set-zoom-level handler missing');

    await handler({ sender: {} } as unknown, 9);
    await handler({ sender: {} } as unknown, 0.1);

    expect(setZoomFactor).toHaveBeenNthCalledWith(1, 2);
    expect(setZoomFactor).toHaveBeenNthCalledWith(2, 0.5);
  });

  it('returns window unavailable when webContents has no window', async () => {
    browserWindowMock.fromWebContents.mockReturnValue(null);
    const handler = handlers.get('get-zoom-level');
    if (!handler) throw new Error('get-zoom-level handler missing');

    const result = (await handler({ sender: {} } as unknown)) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Window not available' });
  });

  it('returns zoom level for active window', async () => {
    browserWindowMock.fromWebContents.mockReturnValue({
      isDestroyed: () => false,
      webContents: { getZoomFactor: vi.fn(() => 1.75), setZoomFactor: vi.fn() },
    });
    const handler = handlers.get('get-zoom-level');
    if (!handler) throw new Error('get-zoom-level handler missing');

    const result = (await handler({ sender: {} } as unknown)) as {
      success: boolean;
      zoomLevel?: number;
    };

    expect(result).toEqual({ success: true, zoomLevel: 1.75 });
  });

  it('returns error when setZoomFactor throws', async () => {
    browserWindowMock.fromWebContents.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        setZoomFactor: vi.fn(() => {
          throw new Error('zoom fail');
        }),
        getZoomFactor: vi.fn(() => 1),
      },
    });
    const handler = handlers.get('set-zoom-level');
    if (!handler) throw new Error('set-zoom-level handler missing');

    const result = (await handler({ sender: {} } as unknown, 1.2)) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'zoom fail' });
  });
});
