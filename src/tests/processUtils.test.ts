import { describe, it, expect } from 'vitest';
import { spawnWithTimeout, captureSpawnOutput, launchDetached } from '../main/processUtils';

function shellCommand(
  unixScript: string,
  windowsScript: string
): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/d', '/s', '/c', windowsScript] };
  }
  return { command: 'sh', args: ['-c', unixScript] };
}

describe('spawnWithTimeout', () => {
  it('spawns a command successfully', async () => {
    const { command, args } = shellCommand('printf "hello\\n"', 'echo hello');
    const { child, timedOut } = spawnWithTimeout(command, args, 5000, {});
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });
    expect(code).toBe(0);
    expect(timedOut()).toBe(false);
  });

  it('reports timeout when command takes too long', async () => {
    const { command, args } = shellCommand('sleep 30', 'ping -n 30 127.0.0.1 >NUL');
    const { child, timedOut } = spawnWithTimeout(command, args, 100, {});
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
    const { command, args } = shellCommand('printf "hello world\\n"', 'echo hello world');
    const result = await captureSpawnOutput(command, args, 5000, {});
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const { command, args } = shellCommand('printf "error\\n" 1>&2', 'echo error 1>&2');
    const result = await captureSpawnOutput(command, args, 5000, {});
    expect(result.stderr.trim()).toBe('error');
  });

  it('returns exit code', async () => {
    const { command, args } = shellCommand('exit 42', 'exit /b 42');
    const result = await captureSpawnOutput(command, args, 5000, {});
    expect(result.code).toBe(42);
  });

  it('handles timeout', async () => {
    const { command, args } = shellCommand('sleep 30', 'ping -n 30 127.0.0.1 >NUL');
    const result = await captureSpawnOutput(command, args, 100, {});
    expect(result.timedOut).toBe(true);
  });

  it('rejects on spawn error for nonexistent command', async () => {
    await expect(captureSpawnOutput('nonexistent_command_xyz', [], 5000, {})).rejects.toThrow();
  });
});

describe('launchDetached', () => {
  it('spawns a detached process without throwing', () => {
    const { command, args } = shellCommand('exit 0', 'exit /b 0');
    expect(() => {
      launchDetached(command, args, {});
    }).not.toThrow();
  });
});
