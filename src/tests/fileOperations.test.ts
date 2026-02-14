import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isFileHiddenCached } from '../main/fileOperations';

vi.mock('child_process');
vi.mock('util');

describe('isFileHiddenCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for files starting with dot', async () => {
    const result = await isFileHiddenCached('/path/to/.hidden', '.hidden');
    expect(result).toBe(true);
  });

  it('returns true for .gitignore', async () => {
    const result = await isFileHiddenCached('/path/to/.gitignore', '.gitignore');
    expect(result).toBe(true);
  });

  it('returns false for files not starting with dot on non-Windows', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    });

    const result = await isFileHiddenCached('/path/to/visible.txt', 'visible.txt');
    expect(result).toBe(false);

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  it('handles regular files correctly', async () => {
    const result = await isFileHiddenCached('/path/to/file.txt', 'file.txt');
    expect(result).toBe(false);
  });
});
