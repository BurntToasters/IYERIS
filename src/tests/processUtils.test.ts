import { describe, it, expect } from 'vitest';
import { spawnWithTimeout, captureSpawnOutput, launchDetached } from '../processUtils';

describe('spawnWithTimeout', () => {
  it('spawns a command successfully', async () => {
    const { child, timedOut } = spawnWithTimeout('echo', ['hello'], 5000, {});
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });
    expect(code).toBe(0);
    expect(timedOut()).toBe(false);
  });

  it('reports timeout when command takes too long', async () => {
    const { child, timedOut } = spawnWithTimeout('sleep', ['10'], 100, {});
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });
    expect(timedOut()).toBe(true);
    expect(code).not.toBe(0);
  });

  it('clears timeout on error event', async () => {
    const { child, timedOut } = spawnWithTimeout('nonexistent_command_xyz', [], 5000, {});
    await new Promise<void>((resolve) => {
      child.on('error', () => resolve());
    });
    expect(timedOut()).toBe(false);
  });
});

describe('captureSpawnOutput', () => {
  it('captures stdout', async () => {
    const result = await captureSpawnOutput('echo', ['hello world'], 5000, {});
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const result = await captureSpawnOutput('sh', ['-c', 'echo error >&2'], 5000, {});
    expect(result.stderr.trim()).toBe('error');
  });

  it('returns exit code', async () => {
    const result = await captureSpawnOutput('sh', ['-c', 'exit 42'], 5000, {});
    expect(result.code).toBe(42);
  });

  it('handles timeout', async () => {
    const result = await captureSpawnOutput('sleep', ['10'], 100, {});
    expect(result.timedOut).toBe(true);
  });

  it('rejects on spawn error for nonexistent command', async () => {
    await expect(captureSpawnOutput('nonexistent_command_xyz', [], 5000, {})).rejects.toThrow();
  });
});

describe('launchDetached', () => {
  it('spawns a detached process without throwing', () => {
    expect(() => {
      launchDetached('echo', ['test'], {});
    }).not.toThrow();
  });
});
