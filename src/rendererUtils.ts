import { convertFileSrc } from '@tauri-apps/api/core';
import pLimit from 'p-limit';
import {
  Accessibility,
  Activity,
  AlertTriangle,
  Apple,
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Ban,
  Bike,
  Binary,
  BookOpen,
  Bookmark,
  Briefcase,
  Building,
  Calendar,
  Camera,
  Car,
  CheckCircle,
  CheckSquare,
  Circle,
  Clapperboard,
  Clipboard,
  Cloud,
  Coffee,
  Columns3,
  Compass,
  Contact,
  Copy,
  Database,
  Download,
  Eye,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Files,
  FlaskConical,
  Flower2,
  Folder,
  FolderArchive,
  FolderOpen,
  Gamepad2,
  Gem,
  Globe,
  Hand,
  Hash,
  Heart,
  HelpCircle,
  Home,
  Image,
  Inbox,
  Info,
  Key,
  Keyboard,
  Laptop,
  Leaf,
  LayoutGrid,
  LayoutList,
  Library,
  Link,
  Lightbulb,
  Lock,
  Minus,
  Monitor,
  Moon,
  Music,
  Package,
  Palette,
  PenTool,
  Pencil,
  Pin,
  Plane,
  Plus,
  RefreshCcw,
  RefreshCw,
  Rocket,
  Save,
  Scissors,
  Scroll,
  Search,
  Settings,
  Sidebar,
  Sparkles,
  Square,
  Star,
  Sun,
  Sunrise,
  Trees,
  Trash2,
  Trophy,
  Truck,
  Unlock,
  Upload,
  Video,
  Waves,
  Wrench,
  X,
  XCircle,
} from 'lucide';
import type { IconNode } from 'lucide';
import { escapeHtml } from './shared.js';

const PREVIEW_DATA_URL_CACHE_MAX = 64;
const PREVIEW_DATA_URL_CACHE_MEMORY_MAX = 128 * 1024 * 1024;
const MAX_PREVIEW_REQUEST_BYTES = 50 * 1024 * 1024;

export interface PreviewDataUrlRequest {
  maxBytes: number;
  fingerprint: string;
}

export function createPreviewDataUrlRequest(
  file: { size: number; modified: Date | number | string },
  maxBytes: number
): PreviewDataUrlRequest {
  const modified =
    file.modified instanceof Date ? file.modified.getTime() : new Date(file.modified).getTime();
  return {
    maxBytes,
    fingerprint: `${file.size}:${Number.isFinite(modified) ? modified : String(file.modified)}`,
  };
}

interface PreviewDataUrlCacheEntry extends PreviewDataUrlRequest {
  dataUrl: string;
  estimatedBytes: number;
}

export class PreviewDataUrlCache {
  readonly #entries = new Map<string, PreviewDataUrlCacheEntry>();
  #estimatedBytes = 0;

  constructor(
    readonly maxEntries: number,
    readonly memoryBudgetBytes: number
  ) {}

  get(filePath: string, request: PreviewDataUrlRequest): string | null {
    const entry = this.#entries.get(filePath);
    if (!entry) return null;
    if (entry.fingerprint !== request.fingerprint || entry.maxBytes > request.maxBytes) {
      this.delete(filePath);
      return null;
    }
    this.#entries.delete(filePath);
    this.#entries.set(filePath, entry);
    return entry.dataUrl;
  }

