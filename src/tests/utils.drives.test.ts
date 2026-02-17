import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  fsAccess: vi.fn(),
  fsReaddir: vi.fn(),
  fsStat: vi.fn(),
  execMock: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    access: hoisted.fsAccess,
    readdir: hoisted.fsReaddir,
    stat: hoisted.fsStat,
  },
}));

vi.mock('child_process', () => ({
  exec: hoisted.execMock,
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => hoisted.execMock),
}));

vi.mock('../main/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('utils module (getDrives/getDriveInfo)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('getDrives on Linux', () => {
    it('returns / and scanned mount points', async () => {
      setPlatform('linux');

      hoisted.fsReaddir.mockImplementation(async (root: string) => {
        if (root === '/media') return ['usb1'];
        if (root === '/mnt') return ['data'];
        if (root === '/run/media') throw new Error('ENOENT');
        return [];
      });
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => true });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('/');
      expect(drives).toContain(path.join('/media', 'usb1'));
      expect(drives).toContain(path.join('/mnt', 'data'));
    });

    it('skips dotfiles in mount points', async () => {
      setPlatform('linux');

      hoisted.fsReaddir.mockImplementation(async (root: string) => {
        if (root === '/media') return ['.hidden', 'visible'];
        throw new Error('ENOENT');
      });
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => true });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain(path.join('/media', 'visible'));
      const hasHidden = drives.some((d: string) => d.includes('.hidden'));
      expect(hasHidden).toBe(false);
    });

    it('skips non-directory entries', async () => {
      setPlatform('linux');

      hoisted.fsReaddir.mockImplementation(async (root: string) => {
        if (root === '/media') return ['file.txt'];
        throw new Error('ENOENT');
      });
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => false });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('/');
      expect(drives).not.toContain(path.join('/media', 'file.txt'));
    });

    it('handles inaccessible mount points gracefully', async () => {
      setPlatform('linux');
      hoisted.fsReaddir.mockRejectedValue(new Error('EACCES'));

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('/');
    });

    it('handles stat errors on individual entries', async () => {
      setPlatform('linux');

      hoisted.fsReaddir.mockImplementation(async (root: string) => {
        if (root === '/media') return ['broken'];
        throw new Error('ENOENT');
      });
      hoisted.fsStat.mockRejectedValue(new Error('EACCES'));

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('/');
      expect(drives).not.toContain(path.join('/media', 'broken'));
    });

    it('returns cached drives within TTL', async () => {
      setPlatform('linux');
      hoisted.fsReaddir.mockResolvedValue([]);

      const { getDrives, getCachedDrives } = await import('../main/utils');
      const first = await getDrives();
      expect(getCachedDrives()).toEqual(first);

      hoisted.fsReaddir.mockClear();
      const second = await getDrives();
      expect(second).toEqual(first);
      expect(hoisted.fsReaddir).not.toHaveBeenCalled();
    });
  });

  describe('getDrives on macOS', () => {
    it('scans /Volumes', async () => {
      setPlatform('darwin');

      hoisted.fsReaddir.mockImplementation(async (root: string) => {
        if (root === '/Volumes') return ['Macintosh HD', 'External'];
        throw new Error('ENOENT');
      });
      hoisted.fsStat.mockResolvedValue({ isDirectory: () => true });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('/');
      expect(drives).toContain(path.join('/Volumes', 'Macintosh HD'));
      expect(drives).toContain(path.join('/Volumes', 'External'));
    });
  });

  describe('getDrives on Windows', () => {
    it('detects drives via powershell', async () => {
      setPlatform('win32');

      hoisted.execMock.mockResolvedValueOnce({ stdout: 'C\nD\nE\n' });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('C:\\');
      expect(drives).toContain('D:\\');
      expect(drives).toContain('E:\\');
    });

    it('falls back to wmic when powershell fails', async () => {
      setPlatform('win32');

      hoisted.execMock
        .mockRejectedValueOnce(new Error('ps fail'))
        .mockResolvedValueOnce({ stdout: 'Name\nC:\nD:\n' });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('C:\\');
      expect(drives).toContain('D:\\');
    });

    it('falls back to direct fs check when both methods fail', async () => {
      setPlatform('win32');

      hoisted.execMock
        .mockRejectedValueOnce(new Error('ps fail'))
        .mockRejectedValueOnce(new Error('wmic fail'));

      hoisted.fsAccess.mockImplementation(async (drivePath: string) => {
        if (drivePath === 'C:\\') return;
        throw new Error('ENOENT');
      });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('C:\\');
    });

    it('ignores lines that are not valid drive letters from powershell', async () => {
      setPlatform('win32');

      hoisted.execMock.mockResolvedValueOnce({
        stdout: 'C\n\nNotADrive\n\n',
      });

      const { getDrives } = await import('../main/utils');
      const drives = await getDrives();
      expect(drives).toContain('C:\\');
      expect(drives.length).toBe(1);
    });
  });

  describe('warmupDrivesCache', () => {
    it('does not throw', async () => {
      setPlatform('linux');
      hoisted.fsReaddir.mockRejectedValue(new Error('ENOENT'));

      const { warmupDrivesCache } = await import('../main/utils');
      expect(() => warmupDrivesCache()).not.toThrow();
    });
  });

  describe('getDriveInfo', () => {
    it.skipIf(process.platform === 'win32')(
      'returns drive info with path and label on linux',
      async () => {
        setPlatform('linux');

        hoisted.fsReaddir.mockImplementation(async (root: string) => {
          if (root === '/media') return ['USB Drive'];
          throw new Error('ENOENT');
        });
        hoisted.fsStat.mockResolvedValue({ isDirectory: () => true });

        const { getDriveInfo } = await import('../main/utils');
        const info = await getDriveInfo();
        expect(info.length).toBeGreaterThan(0);

        const root = info.find((d) => d.path === '/');
        expect(root).toBeDefined();
        expect(typeof root!.label).toBe('string');

        const usb = info.find((d) => d.path === path.join('/media', 'USB Drive'));
        expect(usb).toBeDefined();
        expect(usb!.label).toBe('USB Drive');
      }
    );

    it('returns cached drive info within TTL', async () => {
      setPlatform('linux');
      hoisted.fsReaddir.mockResolvedValue([]);

      const { getDriveInfo } = await import('../main/utils');
      const first = await getDriveInfo();
      expect(first.length).toBeGreaterThan(0);

      hoisted.fsReaddir.mockClear();
      const second = await getDriveInfo();
      expect(second).toEqual(first);
    });

    it('uses getWindowsDriveDisplayName on win32', async () => {
      setPlatform('win32');

      hoisted.execMock.mockResolvedValue({ stdout: 'C\n' });

      const { getDriveInfo } = await import('../main/utils');
      const info = await getDriveInfo();
      expect(info.length).toBeGreaterThan(0);

      const cDrive = info.find((d) => d.path === 'C:\\');
      expect(cDrive).toBeDefined();
      expect(cDrive!.label).toContain('C:');
    });
  });

  describe('getCachedDrives', () => {
    it('returns null when no cache populated', async () => {
      setPlatform('linux');
      const { getCachedDrives } = await import('../main/utils');
      expect(getCachedDrives()).toBe(null);
    });
  });
});
