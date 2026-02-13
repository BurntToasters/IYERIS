import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isPathSafe } from './security';
import { ignoreError } from '../shared';
import { spawnWithTimeout } from './processUtils';

const execAsync = promisify(exec);

const MAX_GIT_STATUS_BYTES = 20 * 1024 * 1024;

function mapGitStatusCode(statusCode: string): string {
  if (statusCode === '??') return 'untracked';
  if (statusCode === '!!') return 'ignored';
  if (statusCode.includes('U') || statusCode === 'AA' || statusCode === 'DD') return 'conflict';
  if (statusCode.includes('A') || statusCode.includes('C')) return 'added';
  if (statusCode.includes('D')) return 'deleted';
  if (statusCode.includes('R')) return 'renamed';
  return 'modified';
}

async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', {
      cwd: dirPath,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getGitStatus(
  dirPath: string,
  includeUntracked: boolean = true
): Promise<{
  success: boolean;
  isGitRepo?: boolean;
  statuses?: { path: string; status: string }[];
  error?: string;
}> {
  try {
    if (!isPathSafe(dirPath)) {
      return { success: false, error: 'Invalid directory path' };
    }

    if (!(await isGitRepository(dirPath))) {
      return { success: true, isGitRepo: false, statuses: [] };
    }

    const statusArgs = includeUntracked ? ['-uall'] : ['-uno'];
    const { child: gitProcess, timedOut } = spawnWithTimeout(
      'git',
      ['status', '--porcelain', '-z', ...statusArgs],
      30000,
      { cwd: dirPath, windowsHide: true, shell: false }
    );

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let truncated = false;

    if (gitProcess.stdout) {
      gitProcess.stdout.on('data', (data: Buffer) => {
        if (stdoutBytes + data.length > MAX_GIT_STATUS_BYTES) {
          truncated = true;
          try {
            gitProcess.kill();
          } catch (error) {
            ignoreError(error);
          }
          return;
        }
        stdoutBytes += data.length;
        stdoutChunks.push(data);
      });
    }

    if (gitProcess.stderr) {
      gitProcess.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      gitProcess.on('error', reject);
      gitProcess.on('close', (code) => {
        if (timedOut()) {
          reject(new Error('Git status timed out'));
          return;
        }
        if (truncated) {
          reject(new Error('Git status output too large'));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr || 'Git status failed'));
          return;
        }
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      });
    });

    const statuses: { path: string; status: string }[] = [];
    const entries = stdout.split('\0').filter((entry) => entry);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 3) continue;
      const statusCode = entry.substring(0, 2);
      let filePath = entry.substring(3);

      if (statusCode.includes('R') || statusCode.includes('C')) {
        const nextPath = entries[i + 1];
        if (nextPath) {
          filePath = nextPath;
          i += 1;
        }
      }

      const fullPath = path.join(dirPath, filePath);
      statuses.push({ path: fullPath, status: mapGitStatusCode(statusCode) });
    }

    return { success: true, isGitRepo: true, statuses };
  } catch (error) {
    console.error('[Git Status] Error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getGitBranch(dirPath: string): Promise<{
  success: boolean;
  branch?: string;
  error?: string;
}> {
  try {
    if (!isPathSafe(dirPath)) {
      return { success: false, error: 'Invalid directory path' };
    }

    if (!(await isGitRepository(dirPath))) {
      return { success: true, branch: undefined };
    }

    const { stdout } = await execAsync('git branch --show-current', {
      cwd: dirPath,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });

    const branch = stdout.trim();

    if (!branch) {
      const { stdout: refStdout } = await execAsync('git rev-parse --short HEAD', {
        cwd: dirPath,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      return { success: true, branch: `HEAD:${refStdout.trim()}` };
    }

    return { success: true, branch };
  } catch (error) {
    console.error('[Git Branch] Error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
