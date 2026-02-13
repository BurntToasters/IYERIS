import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../processUtils', () => ({
  captureSpawnOutput: vi.fn(),
}));

vi.mock('../security', () => ({
  isPathSafe: vi.fn(() => true),
  getErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error)
  ),
}));

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { captureSpawnOutput } from '../processUtils';
import { getDiskSpace } from '../diskSpaceHandler';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.mocked(captureSpawnOutput).mockReset();
});

describe('getDiskSpace', () => {
  it('parses df output on linux/darwin', async () => {
    setPlatform('linux');
    vi.mocked(captureSpawnOutput).mockResolvedValue({
      code: 0,
      timedOut: false,
      stderr: '',
      stdout: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 40 60 40% /',
    });

    const result = await getDiskSpace('/tmp');

    expect(result).toEqual({ success: true, total: 102400, free: 61440 });
    const expectedArgs = process.platform === 'darwin' ? ['-k', '/tmp'] : ['-k', '--', '/tmp'];
    expect(captureSpawnOutput).toHaveBeenCalledWith('df', expectedArgs, 5000, {
      shell: false,
    });
  });

  it('returns invalid format for malformed df rows', async () => {
    setPlatform('linux');
    vi.mocked(captureSpawnOutput).mockResolvedValue({
      code: 0,
      timedOut: false,
      stderr: '',
      stdout: 'Filesystem 1K-blocks Used Available Use% Mounted on\nbroken',
    });

    const result = await getDiskSpace('/tmp');

    expect(result).toEqual({ success: false, error: 'Invalid disk info format' });
  });

  it('returns command failure when df fails', async () => {
    setPlatform('linux');
    vi.mocked(captureSpawnOutput).mockResolvedValue({
      code: 1,
      timedOut: false,
      stderr: 'nope',
      stdout: '',
    });

    const result = await getDiskSpace('/tmp');

    expect(result).toEqual({ success: false, error: 'df command failed' });
  });

  it('validates drive letter on windows', async () => {
    setPlatform('win32');

    const result = await getDiskSpace('/tmp');

    expect(result).toEqual({ success: false, error: 'Invalid drive letter' });
    expect(captureSpawnOutput).not.toHaveBeenCalled();
  });

  it('parses powershell output on windows', async () => {
    setPlatform('win32');
    vi.mocked(captureSpawnOutput).mockResolvedValue({
      code: 0,
      timedOut: false,
      stderr: '',
      stdout: '{"Free":"100","Used":"900"}',
    });

    const result = await getDiskSpace('C:\\');

    expect(result).toEqual({ success: true, free: 100, total: 1000 });
    expect(captureSpawnOutput).toHaveBeenCalledWith(
      'powershell',
      [
        '-Command',
        "Get-PSDrive -Name C | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json",
      ],
      5000,
      { shell: false }
    );
  });

  it('returns parse error for invalid powershell json', async () => {
    setPlatform('win32');
    vi.mocked(captureSpawnOutput).mockResolvedValue({
      code: 0,
      timedOut: false,
      stderr: '',
      stdout: 'not-json',
    });

    const result = await getDiskSpace('C:\\');

    expect(result).toEqual({ success: false, error: 'Could not parse disk info' });
  });

  it('returns timeout errors from subprocess execution', async () => {
    setPlatform('linux');
    vi.mocked(captureSpawnOutput).mockResolvedValue({
      code: 0,
      timedOut: true,
      stderr: '',
      stdout: '',
    });

    const result = await getDiskSpace('/tmp');

    expect(result).toEqual({ success: false, error: 'Disk space query timed out' });
  });
});
