import * as path from 'path';
import { promises as fs } from 'fs';
import type * as fsSync from 'fs';
import type { AdvancedCompressOptions } from '../types';
import { get7zipModule, get7zipPath } from './platformUtils';
import { logger } from './logger';

const SAFE_METHOD_VALUES = new Set([
  'LZMA',
  'LZMA2',
  'PPMd',
  'BZip2',
  'Deflate',
  'Deflate64',
  'Copy',
]);
const ZIP_METHODS_WITH_DICTIONARY = new Set(['LZMA', 'PPMd']);
const SAFE_SIZE_RE = /^\d{1,5}[kmg]?$/i;
const SAFE_THREADS_RE = /^[1-9]\d{0,1}$/;
const SAFE_ENCRYPTION_METHODS = new Set(['AES256', 'ZipCrypto']);

export function buildAdvancedRawFlags(
  opts: AdvancedCompressOptions | undefined,
  format: string
): string[] {
  const flags: string[] = [];
  if (!opts) return flags;

  if (typeof opts.compressionLevel === 'number' && Number.isFinite(opts.compressionLevel)) {
    const level = Math.max(0, Math.min(9, Math.round(opts.compressionLevel)));
    flags.push(`-mx=${level}`);
  }

  const safeMethod =
    typeof opts.method === 'string' && SAFE_METHOD_VALUES.has(opts.method) ? opts.method : null;

  if (safeMethod) {
    flags.push(format === 'zip' ? `-mm=${safeMethod}` : `-m0=${safeMethod}`);
  }

  if (opts.dictionarySize && SAFE_SIZE_RE.test(opts.dictionarySize)) {
    if (format === 'zip') {
      if (safeMethod && ZIP_METHODS_WITH_DICTIONARY.has(safeMethod)) {
        flags.push(`-md=${opts.dictionarySize}`);
      }
    } else {
      flags.push(`-md=${opts.dictionarySize}`);
    }
  }

  if (format === '7z') {
    if (opts.solidBlockSize === 'on' || opts.solidBlockSize === 'off') {
      flags.push(`-ms=${opts.solidBlockSize}`);
    } else if (opts.solidBlockSize && SAFE_SIZE_RE.test(opts.solidBlockSize)) {
      flags.push(`-ms=${opts.solidBlockSize}`);
    }
  }

  if (opts.cpuThreads && SAFE_THREADS_RE.test(opts.cpuThreads)) {
    flags.push(`-mmt=${opts.cpuThreads}`);
  }

  if (opts.password && opts.password.length > 0) {
    flags.push(`-p${opts.password}`);
    if (format === '7z' && opts.encryptFileNames) {
      flags.push('-mhe=on');
    }
    if (format === 'zip') {
      const safeEncryptionMethod =
        opts.encryptionMethod && SAFE_ENCRYPTION_METHODS.has(opts.encryptionMethod)
          ? opts.encryptionMethod
          : 'AES256';
      flags.push(`-mem=${safeEncryptionMethod}`);
    }
  }

  if (opts.splitVolume && SAFE_SIZE_RE.test(opts.splitVolume)) {
    flags.push(`-v${opts.splitVolume}`);
  }

  return flags;
}

