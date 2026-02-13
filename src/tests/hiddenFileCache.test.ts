import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../appState', () => ({
  HIDDEN_FILE_CACHE_TTL: 300000,
  HIDDEN_FILE_CACHE_MAX: 5000,
}));

import {
  isFileHiddenCached,
  startHiddenFileCacheCleanup,
  stopHiddenFileCacheCleanup,
} from '../hiddenFileCache';

beforeEach(() => {
  vi.clearAllMocks();
  stopHiddenFileCacheCleanup();
});

afterEach(() => {
  stopHiddenFileCacheCleanup();
});

describe('isFileHiddenCached', () => {
  it('returns true for dotfiles on any platform', async () => {
    const result = await isFileHiddenCached('/home/user/.bashrc', '.bashrc');
    expect(result).toBe(true);
  });

  it('returns true for .gitignore', async () => {
    expect(await isFileHiddenCached('/repo/.gitignore', '.gitignore')).toBe(true);
  });

  it('returns false for non-dotfiles on non-win32', async () => {
    const originalPlatform = process.platform;
    if (originalPlatform === 'win32') return;
    const result = await isFileHiddenCached('/home/user/file.txt', 'file.txt');
    expect(result).toBe(false);
  });

  it('returns false for regular files on Linux/Mac', async () => {
    if (process.platform === 'win32') return;
    const result = await isFileHiddenCached('/tmp/normal.txt', 'normal.txt');
    expect(result).toBe(false);
  });

  it('handles empty filename gracefully', async () => {
    if (process.platform === 'win32') return;
    const result = await isFileHiddenCached('/tmp/', '');
    expect(result).toBe(false);
  });
});

describe('startHiddenFileCacheCleanup / stopHiddenFileCacheCleanup', () => {
  it('starts and stops cleanup interval without error', () => {
    expect(() => startHiddenFileCacheCleanup()).not.toThrow();
    expect(() => stopHiddenFileCacheCleanup()).not.toThrow();
  });

  it('can be called multiple times without error', () => {
    startHiddenFileCacheCleanup();
    startHiddenFileCacheCleanup();
    stopHiddenFileCacheCleanup();
    stopHiddenFileCacheCleanup();
  });
});
