import { escapeHtml } from './shared.js';

export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, '\\');
}

export const rendererPath = {
  basename: (filePath: string, ext?: string): string => {
    const name = filePath.split(/[\\/]/).pop() || '';
    if (ext && name.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
    return name;
  },
  dirname: (filePath: string): string => {
    if (!isWindowsPath(filePath)) {
      const normalized = filePath.replace(/\\/g, '/');
      const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
      if (!trimmed || trimmed === '/') return '/';
      const idx = trimmed.lastIndexOf('/');
      return idx <= 0 ? '/' : trimmed.slice(0, idx);
    }

    const normalized = normalizeWindowsPath(filePath);
    const trimmed = normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;

    if (trimmed.startsWith('\\\\')) {
      const parts = trimmed.split('\\').filter(Boolean);
      if (parts.length <= 2) {
        return `\\\\${parts.join('\\')}\\`;
      }
      return `\\\\${parts.slice(0, -1).join('\\')}`;
    }

    const driveMatch = trimmed.match(/^([A-Za-z]:)(\\.*)?$/);
    if (!driveMatch) return trimmed;
    const drive = driveMatch[1];
    const rest = (driveMatch[2] || '').replace(/\\+$/, '');
    if (!rest) return `${drive}\\`;
    const lastSep = rest.lastIndexOf('\\');
    if (lastSep <= 0) return `${drive}\\`;
    return `${drive}${rest.slice(0, lastSep)}`;
  },
  extname: (filePath: string): string => {
    const name = filePath.split(/[\\/]/).pop() || '';
    const dotIndex = name.lastIndexOf('.');
    return dotIndex === -1 ? '' : name.slice(dotIndex);
  },
  join: (...parts: string[]): string => {
    if (parts.length > 0 && isWindowsPath(parts[0])) {
      return parts.join('\\').replace(/\\+/g, '\\');
    }
    return parts.join('/').replace(/\/+/g, '/');
  },
};

export function encodeFileUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    const rest = normalizedPath.slice(2);
    const encodedRest = rest
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const normalizedRest = encodedRest.startsWith('/') ? encodedRest : `/${encodedRest}`;
    return `file:///${drive}${normalizedRest}`;
  }
  if (normalizedPath.startsWith('//')) {
    const uncPath = normalizedPath.slice(2);
    const encoded = uncPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `file://${encoded}`;
  }
  const encoded = normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file:///${encoded}`;
}

function emojiToCodepoint(emoji: string): string {
  const codePoints: number[] = [];
  let i = 0;
  while (i < emoji.length) {
    const code = emoji.codePointAt(i);
    if (code !== undefined) {
      if (code !== 0xfe0f) {
        codePoints.push(code);
      }
      i += code > 0xffff ? 2 : 1;
    } else {
      i++;
    }
  }
  return codePoints.map((cp) => cp.toString(16)).join('-');
}

export function twemojiImg(emoji: string, className: string = 'twemoji', alt?: string): string {
  const codepoint = emojiToCodepoint(emoji);
  const src = `../assets/twemoji/${codepoint}.svg`;
  const altText = escapeHtml(alt || emoji);
  return `<img src="${src}" class="${className}" alt="${altText}" draggable="false" loading="lazy" decoding="async" />`;
}
