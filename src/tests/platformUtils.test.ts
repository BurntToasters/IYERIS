import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { isRunningInFlatpak, checkMsiInstallation, isInstalledViaMsi } from '../platformUtils';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isRunningInFlatpak', () => {
  it('is a function', () => {
    expect(typeof isRunningInFlatpak).toBe('function');
  });

  it('returns a boolean', () => {
    const result = isRunningInFlatpak();
    expect(typeof result).toBe('boolean');
  });
});

describe('checkMsiInstallation', () => {
  it('returns false on non-win32 platforms', async () => {
    if (process.platform === 'win32') return;
    const result = await checkMsiInstallation();
    expect(result).toBe(false);
  });

  it('returns a promise', () => {
    const result = checkMsiInstallation();
    expect(result).toBeInstanceOf(Promise);
  });
});

describe('isInstalledViaMsi', () => {
  it('returns false initially on non-win32', () => {
    if (process.platform === 'win32') return;
    expect(isInstalledViaMsi()).toBe(false);
  });
});
