import { app } from 'electron';
import { exec } from 'child_process';
import * as fsSync from 'fs';
import { logger } from './utils/logger';

let autoUpdaterModule: typeof import('electron-updater') | null = null;
let sevenBinModule: { path7za: string } | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sevenZipModule: any = null;

export function getAutoUpdater() {
  if (!autoUpdaterModule) {
    autoUpdaterModule = require('electron-updater');
  }
  return autoUpdaterModule!.autoUpdater;
}

export function get7zipBin(): { path7za: string } {
  if (!sevenBinModule) {
    sevenBinModule = require('7zip-bin');
  }
  return sevenBinModule!;
}

export function get7zipModule() {
  if (!sevenZipModule) {
    sevenZipModule = require('node-7z');
  }
  return sevenZipModule;
}

let isInFlatpak: boolean | null = null;
export function isRunningInFlatpak(): boolean {
  if (isInFlatpak === null) {
    isInFlatpak = process.env.FLATPAK_ID !== undefined || fsSync.existsSync('/.flatpak-info');
  }
  return isInFlatpak;
}

let msiCheckPromise: Promise<boolean> | null = null;
let msiCheckResult: boolean | null = null;

export function checkMsiInstallation(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (msiCheckResult !== null) return Promise.resolve(msiCheckResult);

  if (!msiCheckPromise) {
    msiCheckPromise = new Promise((resolve) => {
      exec(
        'reg query "HKCU\\Software\\IYERIS" /v InstalledViaMsi 2>nul',
        { encoding: 'utf8', windowsHide: true },
        (error, stdout) => {
          msiCheckResult = !error && stdout.includes('InstalledViaMsi') && stdout.includes('0x1');
          resolve(msiCheckResult);
        }
      );
    });
  }
  return msiCheckPromise;
}

export function isInstalledViaMsi(): boolean {
  return msiCheckResult === true;
}

let cached7zipPath: string | null = null;
export function get7zipPath(): string {
  if (cached7zipPath) {
    return cached7zipPath;
  }

  const sevenBin = get7zipBin();
  let sevenZipPath = sevenBin.path7za;

  if (app.isPackaged) {
    sevenZipPath = sevenZipPath.replace('app.asar', 'app.asar.unpacked');
  }

  logger.debug('[7zip] Using path:', sevenZipPath);
  cached7zipPath = sevenZipPath;
  return sevenZipPath;
}
