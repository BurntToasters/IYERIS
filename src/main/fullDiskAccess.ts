import * as path from 'path';
import { promises as fs } from 'fs';
import { app, dialog } from 'electron';
import type { ApiResponse, Settings } from '../types';
import { getMainWindow } from './appState';
import { shell } from 'electron';
import { logger } from './logger';

export async function checkFullDiskAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    logger.info('[FDA] Not on macOS, skipping check');
    return true;
  }

  logger.info('[FDA] Testing Full Disk Access...');
  logger.info('[FDA] App path:', app.getPath('exe'));
  logger.info('[FDA] Process path:', process.execPath);

  try {
    const tccPath = path.join(
      app.getPath('home'),
      'Library',
      'Application Support',
      'com.apple.TCC',
      'TCC.db'
    );
    logger.info('[FDA] Testing TCC.db at:', tccPath);

    const fileHandle = await fs.open(tccPath, 'r');
    await fileHandle.close();

    logger.info('[FDA] Can read TCC.db');
    return true;
  } catch (error) {
    const err = error as { code?: string; message?: string };
    logger.info('[FDA] Cannot read TCC.db:', err.code || 'ERROR', '-', err.message);
  }

  const testPaths = [
    path.join(app.getPath('home'), 'Library', 'Safari'),
    path.join(app.getPath('home'), 'Library', 'Mail'),
    path.join(app.getPath('home'), 'Library', 'Messages'),
  ];

  for (const testPath of testPaths) {
    try {
      logger.info('[FDA] Testing:', testPath);
      const stats = await fs.stat(testPath);
      if (stats.isDirectory()) {
        const files = await fs.readdir(testPath);
        logger.info('[FDA] Full Disk Access (read', files.length, 'items from', testPath + '): OK');
        return true;
      }
    } catch (error) {
      const err = error as { code?: string; message?: string };
      logger.info('[FDA] Failed:', testPath, '-', err.code || err.message);
    }
  }

  logger.info('[FDA] Full Disk Access: NOT granted');
  return false;
}

export async function showFullDiskAccessDialog(
  loadSettings: () => Promise<Settings>,
  saveSettings: (settings: Settings) => Promise<ApiResponse>
): Promise<void> {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.info('[FDA] Cannot show dialog - no valid window');
    return;
  }
  logger.info('[FDA] Showing Full Disk Access dialog');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Full Disk Access Required',
    message: 'IYERIS needs Full Disk Access for full functionality',
    detail:
      'To browse all files and folders on your Mac without repeated permission prompts, IYERIS needs Full Disk Access.\n\n' +
      'How to grant access:\n' +
      '1. Click "Open Settings" below\n' +
      '2. Click the + button to add an app\n' +
      '3. Navigate to Applications and select IYERIS\n' +
      '4. Make sure the toggle next to IYERIS is ON\n' +
      '5. Restart IYERIS\n\n' +
      "Without this, you'll see permission prompts for each folder.",
    buttons: ['Open Settings', 'Remind Me Later', "Don't Ask Again"],
    defaultId: 0,
    cancelId: 1,
  });

  logger.info('[FDA] User selected option:', result.response);
  if (result.response === 0) {
    logger.info('[FDA] Opening System Settings...');
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  } else if (result.response === 2) {
    logger.info('[FDA] User: "Don\'t Ask Again"');
    const settings = await loadSettings();
    settings.skipFullDiskAccessPrompt = true;
    await saveSettings(settings);
  }
}
