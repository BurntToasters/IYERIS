import { ipcMain, dialog, app, IpcMainInvokeEvent } from 'electron';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { getMainWindow } from './appState';
import { isPathSafe, getErrorMessage } from './security';
import { ignoreError } from './shared';
import { loadSettings } from './settingsManager';
import type { ApiResponse } from './types';
import { isTrustedIpcEvent } from './ipcUtils';

const execFilePromise = promisify(execFile);

interface ElevatedOperation {
  type: 'copy' | 'move' | 'delete' | 'rename' | 'createFolder' | 'createFile';
  sourcePath?: string;
  destPath?: string;
  newName?: string;
}

interface ElevatedResult {
  success: boolean;
  error?: string;
}

const OPERATION_TIMEOUT = 30000;
const activeElevatedProcesses: Set<ChildProcess> = new Set();

function generateOperationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function promptForElevation(operation: string, itemPath: string): Promise<boolean> {
  try {
    const settings = await loadSettings();
    if (settings.skipElevationConfirmation) {
      return true;
    }
  } catch (error) {
    ignoreError(error);
  }

  const mainWindow = getMainWindow();
  if (!mainWindow) return false;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Retry with Admin', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Permission Denied',
    message: `Cannot ${operation} this item`,
    detail: `"${path.basename(itemPath)}" requires administrator privileges.\n\nWould you like to retry with elevated permissions?`,
  });

  return response === 0;
}

function killElevatedProcess(): void {
  for (const proc of activeElevatedProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch (error) {
      ignoreError(error);
    }
  }
  activeElevatedProcesses.clear();
}

