import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  ipcMainHandleMock: vi.fn(),
  getMainWindowMock: vi.fn(),
  isPathSafeMock: vi.fn(() => true),
  getErrorMessageMock: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  isTrustedIpcEventMock: vi.fn(() => true),
  get7zipModuleMock: vi.fn(),
  get7zipPathMock: vi.fn(() => '/usr/bin/7z'),
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: hoisted.ipcMainHandleMock },
}));

vi.mock('../appState', () => ({
  getMainWindow: hoisted.getMainWindowMock,
}));

vi.mock('../security', () => ({
  isPathSafe: hoisted.isPathSafeMock,
  getErrorMessage: hoisted.getErrorMessageMock,
}));

vi.mock('../shared', () => ({
  ignoreError: () => {},
}));

vi.mock('../platformUtils', () => ({
  get7zipModule: hoisted.get7zipModuleMock,
  get7zipPath: hoisted.get7zipPathMock,
}));

vi.mock('../utils/logger', () => ({
  logger: hoisted.loggerMock,
}));

vi.mock('../ipcUtils', () => ({
  isTrustedIpcEvent: hoisted.isTrustedIpcEventMock,
}));

import { setupArchiveHandlers, cleanupArchiveOperations } from '../archiveManager';

describe('setupArchiveHandlers', () => {
  const handlers = new Map<string, (...args: any[]) => any>();

  beforeEach(() => {
    handlers.clear();
    hoisted.ipcMainHandleMock.mockReset();
    hoisted.ipcMainHandleMock.mockImplementation(
      (channel: string, handler: (...args: any[]) => any) => {
        handlers.set(channel, handler);
      }
    );
    hoisted.isPathSafeMock.mockImplementation(
      ((p: string) => !p.includes('\0') && !p.includes('..')) as any
    );
    hoisted.isTrustedIpcEventMock.mockReturnValue(true);

    setupArchiveHandlers();
  });

  it('registers 4 IPC handlers', () => {
    expect(handlers.has('compress-files')).toBe(true);
    expect(handlers.has('extract-archive')).toBe(true);
    expect(handlers.has('cancel-archive-operation')).toBe(true);
    expect(handlers.has('list-archive-contents')).toBe(true);
  });

  describe('compress-files', () => {
    it('rejects untrusted event', async () => {
      hoisted.isTrustedIpcEventMock.mockReturnValue(false);
      const handler = handlers.get('compress-files')!;
      const result = await handler({}, ['/src'], '/dst/out.zip', 'zip');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('rejects unsafe output path', async () => {
      hoisted.isPathSafeMock.mockReturnValueOnce(false);
      const handler = handlers.get('compress-files')!;
      const result = await handler({}, ['/src'], '/bad\0path', 'zip');
      expect(result).toEqual({ success: false, error: 'Invalid output path' });
    });

    it('rejects unsafe source path', async () => {
      hoisted.isPathSafeMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const handler = handlers.get('compress-files')!;
      const result = await handler({}, ['/bad\0src'], '/dst/out.zip', 'zip');
      expect(result).toEqual({ success: false, error: 'Invalid source path' });
    });

    it('rejects invalid format', async () => {
      const handler = handlers.get('compress-files')!;
      const result = await handler({}, ['/src'], '/dst/out.exe', 'exe');
      expect(result).toEqual({ success: false, error: 'Invalid archive format' });
    });

    it('rejects tar.gz with wrong extension', async () => {
      const handler = handlers.get('compress-files')!;
      const result = await handler({}, ['/src'], '/dst/out.txt', 'tar.gz');
      expect(result).toEqual({ success: false, error: 'Output file must end with .tar.gz' });
    });
  });

  describe('extract-archive', () => {
    it('rejects untrusted event', async () => {
      hoisted.isTrustedIpcEventMock.mockReturnValue(false);
      const handler = handlers.get('extract-archive')!;
      const result = await handler({}, '/src/archive.zip', '/dst');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('rejects unsafe archive path', async () => {
      hoisted.isPathSafeMock.mockReturnValueOnce(false);
      const handler = handlers.get('extract-archive')!;
      const result = await handler({}, '/bad\0path', '/dst');
      expect(result).toEqual({ success: false, error: 'Invalid archive path' });
    });

    it('rejects unsafe destination path', async () => {
      hoisted.isPathSafeMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const handler = handlers.get('extract-archive')!;
      const result = await handler({}, '/archive.zip', '/bad\0dst');
      expect(result).toEqual({ success: false, error: 'Invalid destination path' });
    });
  });

  describe('cancel-archive-operation', () => {
    it('rejects untrusted event', async () => {
      hoisted.isTrustedIpcEventMock.mockReturnValue(false);
      const handler = handlers.get('cancel-archive-operation')!;
      const result = await handler({}, 'op-1');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('returns error when operation not found', async () => {
      const handler = handlers.get('cancel-archive-operation')!;
      const result = await handler({}, 'nonexistent-op');
      expect(result).toEqual({ success: false, error: 'Operation not found' });
    });
  });

  describe('list-archive-contents', () => {
    it('rejects untrusted event', async () => {
      hoisted.isTrustedIpcEventMock.mockReturnValue(false);
      const handler = handlers.get('list-archive-contents')!;
      const result = await handler({}, '/archive.zip');
      expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    });

    it('rejects unsafe archive path', async () => {
      hoisted.isPathSafeMock.mockReturnValueOnce(false);
      const handler = handlers.get('list-archive-contents')!;
      const result = await handler({}, '/bad\0archive');
      expect(result).toEqual({ success: false, error: 'Invalid archive path' });
    });
  });
});

describe('cleanupArchiveOperations', () => {
  it('does not throw when no active operations', () => {
    expect(() => cleanupArchiveOperations()).not.toThrow();
  });
});
