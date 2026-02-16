import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';
import type { DriveInfo } from '../types';
import { ignoreError } from '../shared';

const execAsync = promisify(exec);

let cachedDrives: string[] | null = null;
let drivesCacheTime: number = 0;
const DRIVES_CACHE_TTL = 30000;
let cachedDriveInfo: DriveInfo[] | null = null;
let driveInfoCacheTime = 0;

export function getCachedDrives(): string[] | null {
  if (cachedDrives && Date.now() - drivesCacheTime < DRIVES_CACHE_TTL) {
    return cachedDrives;
  }
  return null;
}

export function warmupDrivesCache(): void {
  getDrives()
    .then((drives) => {
      cachedDrives = drives;
      drivesCacheTime = Date.now();
    })
    .catch((error) => {
      logger.error('[Utils] Failed to warm up drives cache:', error);
    });
}

export async function getDrives(): Promise<string[]> {
  // return cached if fresh
  const cached = getCachedDrives();
  if (cached) {
    return cached;
  }

  const platform = process.platform;

  if (platform === 'win32') {
    const drives: Set<string> = new Set();

    // try powershell first
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name"',
        { timeout: 5000 }
      );
      const lines = stdout.split(/[\r\n]+/);
      for (const line of lines) {
        const drive = line.trim();
        if (/^[A-Z]$/i.test(drive)) {
          drives.add(drive.toUpperCase() + ':\\');
        }
      }
      if (drives.size > 0) {
        logger.info('[Drives] PowerShell detected drives:', Array.from(drives).join(', '));
      }
    } catch (e) {
      logger.info('[Drives] PowerShell drive detection failed:', (e as Error).message);
    }

    // fallback to wmic
    if (drives.size === 0) {
      try {
        const { stdout } = await execAsync('wmic logicaldisk get name', { timeout: 3000 });
        const lines = stdout.split(/[\r\n]+/);
        for (const line of lines) {
          const drive = line.trim();
          if (/^[A-Z]:$/i.test(drive)) {
            drives.add(drive.toUpperCase() + '\\');
          }
        }
        if (drives.size > 0) {
          logger.info('[Drives] WMIC detected drives:', Array.from(drives).join(', '));
        }
      } catch (e) {
        logger.info('[Drives] WMIC drive detection failed:', (e as Error).message);
      }
    }

    // direct fs check fallback
    if (drives.size === 0) {
      logger.info('[Drives] Falling back to direct drive letter check...');
      const driveLetters: string[] = [];
      for (let i = 65; i <= 90; i++) {
        driveLetters.push(String.fromCharCode(i) + ':\\');
      }

      const checkDrive = async (drive: string): Promise<string | null> => {
        try {
          await Promise.race([
            fs.access(drive),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 200)),
          ]);
          return drive;
        } catch {
          return null;
        }
      };

      const results = await Promise.all(driveLetters.map(checkDrive));
      results.forEach((d) => {
        if (d) drives.add(d);
      });

      if (drives.size > 0) {
        logger.info('[Drives] Direct check detected drives:', Array.from(drives).join(', '));
      }
    }

    if (drives.size === 0) {
      logger.info('[Drives] No drives detected, defaulting to C:\\');
      const result = ['C:\\'];
      cachedDrives = result;
      drivesCacheTime = Date.now();
      return result;
    }
    const result = Array.from(drives).sort();
    cachedDrives = result;
    drivesCacheTime = Date.now();
    return result;
  } else {
    // scan mount points
    const commonRoots = platform === 'darwin' ? ['/Volumes'] : ['/media', '/mnt', '/run/media'];
    const detected: string[] = ['/'];

    for (const root of commonRoots) {
      try {
        await fs.access(root);
        const subs = await fs.readdir(root);
        for (const sub of subs) {
          if (sub.startsWith('.')) continue;
          const fullPath = path.join(root, sub);
          try {
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) {
              detected.push(fullPath);
            }
          } catch (error) {
            ignoreError(error);
          }
        }
      } catch (error) {
        ignoreError(error);
      }
    }
    cachedDrives = detected;
    drivesCacheTime = Date.now();
    return detected;
  }
}

