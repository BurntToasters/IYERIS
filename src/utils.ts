import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let cachedDrives: string[] | null = null;
let drivesCacheTime: number = 0;
const DRIVES_CACHE_TTL = 30000;

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
    .catch(() => {});
}

export async function getDrives(): Promise<string[]> {
  const cached = getCachedDrives();
  if (cached) {
    return cached;
  }

  const platform = process.platform;

  if (platform === 'win32') {
    const drives: Set<string> = new Set();

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
        console.log('[Drives] PowerShell detected drives:', Array.from(drives).join(', '));
      }
    } catch (e) {
      console.log('[Drives] PowerShell drive detection failed:', (e as Error).message);
    }

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
          console.log('[Drives] WMIC detected drives:', Array.from(drives).join(', '));
        }
      } catch (e) {
        console.log('[Drives] WMIC drive detection failed:', (e as Error).message);
      }
    }

    // Last resort - not great option; probably will remove later
    if (drives.size === 0) {
      console.log('[Drives] Falling back to direct drive letter check...');
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
        console.log('[Drives] Direct check detected drives:', Array.from(drives).join(', '));
      }
    }

    if (drives.size === 0) {
      console.log('[Drives] No drives detected, defaulting to C:\\');
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
    const commonRoots = platform === 'darwin' ? ['/Volumes'] : ['/media', '/mnt', '/run/media'];
    const detected: string[] = ['/'];

    for (const root of commonRoots) {
      try {
        const subs = await fs.readdir(root);
        for (const sub of subs) {
          if (sub.startsWith('.')) continue;
          const fullPath = path.join(root, sub);
          try {
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) {
              detected.push(fullPath);
            }
          } catch {}
        }
      } catch {}
    }
    cachedDrives = detected;
    drivesCacheTime = Date.now();
    return detected;
  }
}
