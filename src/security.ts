import * as path from 'path';

export function escapeHtml(text: unknown): string {
  if (text === null || text === undefined) return '';
  const str = String(text);
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, (m) => map[m]);
}

export function isPathSafe(inputPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!inputPath || typeof inputPath !== 'string') {
    return false;
  }

  if (inputPath.includes('\0')) {
    return false;
  }

  const suspiciousChars = /[<>"|*?]/;
  if (suspiciousChars.test(inputPath)) {
    return false;
  }

  if (inputPath.includes('..')) {
    return false;
  }

  const normalized = path.normalize(inputPath);

  if (platform === 'win32' && normalized.startsWith('\\\\')) {
    const parts = normalized.split('\\').filter(Boolean);
    if (parts.length < 1) {
      return false;
    }
  }

  if (platform === 'win32') {
    const lowerPath = inputPath.toLowerCase().replace(/\//g, '\\');
    const restrictedPaths = [
      'c:\\windows\\system32\\config\\sam',
      'c:\\windows\\system32\\config\\system',
      'c:\\windows\\system32\\config\\security'
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

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