  set(filePath: string, dataUrl: string, request: PreviewDataUrlRequest): void {
    if (!isSafePreviewDataUrl(dataUrl, request.maxBytes)) return;
    const estimatedBytes = dataUrl.length * 2;
    this.delete(filePath);
    if (estimatedBytes > this.memoryBudgetBytes) return;

    this.#entries.set(filePath, { ...request, dataUrl, estimatedBytes });
    this.#estimatedBytes += estimatedBytes;
    while (this.#entries.size > this.maxEntries || this.#estimatedBytes > this.memoryBudgetBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#estimatedBytes = 0;
  }

  private delete(filePath: string): void {
    const entry = this.#entries.get(filePath);
    if (!entry) return;
    this.#entries.delete(filePath);
    this.#estimatedBytes -= entry.estimatedBytes;
  }
}

function isSafePreviewDataUrl(dataUrl: string, maxBytes: number): boolean {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return false;
  // Keep the renderer-side payload bounded even if a compromised/malformed
  // IPC response bypasses the native size limit. Base64 expands by at most
  // 4/3; the looser factor also covers URL-encoded text and metadata.
  // eslint-disable-next-line no-control-regex -- reject control characters in IPC data URLs
  return dataUrl.length <= maxBytes * 2 + 1024 && !/[\u0000-\u001f\u007f]/u.test(dataUrl);
}

const previewDataUrlCache = new PreviewDataUrlCache(
  PREVIEW_DATA_URL_CACHE_MAX,
  PREVIEW_DATA_URL_CACHE_MEMORY_MAX
);
const pendingPreviewDataUrls = new Map<string, Promise<string | null>>();
const pendingPreviewDataUrlCounts = new Map<string, number>();
const latestPreviewDataUrlRequests = new Map<string, string>();
const previewDataUrlLimiter = pLimit(2);
let previewDataUrlCacheGeneration = 0;

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
      const joined = parts.join('\\').replace(/\//g, '\\');
      return (
        (joined.startsWith('\\\\') ? '\\\\' : '') + joined.replace(/^\\+/, '').replace(/\\+/g, '\\')
      );
    }
    return parts.join('/').replace(/\/+/g, '/');
  },
};

export function encodeFileUrl(filePath: string): string {
  return convertFileSrc(filePath);
}

export async function getFileDataUrlWithCache(
  filePath: string,
  request: PreviewDataUrlRequest
): Promise<string | null> {
  if (
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes <= 0 ||
    request.maxBytes > MAX_PREVIEW_REQUEST_BYTES ||
    typeof request.fingerprint !== 'string' ||
    request.fingerprint.trim().length === 0 ||
    request.fingerprint.length > 256
  ) {
    throw new RangeError('Preview requests require a positive maxBytes and file fingerprint');
  }

  const pendingKey = `${filePath}\0${request.fingerprint}\0${request.maxBytes}`;
  const cached = previewDataUrlCache.get(filePath, request);
  if (cached) {
    if ((pendingPreviewDataUrlCounts.get(filePath) ?? 0) > 0) {
      latestPreviewDataUrlRequests.set(filePath, pendingKey);
    }
    return cached;
  }

  latestPreviewDataUrlRequests.set(filePath, pendingKey);
  const pending = pendingPreviewDataUrls.get(pendingKey);
  if (pending) return pending;

  const generation = previewDataUrlCacheGeneration;
  pendingPreviewDataUrlCounts.set(filePath, (pendingPreviewDataUrlCounts.get(filePath) ?? 0) + 1);
  const read = previewDataUrlLimiter(async () => {
    const result = await window.tauriAPI.getFileDataUrl(filePath, request.maxBytes);
    if (!result.success || !result.dataUrl) {
      return null;
    }
    if (!isSafePreviewDataUrl(result.dataUrl, request.maxBytes)) {
      throw new Error('Native preview response was not a valid bounded data URL');
    }
    if (
      generation === previewDataUrlCacheGeneration &&
      latestPreviewDataUrlRequests.get(filePath) === pendingKey
    ) {
      previewDataUrlCache.set(filePath, result.dataUrl, request);
    }
    return result.dataUrl;
  });
  pendingPreviewDataUrls.set(pendingKey, read);

  try {
    return await read;
  } finally {
    if (pendingPreviewDataUrls.get(pendingKey) === read) {
      pendingPreviewDataUrls.delete(pendingKey);
    }
    const remaining = (pendingPreviewDataUrlCounts.get(filePath) ?? 1) - 1;
    if (remaining > 0) {
      pendingPreviewDataUrlCounts.set(filePath, remaining);
    } else {
      pendingPreviewDataUrlCounts.delete(filePath);
      latestPreviewDataUrlRequests.delete(filePath);
    }
  }
}

