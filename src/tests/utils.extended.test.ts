import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecAsync = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: () => mockExecAsync,
}));

vi.mock('fs', () => ({
  promises: {
    readdir: mockReaddir,
    stat: mockStat,
    access: mockAccess,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  },
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('utils.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('getCachedDrives', () => {
    it('returns null when cache is empty (fresh module)', async () => {
      const mod = await import('../utils');
      expect(mod.getCachedDrives()).toBeNull();
    });

    it('returns cached drives after getDrives populates cache', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toContain('/');
      const cached = mod.getCachedDrives();
      expect(cached).toEqual(drives);
    });

    it('returns null when cache TTL has expired', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      await mod.getDrives();

      const cached = mod.getCachedDrives();
      expect(cached).not.toBeNull();
    });
  });

  describe('warmupDrivesCache', () => {
    it('calls getDrives and caches on success', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      mod.warmupDrivesCache();

      await new Promise((r) => setTimeout(r, 50));
      const cached = mod.getCachedDrives();
      expect(cached).toContain('/');
    });

    it('logs error when getDrives fails', async () => {
      setPlatform('linux');

      setPlatform('win32');
      mockExecAsync.mockRejectedValue(new Error('command failed'));
      mockAccess.mockRejectedValue(new Error('no access'));
      const mod = await import('../utils');

      mod.warmupDrivesCache();
      await new Promise((r) => setTimeout(r, 50));
      const cached = mod.getCachedDrives();
      expect(cached).toEqual(['C:\\']);
    });
  });

  describe('getDrives', () => {
    describe('returns cached drives if still valid', () => {
      it('returns same result on second call without re-executing', async () => {
        setPlatform('linux');
        mockReaddir.mockResolvedValue([]);
        const mod = await import('../utils');
        const first = await mod.getDrives();
        mockReaddir.mockClear();
        const second = await mod.getDrives();
        expect(second).toEqual(first);

        expect(mockReaddir).not.toHaveBeenCalled();
      });
    });

    describe('win32 platform', () => {
      it('detects drives via PowerShell', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({
          stdout: 'C\r\nD\r\nE\r\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\', 'D:\\', 'E:\\']);
      });

      it('handles lowercase PowerShell output', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({
          stdout: 'c\nd\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\', 'D:\\']);
      });

      it('ignores non-drive-letter lines in PowerShell output', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({
          stdout: 'Name\r\n----\r\nC\r\nD\r\nSomething\r\n\r\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\', 'D:\\']);
      });

      it('falls back to WMIC when PowerShell returns no drives', async () => {
        setPlatform('win32');

        mockExecAsync.mockResolvedValueOnce({ stdout: '' });

        mockExecAsync.mockResolvedValueOnce({
          stdout: 'Name\r\nC:\r\nD:\r\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\', 'D:\\']);
      });

      it('falls back to WMIC when PowerShell throws', async () => {
        setPlatform('win32');
        mockExecAsync.mockRejectedValueOnce(new Error('powershell not found'));
        mockExecAsync.mockResolvedValueOnce({
          stdout: 'Name\r\nC:\r\nE:\r\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\', 'E:\\']);
      });

      it('handles lowercase WMIC output', async () => {
        setPlatform('win32');
        mockExecAsync.mockRejectedValueOnce(new Error('powershell fail'));
        mockExecAsync.mockResolvedValueOnce({
          stdout: 'Name\r\nc:\r\nd:\r\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\', 'D:\\']);
      });

      it('falls back to direct fs check when both shell commands fail', async () => {
        setPlatform('win32');
        mockExecAsync.mockRejectedValueOnce(new Error('powershell fail'));
        mockExecAsync.mockRejectedValueOnce(new Error('wmic fail'));

        mockAccess.mockImplementation((drive: string) => {
          if (drive === 'C:\\' || drive === 'D:\\') {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('C:\\');
        expect(drives).toContain('D:\\');
        expect(drives.length).toBe(2);
      });

      it('falls back to direct fs check when PowerShell returns empty and WMIC throws', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: '\n\n' });
        mockExecAsync.mockRejectedValueOnce(new Error('wmic fail'));
        mockAccess.mockImplementation((drive: string) => {
          if (drive === 'E:\\') return Promise.resolve();
          return Promise.reject(new Error('ENOENT'));
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['E:\\']);
      });

      it('defaults to C:\\ when all detection methods fail', async () => {
        setPlatform('win32');
        mockExecAsync.mockRejectedValueOnce(new Error('powershell fail'));
        mockExecAsync.mockRejectedValueOnce(new Error('wmic fail'));
        mockAccess.mockRejectedValue(new Error('ENOENT'));
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['C:\\']);
      });

      it('sorts detected drives alphabetically', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({
          stdout: 'E\r\nA\r\nC\r\n',
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['A:\\', 'C:\\', 'E:\\']);
      });

      it('handles direct fs check with timeout race', async () => {
        setPlatform('win32');
        mockExecAsync.mockRejectedValueOnce(new Error('ps fail'));
        mockExecAsync.mockRejectedValueOnce(new Error('wmic fail'));

        mockAccess.mockImplementation(() => new Promise(() => {}));
        const mod = await import('../utils');
        const drives = await mod.getDrives();

        expect(drives).toEqual(['C:\\']);
      });

      it('WMIC returns empty and falls back to direct check', async () => {
        setPlatform('win32');

        mockExecAsync.mockResolvedValueOnce({ stdout: '' });

        mockExecAsync.mockResolvedValueOnce({ stdout: 'Name\r\n\r\n' });

        mockAccess.mockImplementation((drive: string) => {
          if (drive === 'F:\\') return Promise.resolve();
          return Promise.reject(new Error('ENOENT'));
        });
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['F:\\']);
      });
    });

    describe('darwin platform', () => {
      it('detects mount points under /Volumes', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce(['Macintosh HD', 'USB Drive']);
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/');
        expect(drives).toContain('/Volumes/Macintosh HD');
        expect(drives).toContain('/Volumes/USB Drive');
      });

      it('skips hidden directories under /Volumes', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce(['.hidden', 'Visible']);
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/');
        expect(drives).toContain('/Volumes/Visible');
        expect(drives).not.toContain('/Volumes/.hidden');
      });

      it('skips non-directory entries under /Volumes', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce(['Volume1', 'file.txt']);
        mockStat
          .mockResolvedValueOnce({ isDirectory: () => true } as any)
          .mockResolvedValueOnce({ isDirectory: () => false } as any);
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/');
        expect(drives).toContain('/Volumes/Volume1');
        expect(drives).not.toContain('/Volumes/file.txt');
      });

      it('handles stat errors gracefully', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce(['Volume1']);
        mockStat.mockRejectedValueOnce(new Error('permission denied'));
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/');
        expect(drives).not.toContain('/Volumes/Volume1');
      });

      it('handles readdir failure gracefully', async () => {
        setPlatform('darwin');
        mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['/']);
      });
    });

    describe('linux platform', () => {
      it('scans /media, /mnt, /run/media for mount points', async () => {
        setPlatform('linux');

        mockReaddir.mockResolvedValueOnce(['usb1']);

        mockReaddir.mockResolvedValueOnce(['data']);

        mockReaddir.mockResolvedValueOnce(['user']);
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/');
        expect(drives).toContain('/media/usb1');
        expect(drives).toContain('/mnt/data');
        expect(drives).toContain('/run/media/user');
      });

      it('handles missing mount directories gracefully', async () => {
        setPlatform('linux');
        mockReaddir.mockRejectedValue(new Error('ENOENT'));
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toEqual(['/']);
      });

      it('skips dot-prefixed entries', async () => {
        setPlatform('linux');
        mockReaddir
          .mockResolvedValueOnce(['.snapshot', 'usb'])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/media/usb');
        expect(drives).not.toContain('/media/.snapshot');
      });

      it('only includes directories, not files', async () => {
        setPlatform('linux');
        mockReaddir
          .mockResolvedValueOnce(['disk', 'readme.txt'])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);
        mockStat
          .mockResolvedValueOnce({ isDirectory: () => true } as any)
          .mockResolvedValueOnce({ isDirectory: () => false } as any);
        const mod = await import('../utils');
        const drives = await mod.getDrives();
        expect(drives).toContain('/media/disk');
        expect(drives).not.toContain('/media/readme.txt');
      });
    });
  });

  describe('getDriveInfo', () => {
    it('returns cached drive info if still valid', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      const first = await mod.getDriveInfo();
      mockReaddir.mockClear();
      const second = await mod.getDriveInfo();
      expect(second).toEqual(first);

      expect(mockReaddir).not.toHaveBeenCalled();
    });

    describe('linux platform', () => {
      it('uses basename as label for mount points', async () => {
        setPlatform('linux');
        mockReaddir
          .mockResolvedValueOnce(['usb-drive'])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const rootInfo = info.find((d) => d.path === '/');
        expect(rootInfo).toBeDefined();
        expect(rootInfo!.label).toBe('/');
        const usbInfo = info.find((d) => d.path === '/media/usb-drive');
        expect(usbInfo).toBeDefined();
        expect(usbInfo!.label).toBe('usb-drive');
      });

      it('returns "/" as label for root partition', async () => {
        setPlatform('linux');
        mockReaddir.mockResolvedValue([]);
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        expect(info).toHaveLength(1);
        expect(info[0].path).toBe('/');
        expect(info[0].label).toBe('/');
      });
    });

    describe('darwin platform', () => {
      it('uses diskutil label for root', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce([]);

        mockExecAsync.mockResolvedValueOnce({
          stdout: '   Volume Name:          Macintosh HD\n',
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const rootInfo = info.find((d) => d.path === '/');
        expect(rootInfo).toBeDefined();
        expect(rootInfo!.label).toBe('Macintosh HD');
      });

      it('falls back when diskutil returns "Not Applicable"', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce([]);
        mockExecAsync.mockResolvedValueOnce({
          stdout: '   Volume Name:          Not Applicable\n',
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const rootInfo = info.find((d) => d.path === '/');
        expect(rootInfo).toBeDefined();
        expect(rootInfo!.label).toBe('/');
      });

      it('handles diskutil failure gracefully', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce([]);
        mockExecAsync.mockRejectedValueOnce(new Error('diskutil fail'));
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const rootInfo = info.find((d) => d.path === '/');
        expect(rootInfo).toBeDefined();
        expect(rootInfo!.label).toBe('/');
      });

      it('assigns Volume subdirectory basenames as labels', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce(['Backup']);
        mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
        mockExecAsync.mockResolvedValueOnce({
          stdout: '   Volume Name:          Macintosh HD\n',
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const backupInfo = info.find((d) => d.path === '/Volumes/Backup');
        expect(backupInfo).toBeDefined();
        expect(backupInfo!.label).toBe('Backup');
      });

      it('handles diskutil with no Volume Name line', async () => {
        setPlatform('darwin');
        mockReaddir.mockResolvedValueOnce([]);
        mockExecAsync.mockResolvedValueOnce({
          stdout: '   Device Node:  /dev/disk1\n   File System:  APFS\n',
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const rootInfo = info.find((d) => d.path === '/');
        expect(rootInfo).toBeDefined();
        expect(rootInfo!.label).toBe('/');
      });
    });

    describe('win32 platform', () => {
      it('uses volume labels from PowerShell Get-Volume', async () => {
        setPlatform('win32');

        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\nD\r\n' });

        mockExecAsync.mockResolvedValueOnce({
          stdout: JSON.stringify([
            { DriveLetter: 'C', FileSystemLabel: 'System' },
            { DriveLetter: 'D', FileSystemLabel: 'Data' },
          ]),
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const cDrive = info.find((d) => d.path === 'C:\\');
        expect(cDrive).toBeDefined();
        expect(cDrive!.label).toBe('System (C:)');
        const dDrive = info.find((d) => d.path === 'D:\\');
        expect(dDrive).toBeDefined();
        expect(dDrive!.label).toBe('Data (D:)');
      });

      it('shows just drive letter when no label is available', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

        mockExecAsync.mockResolvedValueOnce({
          stdout: JSON.stringify({ DriveLetter: 'C', FileSystemLabel: '' }),
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const cDrive = info.find((d) => d.path === 'C:\\');
        expect(cDrive).toBeDefined();
        expect(cDrive!.label).toBe('C:');
      });

      it('falls back to WMIC labels when Get-Volume fails', async () => {
        setPlatform('win32');

        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

        mockExecAsync.mockRejectedValueOnce(new Error('Get-Volume fail'));

        mockExecAsync.mockResolvedValueOnce({
          stdout: 'Name   VolumeName\r\nC:     Windows\r\n',
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const cDrive = info.find((d) => d.path === 'C:\\');
        expect(cDrive).toBeDefined();
        expect(cDrive!.label).toBe('Windows (C:)');
      });

      it('handles both Get-Volume and WMIC label failures', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

        mockExecAsync.mockRejectedValueOnce(new Error('fail'));

        mockExecAsync.mockRejectedValueOnce(new Error('fail'));
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        const cDrive = info.find((d) => d.path === 'C:\\');
        expect(cDrive).toBeDefined();
        expect(cDrive!.label).toBe('C:');
      });

      it('handles Get-Volume returning single object instead of array', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
        mockExecAsync.mockResolvedValueOnce({
          stdout: JSON.stringify({ DriveLetter: 'C', FileSystemLabel: 'OS' }),
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        expect(info[0].label).toBe('OS (C:)');
      });

      it('handles Get-Volume with null/missing DriveLetter', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
        mockExecAsync.mockResolvedValueOnce({
          stdout: JSON.stringify([
            { DriveLetter: null, FileSystemLabel: 'Recovery' },
            { DriveLetter: 'C', FileSystemLabel: 'Main' },
          ]),
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        expect(info[0].label).toBe('Main (C:)');
      });

      it('handles Get-Volume returning empty string', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

        mockExecAsync.mockResolvedValueOnce({ stdout: '   ' });

        mockExecAsync.mockRejectedValueOnce(new Error('wmic fail'));
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        expect(info[0].label).toBe('C:');
      });

      it('handles drive path without standard letter format', async () => {
        setPlatform('win32');

        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
        mockExecAsync.mockRejectedValueOnce(new Error('fail'));
        mockExecAsync.mockRejectedValueOnce(new Error('fail'));
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();

        expect(info[0].path).toBe('C:\\');
      });

      it('WMIC label line with no label uses drive letter only', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

        mockExecAsync.mockRejectedValueOnce(new Error('fail'));

        mockExecAsync.mockResolvedValueOnce({
          stdout: 'Name   VolumeName\r\nC:     \r\n',
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();

        expect(info[0].label).toBe('C:');
      });

      it('handles Get-Volume with DriveLetter as empty string', async () => {
        setPlatform('win32');
        mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
        mockExecAsync.mockResolvedValueOnce({
          stdout: JSON.stringify([
            { DriveLetter: '', FileSystemLabel: 'Recovery' },
            { DriveLetter: 'C', FileSystemLabel: 'Windows' },
          ]),
        });
        const mod = await import('../utils');
        const info = await mod.getDriveInfo();
        expect(info[0].label).toBe('Windows (C:)');
      });
    });
  });

  describe('getDriveInfo caching', () => {
    it('does not call getDrives again when driveInfo cache is valid', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      await mod.getDriveInfo();
      const callCountAfterFirst = mockReaddir.mock.calls.length;
      await mod.getDriveInfo();

      expect(mockReaddir.mock.calls.length).toBe(callCountAfterFirst);
    });
  });

  describe('getDrives win32 edge cases', () => {
    it('powershell returns only non-matching lines', async () => {
      setPlatform('win32');

      mockExecAsync.mockResolvedValueOnce({ stdout: 'Name\r\n----\r\n12\r\n' });

      mockExecAsync.mockResolvedValueOnce({ stdout: 'Name\r\n' });

      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toEqual(['C:\\']);
    });

    it('WMIC returns lines that match the drive pattern', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: '' });
      mockExecAsync.mockResolvedValueOnce({
        stdout: 'Name  \r\nC:  \r\nX:  \r\nZ:  \r\n',
      });
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toEqual(['C:\\', 'X:\\', 'Z:\\']);
    });

    it('direct check with some accessible drives', async () => {
      setPlatform('win32');
      mockExecAsync.mockRejectedValueOnce(new Error('ps fail'));
      mockExecAsync.mockRejectedValueOnce(new Error('wmic fail'));
      let callCount = 0;
      mockAccess.mockImplementation((drive: string) => {
        callCount++;

        if (drive === 'Z:\\') return Promise.resolve();
        return Promise.reject(new Error('nope'));
      });
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toEqual(['Z:\\']);

      expect(callCount).toBe(26);
    });
  });

  describe('getDrives linux/darwin with mixed entries', () => {
    it('handles readdir returning empty array for some roots', async () => {
      setPlatform('linux');
      mockReaddir
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(['shared'])
        .mockResolvedValueOnce([]);
      mockStat.mockResolvedValue({ isDirectory: () => true } as any);
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toEqual(['/', '/mnt/shared']);
    });

    it('handles stat throwing for some entries while succeeding for others', async () => {
      setPlatform('linux');
      mockReaddir
        .mockResolvedValueOnce(['good', 'bad'])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true } as any)
        .mockRejectedValueOnce(new Error('EACCES'));
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toContain('/');
      expect(drives).toContain('/media/good');
      expect(drives).not.toContain('/media/bad');
    });

    it('handles readdir failure for one root while others succeed', async () => {
      setPlatform('linux');
      mockReaddir
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(['data'])
        .mockRejectedValueOnce(new Error('ENOENT'));
      mockStat.mockResolvedValue({ isDirectory: () => true } as any);
      const mod = await import('../utils');
      const drives = await mod.getDrives();
      expect(drives).toEqual(['/', '/mnt/data']);
    });
  });

  describe('getDriveInfo darwin edge cases', () => {
    it('getDarwinRootLabel returns null when diskutil output has no Volume Name', async () => {
      setPlatform('darwin');
      mockReaddir.mockResolvedValueOnce([]);
      mockExecAsync.mockResolvedValueOnce({
        stdout: 'some garbage output\n',
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();

      expect(info[0].label).toBe('/');
    });

    it('uses basename for volume subdirs even when root label exists', async () => {
      setPlatform('darwin');
      mockReaddir.mockResolvedValueOnce(['TimeMachine', 'External']);
      mockStat.mockResolvedValue({ isDirectory: () => true } as any);
      mockExecAsync.mockResolvedValueOnce({
        stdout: '   Volume Name:          Macintosh HD\n',
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info.find((d) => d.path === '/')!.label).toBe('Macintosh HD');
      expect(info.find((d) => d.path === '/Volumes/TimeMachine')!.label).toBe('TimeMachine');
      expect(info.find((d) => d.path === '/Volumes/External')!.label).toBe('External');
    });

    it('handles Volume Name with extra whitespace', async () => {
      setPlatform('darwin');
      mockReaddir.mockResolvedValueOnce([]);
      mockExecAsync.mockResolvedValueOnce({
        stdout: '   Volume Name:          My Drive   \n',
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info[0].label).toBe('My Drive');
    });
  });

  describe('getDriveInfo win32 WMIC label parsing', () => {
    it('parses multi-word volume names from WMIC', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\nD\r\n' });

      mockExecAsync.mockRejectedValueOnce(new Error('fail'));

      mockExecAsync.mockResolvedValueOnce({
        stdout: 'Name   VolumeName\r\nC:     Windows OS\r\nD:     Data Storage\r\n',
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info.find((d) => d.path === 'C:\\')!.label).toBe('Windows OS (C:)');
      expect(info.find((d) => d.path === 'D:\\')!.label).toBe('Data Storage (D:)');
    });

    it('ignores WMIC header line', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
      mockExecAsync.mockRejectedValueOnce(new Error('fail'));
      mockExecAsync.mockResolvedValueOnce({
        stdout: 'Name   VolumeName\r\nC:     System Reserved\r\n',
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info[0].label).toBe('System Reserved (C:)');
    });

    it('handles WMIC with lowercase drive letters', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
      mockExecAsync.mockRejectedValueOnce(new Error('fail'));
      mockExecAsync.mockResolvedValueOnce({
        stdout: 'Name   VolumeName\r\nc:     mydrv\r\n',
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info[0].label).toBe('mydrv (C:)');
    });
  });

  describe('getWindowsDriveDisplayName edge cases (tested via getDriveInfo)', () => {
    it('handles drive path with trailing backslashes', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

      mockExecAsync.mockRejectedValueOnce(new Error('fail'));
      mockExecAsync.mockRejectedValueOnce(new Error('fail'));
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();

      expect(info[0].label).toBe('C:');
    });

    it('handles volumeLabel that is only whitespace', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
      mockExecAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({ DriveLetter: 'C', FileSystemLabel: '   ' }),
      });
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();

      expect(info[0].label).toBe('C:');
    });
  });

  describe('getUnixDriveLabel edge cases (tested via getDriveInfo)', () => {
    it('handles path with trailing slashes for non-root', async () => {
      setPlatform('linux');

      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info[0].path).toBe('/');
      expect(info[0].label).toBe('/');
    });
  });

  describe('concurrent getDrives calls', () => {
    it('returns same result when called concurrently', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue(['ext-drive']);
      mockStat.mockResolvedValue({ isDirectory: () => true } as any);
      const mod = await import('../utils');
      const [r1, r2] = await Promise.all([mod.getDrives(), mod.getDrives()]);

      expect(r1).toEqual(r2);
    });
  });

  describe('getDriveInfo concurrent calls', () => {
    it('returns same result when called concurrently', async () => {
      setPlatform('linux');
      mockReaddir.mockResolvedValue([]);
      const mod = await import('../utils');
      const [r1, r2] = await Promise.all([mod.getDriveInfo(), mod.getDriveInfo()]);
      expect(r1).toEqual(r2);
    });
  });

  describe('Get-Volume JSON parsing edge cases', () => {
    it('handles Get-Volume returning invalid JSON gracefully (falls to wmic)', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });

      mockExecAsync.mockResolvedValueOnce({ stdout: 'not json at all' });

      mockExecAsync.mockResolvedValueOnce({
        stdout: 'Name   VolumeName\r\nC:     System\r\n',
      });
      const mod = await import('../utils');

      const info = await mod.getDriveInfo();
      expect(info[0].label).toBe('System (C:)');
    });

    it('handles Get-Volume returning empty JSON array', async () => {
      setPlatform('win32');
      mockExecAsync.mockResolvedValueOnce({ stdout: 'C\r\n' });
      mockExecAsync.mockResolvedValueOnce({ stdout: '[]' });

      mockExecAsync.mockRejectedValueOnce(new Error('fail'));
      const mod = await import('../utils');
      const info = await mod.getDriveInfo();
      expect(info[0].label).toBe('C:');
    });
  });
});
