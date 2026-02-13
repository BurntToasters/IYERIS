import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

const fileTasks = {
  runTask: vi.fn(),
  cancelOperation: vi.fn(),
};

let trustedEvent = true;
let safePath = true;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../appState', () => ({
  getFileTasks: vi.fn(() => fileTasks),
}));

vi.mock('../security', () => ({
  isPathSafe: vi.fn(() => safePath),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('../ipcUtils', () => ({
  isTrustedIpcEvent: vi.fn(() => trustedEvent),
}));

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import {
  cleanupFileAnalysis,
  getActiveChecksumCalculations,
  getActiveFolderSizeCalculations,
  setupFileAnalysisHandlers,
} from '../fileAnalysis';

function getHandler(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler;
}

describe('fileAnalysis handlers', () => {
  beforeEach(() => {
    handlers.clear();
    trustedEvent = true;
    safePath = true;
    fileTasks.runTask.mockReset();
    fileTasks.cancelOperation.mockReset();
    getActiveFolderSizeCalculations().clear();
    getActiveChecksumCalculations().clear();
    setupFileAnalysisHandlers();
  });

  it('runs folder size calculation and returns result', async () => {
    const expected = { totalSize: 42, fileCount: 2, folderCount: 1 };
    fileTasks.runTask.mockResolvedValue(expected);
    const handler = getHandler('calculate-folder-size');

    const result = (await handler({} as unknown, '/tmp/folder', 'op-folder')) as {
      success: boolean;
      result?: unknown;
    };

    expect(fileTasks.runTask).toHaveBeenCalledWith(
      'folder-size',
      { folderPath: '/tmp/folder', operationId: 'op-folder' },
      'op-folder'
    );
    expect(result).toEqual({ success: true, result: expected });
    expect(getActiveFolderSizeCalculations().has('op-folder')).toBe(false);
  });

  it('rejects invalid folder paths', async () => {
    safePath = false;
    const handler = getHandler('calculate-folder-size');

    const result = (await handler({} as unknown, '/bad/path', 'op-folder')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Invalid foldersize path' });
    expect(fileTasks.runTask).not.toHaveBeenCalled();
  });

  it('returns cancellation error when task is cancelled', async () => {
    fileTasks.runTask.mockRejectedValue(new Error('Calculation cancelled'));
    const handler = getHandler('calculate-checksum');

    const result = (await handler({} as unknown, '/tmp/file.txt', 'op-checksum', ['sha256'])) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Calculation cancelled' });
    expect(getActiveChecksumCalculations().has('op-checksum')).toBe(false);
  });

  it('cancels active folder-size operation', async () => {
    getActiveFolderSizeCalculations().set('op-cancel', { aborted: false });
    const cancelHandler = getHandler('cancel-folder-size-calculation');

    const result = (await cancelHandler({} as unknown, 'op-cancel')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: true });
    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('op-cancel');
    expect(getActiveFolderSizeCalculations().has('op-cancel')).toBe(false);
  });

  it('returns not found for unknown cancellation id', async () => {
    const cancelHandler = getHandler('cancel-checksum-calculation');

    const result = (await cancelHandler({} as unknown, 'unknown')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Operation not found' });
  });

  it('rejects untrusted cancel requests', async () => {
    trustedEvent = false;
    const cancelHandler = getHandler('cancel-folder-size-calculation');

    const result = (await cancelHandler({} as unknown, 'op-cancel')) as {
      success: boolean;
      error?: string;
    };

    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
  });

  it('cleanup aborts all active operations and clears maps', () => {
    getActiveFolderSizeCalculations().set('folder-op', { aborted: false });
    getActiveChecksumCalculations().set('checksum-op', { aborted: false });

    cleanupFileAnalysis();

    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('folder-op');
    expect(fileTasks.cancelOperation).toHaveBeenCalledWith('checksum-op');
    expect(getActiveFolderSizeCalculations().size).toBe(0);
    expect(getActiveChecksumCalculations().size).toBe(0);
  });
});
