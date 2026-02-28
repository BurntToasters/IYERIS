import { captureSpawnOutput } from './processUtils';
import { isPathSafe, getErrorMessage } from './security';
import { logger } from './logger';

const SAFE_UNC_RE = /^\\\\[^\\]+\\[^\\]+(\\)?$/;

export async function getDiskSpace(
  drivePath: string
): Promise<{ success: boolean; total?: number; free?: number; error?: string }> {
  logger.debug('[Main] get-disk-space called with path:', drivePath, 'Platform:', process.platform);
  if (!isPathSafe(drivePath)) {
    return { success: false, error: 'Invalid drive path' };
  }
  try {
    if (process.platform === 'win32') {
      const normalized = drivePath.replace(/\//g, '\\');
      const isUnc = normalized.startsWith('\\\\');

      let psCommand = '';
      if (isUnc) {
        if (!SAFE_UNC_RE.test(normalized)) {
          return { success: false, error: 'Invalid UNC path format' };
        }
        const uncRoot = normalized.endsWith('\\') ? normalized : normalized + '\\';
        const escapedRoot = uncRoot.replace(/'/g, "''").replace(/[`$]/g, '');
        logger.debug('[Main] Getting disk space for UNC path:', uncRoot);
        psCommand = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq '${escapedRoot}' } | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json`;
      } else {
        const driveLetter = normalized.substring(0, 2);
        const driveChar = driveLetter.charAt(0).toUpperCase();
        if (!/^[A-Z]$/.test(driveChar)) {
          logger.error('[Main] Invalid drive letter:', driveChar);
          return { success: false, error: 'Invalid drive letter' };
        }
        logger.debug('[Main] Getting disk space for drive:', driveChar);
        psCommand = `Get-PSDrive -Name ${driveChar} | Select-Object @{Name='Free';Expression={$_.Free}}, @{Name='Used';Expression={$_.Used}} | ConvertTo-Json`;
      }

      const { code, stdout, stderr, timedOut } = await captureSpawnOutput(
        'powershell',
        ['-Command', psCommand],
        5000,
        { shell: false }
      );
      if (timedOut) {
        return { success: false, error: 'Disk space query timed out' };
      }
      if (code !== 0) {
        logger.error('[Main] PowerShell error:', stderr);
        return { success: false, error: 'PowerShell command failed' };
      }
      logger.debug('[Main] PowerShell output:', stdout);
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          if (isUnc) {
            return await getUncDiskSpaceViaDriveInfo(normalized);
          }
          return { success: false, error: 'Disk space not available for path' };
        }
        const data = JSON.parse(trimmed);
        const entry = Array.isArray(data) ? data[0] : data;
        if (!entry) {
          if (isUnc) {
            return await getUncDiskSpaceViaDriveInfo(normalized);
          }
          return { success: false, error: 'Disk space not available for path' };
        }
        const free = parseInt(entry.Free);
        const used = parseInt(entry.Used);
        const total = free + used;
        logger.debug('[Main] Success - Free:', free, 'Used:', used, 'Total:', total);
        return { success: true, free, total };
      } catch (parseError) {
        logger.error('[Main] JSON parse error:', parseError);
        return { success: false, error: 'Could not parse disk info' };
      }
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      const dfArgs = process.platform === 'darwin' ? ['-k', drivePath] : ['-k', '--', drivePath];
      const { code, stdout, stderr, timedOut } = await captureSpawnOutput('df', dfArgs, 5000, {
        shell: false,
      });
      if (timedOut) {
        return { success: false, error: 'Disk space query timed out' };
      }
      if (code !== 0) {
        logger.error('[Main] df error:', stderr);
        return { success: false, error: 'df command failed' };
      }
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) {
        return { success: false, error: 'Could not parse disk info' };
      }

      const parts = lines[1].trim().split(/\s+/);
      if (parts.length >= 4) {
        const total = parseInt(parts[1]) * 1024;
        const available = parseInt(parts[3]) * 1024;
        return { success: true, total, free: available };
      }
      return { success: false, error: 'Invalid disk info format' };
    } else {
      return { success: false, error: 'Disk space info not available on this platform' };
    }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

async function getUncDiskSpaceViaDriveInfo(
  uncPath: string
): Promise<{ success: boolean; total?: number; free?: number; error?: string }> {
  try {
    const escaped = uncPath.replace(/'/g, "''").replace(/[`$]/g, '');
    const psCommand = `$d = [System.IO.DriveInfo]::new('${escaped}'); @{Free=$d.AvailableFreeSpace;Total=$d.TotalSize} | ConvertTo-Json`;
    const { code, stdout } = await captureSpawnOutput('powershell', ['-Command', psCommand], 5000, {
      shell: false,
    });
    if (code !== 0) {
      return { success: false, error: 'UNC disk space fallback failed' };
    }
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { success: false, error: 'Disk space not available for UNC path' };
    }
    const data = JSON.parse(trimmed);
    const free = parseInt(data.Free);
    const total = parseInt(data.Total);
    if (isNaN(free) || isNaN(total)) {
      return { success: false, error: 'Invalid UNC disk space data' };
    }
    logger.debug('[Main] UNC fallback success - Free:', free, 'Total:', total);
    return { success: true, free, total };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}