async function executeElevatedWindows(operation: ElevatedOperation): Promise<ElevatedResult> {
  let script: string;
  try {
    script = buildPowerShellScript(operation);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
  const token = generateOperationToken();
  const scriptPath = path.join(app.getPath('temp'), `iyeris-elevated-${token}.ps1`);

  try {
    await fs.writeFile(scriptPath, script, 'utf-8');

    const escapedScriptPath = scriptPath.replace(/'/g, "''");

    const { stdout, stderr } = await execFilePromise(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"'${escapedScriptPath}'" -Verb RunAs -Wait -PassThru | Select-Object -ExpandProperty ExitCode`,
      ],
      { timeout: OPERATION_TIMEOUT }
    );

    const trimmed = stdout.trim();
    if (!trimmed) {
      return { success: false, error: 'Operation cancelled by user' };
    }
    const exitCode = parseInt(trimmed, 10);
    if (isNaN(exitCode) || exitCode !== 0) {
      return { success: false, error: stderr || 'Operation failed' };
    }
    return { success: true };
  } finally {
    try {
      await fs.unlink(scriptPath);
    } catch (error) {
      ignoreError(error);
    }
  }
}

function buildPowerShellScript(op: ElevatedOperation): string {
  const escape = (s: string) => {
    if (s.includes('\0')) {
      throw new Error('Invalid null byte in path');
    }
    return s.replace(/'/g, "''");
  };
  switch (op.type) {
    case 'copy':
      return `try { Copy-Item -Path '${escape(op.sourcePath!)}' -Destination '${escape(op.destPath!)}' -Recurse -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    case 'move':
      return `try { Move-Item -Path '${escape(op.sourcePath!)}' -Destination '${escape(op.destPath!)}' -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    case 'delete':
      return `try { Remove-Item -Path '${escape(op.sourcePath!)}' -Recurse -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    case 'rename':
      return `try { Rename-Item -Path '${escape(op.sourcePath!)}' -NewName '${escape(op.newName!)}' -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    case 'createFolder':
      return `try { New-Item -Path '${escape(op.destPath!)}' -ItemType Directory -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    case 'createFile':
      return `try { New-Item -Path '${escape(op.destPath!)}' -ItemType File -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    default:
      return 'exit 1';
  }
}

async function executeElevatedMac(operation: ElevatedOperation): Promise<ElevatedResult> {
  let script: string;
  try {
    script = buildBashScript(operation);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
  const token = generateOperationToken();
  const scriptPath = path.join(app.getPath('temp'), `iyeris-elevated-${token}.sh`);

  try {
    await fs.writeFile(scriptPath, script, { mode: 0o700 });

    const escapedPath = scriptPath.replace(/'/g, "'\\''");
    const osascript = `do shell script "bash '${escapedPath}'" with administrator privileges`;

    await execFilePromise('osascript', ['-e', osascript], { timeout: OPERATION_TIMEOUT });
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes('User canceled') || message.includes('(-128)')) {
      return { success: false, error: 'Operation cancelled by user' };
    }
    return { success: false, error: 'Operation failed' };
  } finally {
    try {
      await fs.unlink(scriptPath);
    } catch (error) {
      ignoreError(error);
    }
  }
}

async function executeElevatedLinux(operation: ElevatedOperation): Promise<ElevatedResult> {
  let script: string;
  try {
    script = buildBashScript(operation);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
  const token = generateOperationToken();
  const scriptPath = path.join(app.getPath('temp'), `iyeris-elevated-${token}.sh`);

  try {
    await fs.writeFile(scriptPath, script, { mode: 0o700 });

    return new Promise((resolve) => {
      const child = spawn('pkexec', ['bash', scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeElevatedProcesses.add(child);
      let stderr = '';
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            child.kill('SIGKILL');
          } catch (error) {
            ignoreError(error);
          }
          activeElevatedProcesses.delete(child);
          fs.unlink(scriptPath).catch(() => {});
          resolve({ success: false, error: 'Operation timed out' });
        }
      }, OPERATION_TIMEOUT);

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', async (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        activeElevatedProcesses.delete(child);
        try {
          await fs.unlink(scriptPath);
        } catch (error) {
          ignoreError(error);
        }

        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || 'Operation failed or was cancelled' });
        }
      });

      child.on('error', async (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        activeElevatedProcesses.delete(child);
        try {
          await fs.unlink(scriptPath);
        } catch (error) {
          ignoreError(error);
        }
        resolve({ success: false, error: getErrorMessage(err) });
      });
    });
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}

function buildBashScript(op: ElevatedOperation): string {
  const escape = (s: string) => {
    if (s.includes('\0')) {
      throw new Error('Invalid null byte in path');
    }
    return s.replace(/'/g, "'\\''");
  };
  switch (op.type) {
    case 'copy':
      return `#!/bin/bash\nset -e\ncp -r '${escape(op.sourcePath!)}' '${escape(op.destPath!)}'`;
    case 'move':
      return `#!/bin/bash\nset -e\nmv '${escape(op.sourcePath!)}' '${escape(op.destPath!)}'`;
    case 'delete':
      return `#!/bin/bash\nset -e\nrm -rf '${escape(op.sourcePath!)}'`;
    case 'rename':
      if (op.newName!.includes('/') || op.newName!.includes('..')) {
        return '#!/bin/bash\nexit 1';
      }
      const dir = path.dirname(op.sourcePath!);
      const newPath = path.join(dir, op.newName!);
      return `#!/bin/bash\nset -e\nmv '${escape(op.sourcePath!)}' '${escape(newPath)}'`;
    case 'createFolder':
      return `#!/bin/bash\nset -e\nmkdir -p '${escape(op.destPath!)}'`;
    case 'createFile':
      return `#!/bin/bash\nset -e\ntouch '${escape(op.destPath!)}'`;
    default:
      return '#!/bin/bash\nexit 1';
  }
}

async function executeElevated(operation: ElevatedOperation): Promise<ElevatedResult> {
  if (['copy', 'move'].includes(operation.type) && (!operation.sourcePath || !operation.destPath)) {
    return { success: false, error: 'Missing required paths' };
  }
  if (['delete', 'rename'].includes(operation.type) && !operation.sourcePath) {
    return { success: false, error: 'Missing source path' };
  }
  if (operation.type === 'rename' && !operation.newName) {
    return { success: false, error: 'Missing new name' };
  }
  if (['createFolder', 'createFile'].includes(operation.type) && !operation.destPath) {
    return { success: false, error: 'Missing destination path' };
  }

  const platform = process.platform;

  if (platform === 'win32') {
    return await executeElevatedWindows(operation);
  } else if (platform === 'darwin') {
    return await executeElevatedMac(operation);
  } else if (platform === 'linux') {
    return await executeElevatedLinux(operation);
  }
  return { success: false, error: 'Unsupported platform' };
}

function isPermissionError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

export async function tryWithElevation<T>(
  operation: () => Promise<T>,
  elevatedOp: ElevatedOperation,
  operationName: string
): Promise<{ result?: T; elevated: boolean; error?: string }> {
  if (elevatedOp.sourcePath && !isPathSafe(elevatedOp.sourcePath)) {
    return { elevated: false, error: 'Invalid source path' };
  }
  if (elevatedOp.destPath && !isPathSafe(elevatedOp.destPath)) {
    return { elevated: false, error: 'Invalid destination path' };
  }
  if (
    elevatedOp.newName &&
    (elevatedOp.newName.includes('/') ||
      elevatedOp.newName.includes('\\') ||
      elevatedOp.newName.includes('..') ||
      elevatedOp.newName === '.' ||
      elevatedOp.newName === '')
  ) {
    return { elevated: false, error: 'Invalid name' };
  }

  try {
    const result = await operation();
    return { result, elevated: false };
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }

    const itemPath = elevatedOp.sourcePath || elevatedOp.destPath || '';
    const shouldElevate = await promptForElevation(operationName, itemPath);

    if (!shouldElevate) {
      return { elevated: false, error: 'Operation cancelled' };
    }

    const elevatedResult = await executeElevated(elevatedOp);
    if (!elevatedResult.success) {
      return { elevated: true, error: elevatedResult.error };
    }

    return { elevated: true };
  }
}

export function setupElevatedOperationHandlers(): void {
  ipcMain.handle(
    'elevated-copy',
    async (
      event: IpcMainInvokeEvent,
      sourcePath: string,
      destPath: string
    ): Promise<ApiResponse> => {
      if (!isTrustedIpcEvent(event, 'elevated-copy')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      if (!isPathSafe(sourcePath) || !isPathSafe(destPath)) {
        return { success: false, error: 'Invalid path' };
      }

      const result = await executeElevated({
        type: 'copy',
        sourcePath,
        destPath,
      });

      return result;
    }
  );

  ipcMain.handle(
    'elevated-move',
    async (
      event: IpcMainInvokeEvent,
      sourcePath: string,
      destPath: string
    ): Promise<ApiResponse> => {
      if (!isTrustedIpcEvent(event, 'elevated-move')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      if (!isPathSafe(sourcePath) || !isPathSafe(destPath)) {
        return { success: false, error: 'Invalid path' };
      }

      const result = await executeElevated({
        type: 'move',
        sourcePath,
        destPath,
      });

      return result;
    }
  );

  ipcMain.handle(
    'elevated-delete',
    async (event: IpcMainInvokeEvent, itemPath: string): Promise<ApiResponse> => {
      if (!isTrustedIpcEvent(event, 'elevated-delete')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      if (!isPathSafe(itemPath)) {
        return { success: false, error: 'Invalid path' };
      }

      const result = await executeElevated({
        type: 'delete',
        sourcePath: itemPath,
      });

      return result;
    }
  );

  ipcMain.handle(
    'elevated-rename',
    async (event: IpcMainInvokeEvent, itemPath: string, newName: string): Promise<ApiResponse> => {
      if (!isTrustedIpcEvent(event, 'elevated-rename')) {
        return { success: false, error: 'Untrusted IPC sender' };
      }
      if (!isPathSafe(itemPath)) {
        return { success: false, error: 'Invalid path' };
      }
      if (
        !newName ||
        newName.includes('/') ||
        newName.includes('\\') ||
        newName.includes('..') ||
        newName === '.'
      ) {
        return { success: false, error: 'Invalid name' };
      }

      const result = await executeElevated({
        type: 'rename',
        sourcePath: itemPath,
        newName,
      });

      return result;
    }
  );

  app.on('before-quit', () => {
    killElevatedProcess();
  });
}

export { isPermissionError, promptForElevation, executeElevated };
