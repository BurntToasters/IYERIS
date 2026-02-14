import { app } from 'electron';
import { exec } from 'child_process';
import * as fsSync from 'fs';
import { logger } from './logger';

let autoUpdaterModule: typeof import('electron-updater') | null = null;
let sevenBinModule: { path7za: string } | null = null;

type SevenZipListData = {
  file?: string;
  size?: number;
  attributes?: string;
  attr?: string;
  type?: string;
  link?: string;
  symlink?: string;
  symbolicLink?: string;
  [key: string]: unknown;
};

type SevenZipListProcess = {
  on(event: 'data', callback: (data: SevenZipListData) => void): void;
  on(event: 'end', callback: () => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
};

type SevenZipArchiveProcess = {
  on(event: 'progress', callback: (progress: { file?: string }) => void): void;
  on(event: 'end', callback: () => void): void;
  on(event: 'error', callback: (error: { message?: string; level?: string }) => void): void;
  _childProcess?: { kill: (signal: string) => void };
  cancel?: () => void;
};

type SevenZipModule = {
  list: (archivePath: string, options: { $bin: string }) => SevenZipListProcess;
  add: (
    archivePath: string,
    sourcePaths: string[] | string,
    options: { $bin: string; recursive?: boolean; $raw?: string[] }
  ) => SevenZipArchiveProcess;
  extractFull: (
    archivePath: string,
    destPath: string,
    options: { $bin: string; recursive?: boolean }
  ) => SevenZipArchiveProcess;
};
let sevenZipModule: SevenZipModule | null = null;

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

export function get7zipModule(): SevenZipModule {
  if (!sevenZipModule) {
    sevenZipModule = require('node-7z') as SevenZipModule;
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
