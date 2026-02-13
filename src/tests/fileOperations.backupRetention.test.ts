import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupStashedBackupsForTests } from '../fileOperations';

const DAY_MS = 24 * 60 * 60 * 1000;
let tmpDir = '';

async function writeBackup(name: string, ageMs: number): Promise<void> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, 'backup', 'utf8');
  const timestamp = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, timestamp, timestamp);
}

describe('backup retention cleanup', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-backup-retention-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('removes backup files older than retention window', async () => {
    await writeBackup('old.bak', 20 * DAY_MS);
    await writeBackup('recent.bak', 2 * DAY_MS);
    await writeBackup('not-a-backup.txt', 20 * DAY_MS);

    await cleanupStashedBackupsForTests(tmpDir);

    const names = await fs.readdir(tmpDir);
    expect(names).not.toContain('old.bak');
    expect(names).toContain('recent.bak');
    expect(names).toContain('not-a-backup.txt');
  });

  it('keeps only the newest 200 backup files', async () => {
    for (let i = 0; i < 205; i++) {
      await writeBackup(`backup-${i}.bak`, (205 - i) * 60 * 1000);
    }

    await cleanupStashedBackupsForTests(tmpDir);

    const backupNames = (await fs.readdir(tmpDir)).filter((name) => name.endsWith('.bak'));
    expect(backupNames).toHaveLength(200);
    expect(backupNames).not.toContain('backup-0.bak');
    expect(backupNames).not.toContain('backup-1.bak');
    expect(backupNames).not.toContain('backup-2.bak');
    expect(backupNames).not.toContain('backup-3.bak');
    expect(backupNames).not.toContain('backup-4.bak');
    expect(backupNames).toContain('backup-204.bak');
  });
});
