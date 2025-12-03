import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
export async function getDrives(): Promise<string[]> {
  const platform = process.platform;

  if (platform === 'win32') {
    const drives: Set<string> = new Set();

    try {
      const { stdout } = await execAsync('wmic logicaldisk get name', { timeout: 2000 });
      const lines = stdout.split(/[\r\n]+/);
      for (const line of lines) {
        const drive = line.trim();
        if (/^[A-Z]:$/.test(drive)) {
          drives.add(drive + '\\');
        }
      }
    } catch (e) {
      console.log('[Drives] WMIC drive detection failed:', (e as Error).message);
    }

    if (drives.size === 0) {
      try {
        const { stdout } = await execAsync('powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Name"', { timeout: 3000 });
        const lines = stdout.split(/[\r\n]+/);
        for (const line of lines) {
          let drive = line.trim();
          if (/^[A-Z]$/.test(drive)) {
            drive += ':';
          }
          if (/^[A-Z]:$/.test(drive)) {
            drives.add(drive + '\\');
          }
        }
      } catch (e) {
        console.log('[Drives] PowerShell drive detection failed:', (e as Error).message);
      }
    }

    if (drives.size === 0) {
      const driveLetters: string[] = [];
      for (let i = 65; i <= 90; i++) {
        driveLetters.push(String.fromCharCode(i) + ':\\');
      }

      const checkDrive = async (drive: string): Promise<string | null> => {
        try {
          await Promise.race([
            fs.access(drive),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 200))
          ]);
          return drive;
        } catch {
          return null;
        }
      };

      const results = await Promise.all(driveLetters.map(checkDrive));
      results.forEach(d => {
        if (d) drives.add(d);
      });
    }

    if (drives.size === 0) return ['C:\\'];
    return Array.from(drives).sort();
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
          } catch {
          }
        }
      } catch {
      }
    }
    return detected;
  }
}
