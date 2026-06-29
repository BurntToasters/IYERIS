import {
  FILE_ICON_MAP,
  IMAGE_EXTENSIONS,
  RAW_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  WORD_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  TEXT_EXTENSIONS,
  SOURCE_CODE_EXTENSIONS,
  WEB_EXTENSIONS,
  DATA_EXTENSIONS,
  PDF_EXTENSIONS,
} from './fileTypes.js';
import { renderIcon } from './rendererUtils.js';

export function getFileExtension(filename: string): string {
  if (!filename) return '';
  const parts = filename.split('.');
  const last = parts[parts.length - 1] ?? '';
  const ext = last.toLowerCase();
  return ext.length > 20 ? ext.slice(0, 20) : ext;
}

const FILE_TYPE_LABELS: ReadonlyArray<[Set<string>, string]> = [
  [IMAGE_EXTENSIONS, 'Image'],
  [RAW_EXTENSIONS, 'RAW Image'],
  [VIDEO_EXTENSIONS, 'Video'],
  [AUDIO_EXTENSIONS, 'Audio'],
  [PDF_EXTENSIONS, 'PDF Document'],
  [WORD_EXTENSIONS, 'Word Document'],
  [SPREADSHEET_EXTENSIONS, 'Spreadsheet'],
  [PRESENTATION_EXTENSIONS, 'Presentation'],
  [ARCHIVE_EXTENSIONS, 'Archive'],
  [SOURCE_CODE_EXTENSIONS, 'Source Code'],
  [WEB_EXTENSIONS, 'Web File'],
  [DATA_EXTENSIONS, 'Data File'],
  [TEXT_EXTENSIONS, 'Text File'],
];

export function getFileTypeFromName(filename: string): string {
  const ext = getFileExtension(filename);
  if (!ext) return 'File';
  for (const [set, label] of FILE_TYPE_LABELS) {
    if (set.has(ext)) return label;
  }
  return `${ext.toUpperCase()} File`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const IMAGE_ICON = renderIcon('image', 'twemoji');
const RAW_ICON = renderIcon('camera', 'twemoji');
const VIDEO_ICON = renderIcon('file-video', 'twemoji');
const AUDIO_ICON = renderIcon('file-audio', 'twemoji');
const WORD_ICON = renderIcon('file-text', 'twemoji');
const SPREADSHEET_ICON = renderIcon('file-spreadsheet', 'twemoji');
const ARCHIVE_ICON = renderIcon('file-archive', 'twemoji');
const DEFAULT_FILE_ICON = renderIcon('file', 'twemoji');

export { IMAGE_ICON };

const FILE_ICON_CACHE_MAX = 300;
const fileIconCache = new Map<string, string>();

export function getFileIcon(filename: string): string {
  const ext = getFileExtension(filename);

  const cached = fileIconCache.get(ext);
  if (cached) return cached;

  const iconName = FILE_ICON_MAP[ext];
  let icon: string;

  if (!iconName) {
    if (RAW_EXTENSIONS.has(ext)) {
      icon = RAW_ICON;
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      icon = IMAGE_ICON;
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      icon = VIDEO_ICON;
    } else if (AUDIO_EXTENSIONS.has(ext)) {
      icon = AUDIO_ICON;
    } else if (WORD_EXTENSIONS.has(ext)) {
      icon = WORD_ICON;
    } else if (SPREADSHEET_EXTENSIONS.has(ext) || PRESENTATION_EXTENSIONS.has(ext)) {
      icon = SPREADSHEET_ICON;
    } else if (ARCHIVE_EXTENSIONS.has(ext)) {
      icon = ARCHIVE_ICON;
    } else {
      icon = DEFAULT_FILE_ICON;
    }
  } else if (iconName === 'image') {
    icon = IMAGE_ICON;
  } else {
    icon = renderIcon(iconName, 'twemoji');
  }

  if (fileIconCache.size >= FILE_ICON_CACHE_MAX) {
    const oldestKey = fileIconCache.keys().next().value;
    if (oldestKey !== undefined) fileIconCache.delete(oldestKey);
  }
  fileIconCache.set(ext, icon);
  return icon;
}
