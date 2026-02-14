import { spawn } from 'child_process';
import { ignoreError } from '../shared';

export type SpawnCaptureResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export function spawnWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  options: Parameters<typeof spawn>[2]
): { child: ReturnType<typeof spawn>; timedOut: () => boolean } {
  let didTimeout = false;
  const child = spawn(command, args, options);
  const timeout = setTimeout(() => {
    didTimeout = true;
    try {
      child.kill();
    } catch (error) {
      ignoreError(error);
    }
  }, timeoutMs);

  const clear = () => clearTimeout(timeout);
  child.on('close', clear);
  child.on('error', clear);

  return { child, timedOut: () => didTimeout };
}

export async function captureSpawnOutput(
  command: string,
  args: string[],
  timeoutMs: number,
  options: Parameters<typeof spawn>[2]
): Promise<SpawnCaptureResult> {
  const { child, timedOut } = spawnWithTimeout(command, args, timeoutMs, options);
  const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (data: Buffer) => {
    if (stdout.length < MAX_OUTPUT_BYTES) {
      stdout += data.toString();
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    if (stderr.length < MAX_OUTPUT_BYTES) {
      stderr += data.toString();
    }
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  return { code, stdout, stderr, timedOut: timedOut() };
}

export function launchDetached(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {}
): void {
  const child = spawn(command, args, {
    ...options,
    shell: options.shell ?? false,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', ignoreError);
  child.unref();
}
