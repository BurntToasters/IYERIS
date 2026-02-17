import { EventEmitter } from 'events';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecResponse = {
  error?: Error | null;
  stdout?: string;
  stderr?: string;
};

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('../main/processUtils', () => ({
  spawnWithTimeout: vi.fn(),
}));

vi.mock('../main/security', () => ({
  isPathSafe: vi.fn(() => true),
}));

vi.mock('../shared', () => ({
  ignoreError: vi.fn(),
}));

import { exec } from 'child_process';
import { spawnWithTimeout } from '../main/processUtils';
import { isPathSafe } from '../main/security';
import { getGitBranch, getGitStatus } from '../main/gitHandlers';

function setExecResponses(responses: ExecResponse[]): void {
  const queue = [...responses];
  vi.mocked(exec).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    if (typeof cb !== 'function') {
      throw new Error('Expected callback in exec mock');
    }
    const next = queue.shift() || {};
    queueMicrotask(() => {
      cb(
        next.error ?? null,
        { stdout: next.stdout ?? '', stderr: next.stderr ?? '' } as unknown as string,
        ''
      );
    });
    return {} as never;
  });
}

describe('gitHandlers', () => {
  beforeEach(() => {
    vi.mocked(exec).mockReset();
    vi.mocked(spawnWithTimeout).mockReset();
    vi.mocked(isPathSafe).mockReturnValue(true);
  });

  it('rejects invalid paths', async () => {
    vi.mocked(isPathSafe).mockReturnValue(false);

    const status = await getGitStatus('/bad/path');
    const branch = await getGitBranch('/bad/path');

    expect(status).toEqual({ success: false, error: 'Invalid directory path' });
    expect(branch).toEqual({ success: false, error: 'Invalid directory path' });
  });

  it('returns non-repo status when git metadata is missing', async () => {
    setExecResponses([{ error: new Error('not a git repo') }]);

    const result = await getGitStatus('/tmp/project');

    expect(result).toEqual({ success: true, isGitRepo: false, statuses: [] });
    expect(spawnWithTimeout).not.toHaveBeenCalled();
  });

  it('parses porcelain status output and rename pairs', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as unknown as import('child_process').ChildProcess,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project', false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.stdout.emit(
      'data',
      Buffer.from(
        '?? new.txt\0R  old.txt\0renamed.txt\0UU conflict.txt\0D  deleted.txt\0M  modified.txt\0'
      )
    );
    child.emit('close', 0);

    const result = await promise;

    expect(spawnWithTimeout).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '-z', '-uno'],
      30000,
      { cwd: '/tmp/project', windowsHide: true, shell: false }
    );
    expect(result).toEqual({
      success: true,
      isGitRepo: true,
      statuses: [
        { path: path.join('/tmp/project', 'new.txt'), status: 'untracked' },
        { path: path.join('/tmp/project', 'renamed.txt'), status: 'renamed' },
        { path: path.join('/tmp/project', 'conflict.txt'), status: 'conflict' },
        { path: path.join('/tmp/project', 'deleted.txt'), status: 'deleted' },
        { path: path.join('/tmp/project', 'modified.txt'), status: 'modified' },
      ],
    });
  });

  it('returns error on timeout during git status', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as unknown as import('child_process').ChildProcess,
      timedOut: () => true,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emit('close', 0);

    const result = await promise;

    expect(result).toEqual({ success: false, error: 'Git status timed out' });
  });

  it('returns branch name for attached HEAD', async () => {
    setExecResponses([{ stdout: '.git\n' }, { stdout: 'feature/test\n' }]);

    const result = await getGitBranch('/tmp/project');

    expect(result).toEqual({ success: true, branch: 'feature/test' });
  });

  it('falls back to short HEAD when branch name is empty', async () => {
    setExecResponses([{ stdout: '.git\n' }, { stdout: '\n' }, { stdout: 'abc123\n' }]);

    const result = await getGitBranch('/tmp/project');

    expect(result).toEqual({ success: true, branch: 'HEAD:abc123' });
  });

  it('returns undefined branch when repo check fails', async () => {
    setExecResponses([{ error: new Error('not repo') }]);

    const result = await getGitBranch('/tmp/project');

    expect(result).toEqual({ success: true, branch: undefined });
  });
});