export function clearPreviewDataUrlCache(): void {
  previewDataUrlCache.clear();
  latestPreviewDataUrlRequests.clear();
  previewDataUrlCacheGeneration += 1;
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

export const EMOJI_ICON_MAPPINGS = {
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
  '1f4cc': 'pin',
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
  '1f517': 'link',
  '1f5a5': 'monitor',
  '1f5c2': 'contact',
  '1f5c3': 'archive',
  '1f5c4': 'database',
  '1f5d1': 'trash-2',
  '1f5dc': 'folder-archive',
  '1f6ab': 'ban',
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
} as const satisfies Readonly<Record<string, SupportedIconName>>;

const ICON_REGISTRY = Object.freeze({
  accessibility: Accessibility,
  activity: Activity,
  'alert-triangle': AlertTriangle,
  apple: Apple,
  archive: Archive,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'bar-chart-3': BarChart3,
  ban: Ban,
  bike: Bike,
  binary: Binary,
  'book-open': BookOpen,
  bookmark: Bookmark,
  briefcase: Briefcase,
  building: Building,
  calendar: Calendar,
  camera: Camera,
  car: Car,
  'check-circle': CheckCircle,
  'check-square': CheckSquare,
  circle: Circle,
  clapperboard: Clapperboard,
  clipboard: Clipboard,
  cloud: Cloud,
  coffee: Coffee,
  'columns-3': Columns3,
  compass: Compass,
  contact: Contact,
  copy: Copy,
  database: Database,
  download: Download,
  eye: Eye,
  file: File,
  'file-archive': FileArchive,
  'file-audio': FileAudio,
  'file-code': FileCode,
  'file-cog': FileCog,
  'file-spreadsheet': FileSpreadsheet,
  'file-text': FileText,
  'file-video': FileVideo,
  files: Files,
  'flask-conical': FlaskConical,
  flower2: Flower2,
  folder: Folder,
  'folder-archive': FolderArchive,
  'folder-open': FolderOpen,
  'gamepad-2': Gamepad2,
  gem: Gem,
  globe: Globe,
  hand: Hand,
  hash: Hash,
  heart: Heart,
  'help-circle': HelpCircle,
  home: Home,
  image: Image,
  inbox: Inbox,
  info: Info,
  key: Key,
  keyboard: Keyboard,
  laptop: Laptop,
  leaf: Leaf,
  'layout-grid': LayoutGrid,
  'layout-list': LayoutList,
  library: Library,
  link: Link,
  lightbulb: Lightbulb,
  lock: Lock,
  minus: Minus,
  monitor: Monitor,
  moon: Moon,
  music: Music,
  package: Package,
  palette: Palette,
  'pen-tool': PenTool,
  pencil: Pencil,
  pin: Pin,
  plane: Plane,
  plus: Plus,
  'refresh-ccw': RefreshCcw,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  save: Save,
  scissors: Scissors,
  scroll: Scroll,
  search: Search,
  settings: Settings,
  sidebar: Sidebar,
  sparkles: Sparkles,
  square: Square,
  star: Star,
  sun: Sun,
  sunrise: Sunrise,
  trees: Trees,
  'trash-2': Trash2,
  trophy: Trophy,
  truck: Truck,
  unlock: Unlock,
  upload: Upload,
  video: Video,
  waves: Waves,
  wrench: Wrench,
  x: X,
  'x-circle': XCircle,
} satisfies Readonly<Record<string, IconNode>>);

export type SupportedIconName = keyof typeof ICON_REGISTRY;
export const SUPPORTED_ICON_NAMES: readonly string[] = Object.freeze(Object.keys(ICON_REGISTRY));

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
  const input = typeof nameOrEmoji === 'string' ? nameOrEmoji : String(nameOrEmoji ?? '');
  const iconName = input.toLowerCase().trim();
  const mappings = EMOJI_ICON_MAPPINGS as Readonly<Record<string, SupportedIconName>>;
  const mappedName = mappings[iconName];
  if (mappedName) return mappedName;
  const codepoint = emojiToCodepoint(input);
  const mappedCodepoint = mappings[codepoint];
  if (mappedCodepoint) return mappedCodepoint;
  return iconName;
}

export function renderIcon(
  nameOrEmoji: string,
  className: string = 'lucide-icon',
  alt?: string
): string {
  const iconName = normalizeIconName(nameOrEmoji);
  const icon = ICON_REGISTRY[iconName as SupportedIconName] ?? File;
  const accessibleName = typeof alt === 'string' ? alt.trim() : '';
  const safeClassName = typeof className === 'string' ? className.trim() : 'lucide-icon';

  return iconToSvg(
    icon,
    accessibleName
      ? { class: safeClassName, role: 'img', 'aria-label': accessibleName }
      : { class: safeClassName, 'aria-hidden': 'true', focusable: 'false' }
  );
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