function getWindowsDriveDisplayName(drivePath: string, volumeLabel?: string): string {
  const match = drivePath.match(/^([A-Za-z]):/);
  const driveLetter = match ? `${match[1].toUpperCase()}:` : drivePath.replace(/\\+$/, '');
  const trimmedLabel = volumeLabel?.trim();
  if (trimmedLabel) {
    return `${trimmedLabel} (${driveLetter})`;
  }
  return driveLetter || drivePath;
}

async function getWindowsDriveLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();

  // try powershell get-volume
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-Volume | Select-Object DriveLetter, FileSystemLabel | ConvertTo-Json"',
      { timeout: 5000 }
    );
    const trimmed = stdout.trim();
    if (trimmed) {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const letter = typeof item?.DriveLetter === 'string' ? item.DriveLetter.trim() : '';
        if (!letter) continue;
        const label = typeof item?.FileSystemLabel === 'string' ? item.FileSystemLabel.trim() : '';
        if (label) {
          labels.set(letter.toUpperCase() + ':\\', label);
        }
      }
    }
    if (labels.size > 0) {
      return labels;
    }
  } catch (e) {
    logger.info('[Drives] Get-Volume label detection failed:', (e as Error).message);
  }

  // fallback to wmic (this only works on W10)
  try {
    const { stdout } = await execAsync('wmic logicaldisk get name, volumename', {
      timeout: 3000,
    });
    const lines = stdout
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines.slice(1)) {
      const match = line.match(/^([A-Z]:)\s+(.*)$/i);
      if (!match) continue;
      const letter = match[1].toUpperCase();
      const label = match[2].trim();
      if (label) {
        labels.set(letter + '\\', label);
      }
    }
  } catch (e) {
    logger.info('[Drives] WMIC label detection failed:', (e as Error).message);
  }

  return labels;
}

async function getDarwinRootLabel(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('diskutil info /', { timeout: 3000 });
    const lines = stdout.split(/[\r\n]+/);
    for (const line of lines) {
      const match = line.match(/^\s*Volume Name:\s*(.+)$/);
      if (match) {
        const label = match[1].trim();
        if (label && label.toLowerCase() !== 'not applicable') {
          return label;
        }
      }
    }
  } catch (e) {
    logger.info('[Drives] diskutil label detection failed:', (e as Error).message);
  }
  return null;
}

function getUnixDriveLabel(drivePath: string, rootLabel?: string | null): string {
  if (drivePath === '/' && rootLabel) {
    return rootLabel;
  }
  const normalized = drivePath.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts[parts.length - 1];
  return basename || drivePath;
}

export async function getDriveInfo(): Promise<DriveInfo[]> {
  if (cachedDriveInfo && Date.now() - driveInfoCacheTime < DRIVES_CACHE_TTL) {
    return cachedDriveInfo;
  }

  const drives = await getDrives();
  const platform = process.platform;

  let result: DriveInfo[] = [];

  if (platform === 'win32') {
    const labelMap = await getWindowsDriveLabels();
    result = drives.map((drivePath) => ({
      path: drivePath,
      label: getWindowsDriveDisplayName(drivePath, labelMap.get(drivePath)),
    }));
  } else if (platform === 'darwin') {
    const rootLabel = await getDarwinRootLabel();
    result = drives.map((drivePath) => ({
      path: drivePath,
      label: getUnixDriveLabel(drivePath, rootLabel),
    }));
  } else {
    result = drives.map((drivePath) => ({
      path: drivePath,
      label: getUnixDriveLabel(drivePath),
    }));
  }

  cachedDriveInfo = result;
  driveInfoCacheTime = Date.now();
  return result;
}
