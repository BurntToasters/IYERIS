import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../main/ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => true),
}));

vi.mock('../main/security', () => ({
  isPathSafe: vi.fn(() => true),
}));

vi.mock('../main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

import { ipcMain } from 'electron';
import { isTrustedIpcEvent } from '../main/ipcUtils';
import { isPathSafe } from '../main/security';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;
let handlers: Record<string, HandlerFn>;

beforeEach(() => {
  vi.clearAllMocks();
  handlers = {};
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: HandlerFn) => {
    handlers[channel] = handler;
  }) as typeof ipcMain.handle);
});

function makeMockEvent(senderId = 1, destroyed = false) {
  const onHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    sender: {
      id: senderId,
      isDestroyed: () => destroyed,
      send: vi.fn(),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!onHandlers[event]) onHandlers[event] = [];
        onHandlers[event].push(cb);
      }),
      _onHandlers: onHandlers,
    },
  };
}

async function loadModule() {
  const mod = await import('../main/fileWatcher');
  mod.setupFileWatcherHandlers();
  return mod;
}

describe('fileWatcher', () => {
  describe('setupFileWatcherHandlers', () => {
    it('registers watch-directory and unwatch-directory handlers', async () => {
      await loadModule();
      expect(ipcMain.handle).toHaveBeenCalledWith('watch-directory', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('unwatch-directory', expect.any(Function));
    });
  });

  describe('watch-directory', () => {
    it('returns false for untrusted IPC events', async () => {
      await loadModule();
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const event = makeMockEvent();
      const result = handlers['watch-directory'](event, '/some/path');
      expect(result).toBe(false);
    });

    it('returns false for unsafe paths', async () => {
      await loadModule();
      vi.mocked(isTrustedIpcEvent).mockReturnValue(true);
      vi.mocked(isPathSafe).mockReturnValue(false);
      const event = makeMockEvent();
      const result = handlers['watch-directory'](event, '/unsafe/path');
      expect(result).toBe(false);
    });

    it('returns false if sender is already destroyed', async () => {
      await loadModule();
      vi.mocked(isTrustedIpcEvent).mockReturnValue(true);
      vi.mocked(isPathSafe).mockReturnValue(true);
      const event = makeMockEvent(1, true);
      const result = handlers['watch-directory'](event, '/some/path');
      expect(result).toBe(false);
    });
  });

  describe('unwatch-directory', () => {
    it('does not throw for untrusted events', async () => {
      await loadModule();
      vi.mocked(isTrustedIpcEvent).mockReturnValue(false);
      const event = makeMockEvent();
      expect(() => handlers['unwatch-directory'](event)).not.toThrow();
    });
  });

  describe('cleanupAllWatchers', () => {
    it('can be called without error when no watchers exist', async () => {
      const mod = await loadModule();
      expect(() => mod.cleanupAllWatchers()).not.toThrow();
    });
  });
});
