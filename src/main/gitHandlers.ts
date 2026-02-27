import * as path from 'path';
import { isPathSafe } from './security';
import { ignoreError } from '../shared';
import { spawnWithTimeout, captureSpawnOutput } from './processUtils';
import { logger } from './logger';

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
    const result = await captureSpawnOutput('git', ['rev-parse', '--git-dir'], 5000, {
      cwd: dirPath,
      windowsHide: true,
    });
    return result.code === 0;
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
    logger.error('[Git Status] Error:', error);
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

    const branchResult = await captureSpawnOutput('git', ['branch', '--show-current'], 10000, {
      cwd: dirPath,
      windowsHide: true,
    });

    if (branchResult.code !== 0) {
      return { success: false, error: branchResult.stderr.trim() || 'Failed to get branch' };
    }

    const branch = branchResult.stdout.trim();

    if (!branch) {
      const refResult = await captureSpawnOutput('git', ['rev-parse', '--short', 'HEAD'], 10000, {
        cwd: dirPath,
        windowsHide: true,
      });
      return { success: true, branch: `HEAD:${refResult.stdout.trim()}` };
    }

    return { success: true, branch };
  } catch (error) {
    logger.error('[Git Branch] Error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
