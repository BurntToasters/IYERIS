import { convertFileSrc } from '@tauri-apps/api/core';
import pLimit from 'p-limit';
import * as lucide from 'lucide';
import type { IconNode } from 'lucide';
import { escapeHtml } from './shared.js';

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

const HEX_TO_LUCIDE: Record<string, string> = {
  '1f305': 'sunrise',
  '1f30a': 'waves',
  '1f310': 'globe',
  '1f319': 'moon',
  '1f31f': 'sparkles',
  '1f332': 'trees',
  '1f333': 'trees',
  '1f338': 'flower2',
  '1f33f': 'leaf',
  '1f352': 'apple',
  '1f34e': 'apple',
  '1f3a8': 'palette',
  '1f3ae': 'gamepad-2',
  '1f3b5': 'music',
  '1f3ac': 'clapperboard',
  '1f441': 'eye',
  '1f44b': 'hand',
  '1f499': 'heart',
  '1f49a': 'heart',
  '1f49b': 'heart',
  '1f49c': 'heart',
  '2764': 'heart',
  '1f4be': 'save',
  '1f4bf': 'database',
  '1f4c1': 'folder',
  '1f4c2': 'folder-open',
  '1f4c3': 'file-text',
  '1f4c4': 'file',
  '1f4c5': 'calendar',
  '1f4ca': 'bar-chart-3',
  '1f4cb': 'clipboard',
  '1f4cd': 'pin',
  '1f4d1': 'bookmark',
  '1f4dc': 'scroll',
  '1f4dd': 'file-text',
  '1f4da': 'library',
  '1f4d6': 'book-open',
  '1f4e4': 'upload',
  '1f4e5': 'download',
  '1f4e6': 'package',
  '1f503': 'refresh-cw',
  '1f504': 'refresh-ccw',
  '1f50d': 'search',
  '1f512': 'lock',
  '1f513': 'unlock',
  '1f5a5': 'monitor',
  '1f5c2': 'contact',
  '1f5c3': 'archive',
  '1f5c4': 'database',
  '1f5d1': 'trash-2',
  '1f5dc': 'folder-archive',
  '1f680': 'rocket',
  '1f69a': 'truck',
  '1f6e0': 'wrench',
  '1f9ec': 'flask-conical',
  '1f9ed': 'compass',
  '2139': 'info',
  '2328': 'keyboard',
  '267f': 'accessibility',
  '2699': 'settings',
  '26a0': 'alert-triangle',
  '2702': 'scissors',
  '270d': 'pen-tool',
  '270f': 'pencil',
  '2753': 'help-circle',
  '2795': 'plus',
  '2796': 'minus',
  '27a1': 'arrow-right',
  '2b50': 'star',
  '274c': 'x',
  '2705': 'check-circle',
  '1f5bc': 'image',
  '1f4f7': 'camera',
  '1f4f9': 'video',
  '1f532': 'home',
  // Unicode/character mappings from command palette or HTML:
  '2b1b': 'square',
  '2708': 'plane',
  '1f697': 'car',
  '1f6b2': 'bike',
  '26bd': 'trophy',
  '1f3c0': 'trophy',
  '2601': 'cloud',
  '2600': 'sun',
  '2b55': 'circle',
  '2716': 'x',
  '2b07': 'download',
  // Additional icons used in fileTypes.ts/file explorer
  '1f40d': 'file-code',
  '2615': 'coffee',
  a9: 'file-code',
  '1f418': 'file-code',
  '1f48e': 'gem',
  '1f439': 'file-code',
  '1f980': 'file-code',
};

function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function camelToKebab(str: string): string {
  if (str === 'viewBox') return 'viewBox';
  return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase();
}

function escapeSvgAttr(value: unknown): string {
  return escapeHtml(String(value));
}

function iconToSvg(icon: IconNode, extraAttrs: Record<string, string> = {}): string {
  if (!icon || !Array.isArray(icon)) return '';

  const defaultAttrs: Record<string, string> = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };

  const combinedAttrs = { ...defaultAttrs, ...extraAttrs };

  const attrStr = Object.entries(combinedAttrs)
    .map(([k, v]) => {
      const kebabKey = camelToKebab(k);
      return `${kebabKey}="${escapeSvgAttr(v)}"`;
    })
    .join(' ');

  const childrenStr = icon
    .map(([childTag, childAttrs]) => {
      const childAttrStr = Object.entries(childAttrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => {
          const kebabKey = camelToKebab(k);
          return `${kebabKey}="${escapeSvgAttr(v)}"`;
        })
        .join(' ');
      return `<${childTag} ${childAttrStr}></${childTag}>`;
    })
    .join('');

  return `<svg ${attrStr}>${childrenStr}</svg>`;
}

export function normalizeIconName(nameOrEmoji: string): string {
  const iconName = nameOrEmoji.toLowerCase().trim();
  if (HEX_TO_LUCIDE[iconName]) {
    return HEX_TO_LUCIDE[iconName]!;
  }
  const codepoint = emojiToCodepoint(nameOrEmoji);
  if (HEX_TO_LUCIDE[codepoint]) {
    return HEX_TO_LUCIDE[codepoint]!;
  }
  return iconName;
}

export function renderIcon(
  nameOrEmoji: string,
  className: string = 'lucide-icon',
  alt?: string
): string {
  const iconName = normalizeIconName(nameOrEmoji);
  const pascalName = toPascalCase(iconName);
  const icon = (lucide as unknown as Record<string, IconNode>)[pascalName] || lucide.File;

  return iconToSvg(icon, { class: className.trim(), 'aria-label': alt || iconName });
}

export function twemojiImg(emoji: string, className: string = 'twemoji', alt?: string): string {
  return renderIcon(emoji, className, alt);
}

export async function openFileWithFeedback(
  filePath: string,
  showToast: (message: string, title: string, type: 'success' | 'error' | 'info') => void
): Promise<void> {
  const result = await window.tauriAPI.openFile(filePath);
  if (!result.success) {
    showToast(result.error || 'Failed to open file', 'Open File', 'error');
  }
}
