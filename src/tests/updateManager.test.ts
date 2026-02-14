import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: vi.fn() },
}));

vi.mock('../main/appState', () => ({
  getMainWindow: () => null,
  getIsDev: () => false,
  setIsQuitting: vi.fn(),
}));

vi.mock('../main/platformUtils', () => ({
  getAutoUpdater: vi.fn(),
  isRunningInFlatpak: vi.fn(),
  checkMsiInstallation: vi.fn(),
  isInstalledViaMsi: vi.fn(),
}));

vi.mock('../main/ipcUtils', () => ({
  safeSendToWindow: vi.fn(),
}));

import { compareVersions } from '../main/updateManager';

describe('compareVersions', () => {
  it('treats identical versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('orders patch and minor versions correctly', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
  });

  it('treats prerelease as lower precedence than stable', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  it('orders prerelease identifiers correctly', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0);
  });
});