export async function assertArchiveEntriesSafe(
  archivePath: string,
  destPath: string
): Promise<void> {
  const Seven = get7zipModule();
  const sevenZipPath = get7zipPath();

  const entries = await new Promise<
    Array<{
      name: string;
      attributes?: string;
      type?: string;
      link?: string;
      symlink?: string;
      symbolicLink?: string;
    }>
  >((resolve, reject) => {
    const list = Seven.list(archivePath, { $bin: sevenZipPath });
    const items: Array<{
      name: string;
      attributes?: string;
      type?: string;
      link?: string;
      symlink?: string;
      symbolicLink?: string;
    }> = [];

    list.on(
      'data',
      (data: { file?: string; attributes?: string; type?: string; [key: string]: unknown }) => {
        if (data && data.file) {
          const attr = data.attributes ?? (typeof data.attr === 'string' ? data.attr : undefined);
          const link = typeof data.link === 'string' ? data.link : undefined;
          const symlink = typeof data.symlink === 'string' ? data.symlink : undefined;
          const symbolicLink =
            typeof data.symbolicLink === 'string' ? data.symbolicLink : undefined;

          items.push({
            name: String(data.file),
            attributes: attr,
            type: data.type,
            link,
            symlink,
            symbolicLink,
          });
        }
      }
    );
    list.on('end', () => resolve(items));
    list.on('error', (err: Error) => reject(err));
  });

  const destRoot = await fs.realpath(path.resolve(destPath));
  const destRootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    if (!entry || !entry.name) continue;

    const attr = (entry.attributes || '').toUpperCase();
    const type = (entry.type || '').toLowerCase();
    const isLink =
      attr.includes('L') ||
      type.includes('link') ||
      Boolean(entry.link) ||
      Boolean(entry.symlink) ||
      Boolean(entry.symbolicLink);
    if (isLink) {
      invalidEntries.push(entry.name);
      continue;
    }

    const normalized = entry.name.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) continue;
    if (
      normalized.startsWith('/') ||
      normalized.startsWith('//') ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      invalidEntries.push(entry.name);
      continue;
    }
    const parts = normalized.split('/');
    if (parts.some((part) => part === '..')) {
      invalidEntries.push(entry.name);
      continue;
    }

    const targetPath = path.resolve(destRoot, normalized);
    if (targetPath !== destRoot && !targetPath.startsWith(destRootWithSep)) {
      invalidEntries.push(entry.name);
    }
  }

  if (invalidEntries.length > 0) {
    const preview = invalidEntries.slice(0, 5).join(', ');
    throw new Error(
      `Archive contains unsafe paths: ${preview}${invalidEntries.length > 5 ? '...' : ''}`
    );
  }
}

export async function assertExtractedPathsSafe(destPath: string): Promise<void> {
  const destRoot = await fs.realpath(destPath);
  const destRootWithSep = destRoot.endsWith(path.sep) ? destRoot : destRoot + path.sep;
  const unsafe: string[] = [];
  const stack: string[] = [destRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const BATCH_SIZE = 20;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const fullPath = path.join(current, entry.name);
          let stat: fsSync.Stats;
          try {
            stat = await fs.lstat(fullPath);
          } catch {
            return null;
          }

          if (stat.isSymbolicLink()) {
            unsafe.push(fullPath);
            try {
              await fs.unlink(fullPath);
            } catch (error) {
              logger.error('[Archive] Failed to remove symlink:', fullPath, error);
            }
            return null;
          }

          if (stat.isFile() && stat.nlink > 1) {
            unsafe.push(fullPath);
            try {
              await fs.rm(fullPath, { force: true });
            } catch (error) {
              logger.error('[Archive] Failed to remove hardlinked file:', fullPath, error);
            }
            return null;
          }

          let realPath: string;
          try {
            realPath = await fs.realpath(fullPath);
          } catch (error) {
            unsafe.push(fullPath);
            logger.error('[Archive] Failed to resolve realpath for:', fullPath, error);
            try {
              await fs.rm(fullPath, { recursive: true, force: true });
            } catch (rmError) {
              logger.error('[Archive] Failed to remove unsafe path:', fullPath, rmError);
            }
            return null;
          }

          if (realPath !== destRoot && !realPath.startsWith(destRootWithSep)) {
            unsafe.push(fullPath);
            try {
              await fs.rm(fullPath, { recursive: true, force: true });
            } catch (error) {
              logger.error('[Archive] Failed to remove path outside destination:', fullPath, error);
            }
            return null;
          }

          if (stat.isDirectory()) {
            return fullPath;
          }
          return null;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          stack.push(result.value);
        }
      }
    }
  }

  if (unsafe.length > 0) {
    const preview = unsafe.slice(0, 5).join(', ');
    throw new Error(
      `Archive extraction created unsafe paths: ${preview}${unsafe.length > 5 ? '...' : ''}`
    );
  }
}
