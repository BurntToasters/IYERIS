import * as path from 'path';
export { escapeHtml, getErrorMessage } from './shared';

export function isPathSafe(
  inputPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!inputPath || typeof inputPath !== 'string') {
    return false;
  }

  if (inputPath.includes('\0')) {
    return false;
  }

  if (platform === 'win32') {
    const suspiciousChars = /[<>"|*?]/;
    if (suspiciousChars.test(inputPath)) {
      return false;
    }
  }

  const segments = inputPath.split(/[/\\]+/).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    return false;
  }

  const normalized =
    platform === 'win32' ? path.win32.normalize(inputPath) : path.normalize(inputPath);

  if (platform === 'win32') {
    const normalizedPath = normalized.replace(/\//g, '\\');
    const lowerPath = normalizedPath.toLowerCase();

    if (lowerPath.startsWith('\\\\?\\') || lowerPath.startsWith('\\\\.\\')) {
      return false;
    }

    const withoutDrive = normalizedPath.replace(/^[A-Za-z]:/, '');
    if (withoutDrive.includes(':')) {
      return false;
    }

    const parts = normalizedPath.split('\\').filter(Boolean);
    const isUnc = normalizedPath.startsWith('\\\\');
    if (isUnc && parts.length < 2) {
      return false;
    }

    const reservedNames = new Set([
      'con',
      'prn',
      'aux',
      'nul',
      'com1',
      'com2',
      'com3',
      'com4',
      'com5',
      'com6',
      'com7',
      'com8',
      'com9',
      'lpt1',
      'lpt2',
      'lpt3',
      'lpt4',
      'lpt5',
      'lpt6',
      'lpt7',
      'lpt8',
      'lpt9',
    ]);
    const startIndex = isUnc ? 2 : parts[0]?.includes(':') ? 1 : 0;
    for (let i = startIndex; i < parts.length; i++) {
      const part = parts[i];
      const trimmed = part.replace(/[ .]+$/g, '');
      if (!trimmed) {
        return false;
      }
      const base = trimmed.split('.')[0].toLowerCase();
      if (reservedNames.has(base)) {
        return false;
      }
      if (part.endsWith(' ') || part.endsWith('.')) {
        return false;
      }
    }

    const restrictedPaths = [
      'c:\\windows\\system32\\config\\sam',
      'c:\\windows\\system32\\config\\system',
      'c:\\windows\\system32\\config\\security',
    ];

    for (const restricted of restrictedPaths) {
      if (lowerPath === restricted || lowerPath.startsWith(restricted + '\\')) {
        return false;
      }
    }
  }

  return true;
}

const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'file:'];

export function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_URL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}
