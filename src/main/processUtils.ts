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
  options: Parameters<typeof spawn>[2] = {}
): { child: ReturnType<typeof spawn>; timedOut: () => boolean } {
  let didTimeout = false;
  const child = spawn(command, args, {
    ...options,
    shell: options.shell ?? false,
    stdio: options.stdio ?? 'pipe',
  });
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
  options: Parameters<typeof spawn>[2] = {}
): Promise<SpawnCaptureResult> {
  const { child, timedOut } = spawnWithTimeout(command, args, timeoutMs, options);
  const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const appendChunk = (chunk: Buffer | string, sink: 'stdout' | 'stderr'): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    const currentBytes = sink === 'stdout' ? stdoutBytes : stderrBytes;
    if (currentBytes >= MAX_OUTPUT_BYTES) {
      return;
    }
    const chunkBytes = Buffer.byteLength(text);
    const remainingBytes = MAX_OUTPUT_BYTES - currentBytes;
    if (chunkBytes <= remainingBytes) {
      if (sink === 'stdout') {
        stdout += text;
        stdoutBytes += chunkBytes;
      } else {
        stderr += text;
        stderrBytes += chunkBytes;
      }
      return;
    }

    const truncated = Buffer.from(text).subarray(0, remainingBytes).toString();
    if (sink === 'stdout') {
      stdout += truncated;
      stdoutBytes = MAX_OUTPUT_BYTES;
    } else {
      stderr += truncated;
      stderrBytes = MAX_OUTPUT_BYTES;
    }
  };

  const waitForStreamCompletion = (
    stream: NodeJS.ReadableStream | null | undefined
  ): Promise<void> => {
    if (!stream) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      stream.once('end', finish);
      stream.once('close', finish);
      stream.once('error', finish);
    });
  };

  child.stdout?.on('data', (data: Buffer) => {
    appendChunk(data, 'stdout');
  });
  child.stderr?.on('data', (data: Buffer) => {
    appendChunk(data, 'stderr');
  });

  const stdoutDone = waitForStreamCompletion(child.stdout);
  const stderrDone = waitForStreamCompletion(child.stderr);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await Promise.all([stdoutDone, stderrDone]);

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
