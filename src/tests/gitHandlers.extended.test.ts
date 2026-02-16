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

describe('gitHandlers – extended coverage', () => {
  beforeEach(() => {
    vi.mocked(exec).mockReset();
    vi.mocked(spawnWithTimeout).mockReset();
    vi.mocked(isPathSafe).mockReturnValue(true);
  });

  it('returns error when git status exits with non-zero code and stderr', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.stderr.emit('data', Buffer.from('fatal: bad revision'));
    child.emit('close', 128);

    const result = await promise;

    expect(result).toEqual({ success: false, error: 'fatal: bad revision' });
  });

  it('returns error when git status exits with non-zero code and no stderr', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.emit('close', 1);

    const result = await promise;

    expect(result).toEqual({ success: false, error: 'Git status failed' });
  });

  it('returns error when execAsync for branch throws after repo confirmed', async () => {
    setExecResponses([{ stdout: '.git\n' }, { error: new Error('git branch failed') }]);

    const result = await getGitBranch('/tmp/project');

    expect(result).toEqual({ success: false, error: 'git branch failed' });
  });

  it('returns error when git status output is truncated', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hugeBuffer = Buffer.alloc(21 * 1024 * 1024, 'x');
    child.stdout.emit('data', hugeBuffer);

    child.emit('close', null);

    const result = await promise;

    expect(child.kill).toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Git status output too large' });
  });

  it('returns error when git process emits an error event', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.emit('error', new Error('spawn ENOENT'));

    const result = await promise;

    expect(result).toEqual({ success: false, error: 'spawn ENOENT' });
  });

  it('maps ignored status code correctly', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.stdout.emit('data', Buffer.from('!! ignored.log\0'));
    child.emit('close', 0);

    const result = await promise;

    expect(result.statuses).toEqual([
      { path: path.join('/tmp/project', 'ignored.log'), status: 'ignored' },
    ]);
  });

  it('maps AA and DD conflict codes correctly', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.stdout.emit('data', Buffer.from('AA both.txt\0DD gone.txt\0'));
    child.emit('close', 0);

    const result = await promise;

    expect(result.statuses).toEqual([
      { path: path.join('/tmp/project', 'both.txt'), status: 'conflict' },
      { path: path.join('/tmp/project', 'gone.txt'), status: 'conflict' },
    ]);
  });

  it('maps C (copied) status code as added', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.stdout.emit('data', Buffer.from('C  source.txt\0copy.txt\0'));
    child.emit('close', 0);

    const result = await promise;

    expect(result.statuses).toEqual([
      { path: path.join('/tmp/project', 'copy.txt'), status: 'added' },
    ]);
  });

  it('skips entries shorter than 3 characters', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.stdout.emit('data', Buffer.from('M  valid.txt\0ab\0'));
    child.emit('close', 0);

    const result = await promise;

    expect(result.statuses).toEqual([
      { path: path.join('/tmp/project', 'valid.txt'), status: 'modified' },
    ]);
  });

  it('includes untracked files by default', async () => {
    setExecResponses([{ stdout: '.git\n' }]);
    const child = new FakeChildProcess();
    vi.mocked(spawnWithTimeout).mockReturnValue({
      child: child as any,
      timedOut: () => false,
    });

    const promise = getGitStatus('/tmp/project');
    await new Promise((resolve) => setTimeout(resolve, 0));

    child.stdout.emit('data', Buffer.from(''));
    child.emit('close', 0);

    await promise;

    expect(spawnWithTimeout).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '-z', '-uall'],
      30000,
      { cwd: '/tmp/project', windowsHide: true, shell: false }
    );
  });
});
