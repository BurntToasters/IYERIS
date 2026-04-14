import { escapeHtml } from './shared.js';
import { convertFileSrc } from '@tauri-apps/api/core';
import pLimit from 'p-limit';

const PREVIEW_DATA_URL_CACHE_MAX = 64;
const previewDataUrlCache = new Map<string, string>();
const previewDataUrlLimiter = pLimit(2);

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
    if (parts.length > 0 && isWindowsPath(parts[0]!)) {
      return parts.join('\\').replace(/\\+/g, '\\');
    }
    return parts.join('/').replace(/\/+/g, '/');
  },
};

export function encodeFileUrl(filePath: string): string {
  return convertFileSrc(filePath);
}

function setPreviewDataUrlCache(filePath: string, dataUrl: string): void {
  if (previewDataUrlCache.has(filePath)) {
    previewDataUrlCache.delete(filePath);
  } else if (previewDataUrlCache.size >= PREVIEW_DATA_URL_CACHE_MAX) {
    const oldest = previewDataUrlCache.keys().next().value;
    if (oldest) {
      previewDataUrlCache.delete(oldest);
    }
  }
  previewDataUrlCache.set(filePath, dataUrl);
}

export async function getFileDataUrlWithCache(
  filePath: string,
  maxSize?: number
): Promise<string | null> {
  const cached = previewDataUrlCache.get(filePath);
  if (cached) {
    previewDataUrlCache.delete(filePath);
    previewDataUrlCache.set(filePath, cached);
    return cached;
  }

  return previewDataUrlLimiter(async () => {
    const result = await window.tauriAPI.getFileDataUrl(filePath, maxSize);
    if (!result.success || !result.dataUrl) {
      return null;
    }
    setPreviewDataUrlCache(filePath, result.dataUrl);
    return result.dataUrl;
  });
}

export function clearPreviewDataUrlCache(): void {
  previewDataUrlCache.clear();
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
  const src = `/twemoji/${codepoint}.svg`;
  const altText = escapeHtml(alt || emoji);
  return `<img src="${src}" class="${className}" alt="${altText}" draggable="false" loading="lazy" decoding="async" />`;
}
