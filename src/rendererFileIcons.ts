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
import { twemojiImg } from './rendererUtils.js';

export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
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
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const IMAGE_ICON = twemojiImg(String.fromCodePoint(parseInt('1f5bc', 16)), 'twemoji');
const RAW_ICON = twemojiImg(String.fromCodePoint(0x1f4f7), 'twemoji');
const VIDEO_ICON = twemojiImg(String.fromCodePoint(0x1f3ac), 'twemoji');
const AUDIO_ICON = twemojiImg(String.fromCodePoint(0x1f3b5), 'twemoji');
const WORD_ICON = twemojiImg(String.fromCodePoint(0x1f4dd), 'twemoji');
const SPREADSHEET_ICON = twemojiImg(String.fromCodePoint(0x1f4ca), 'twemoji');
const ARCHIVE_ICON = twemojiImg(String.fromCodePoint(0x1f5dc), 'twemoji');
const DEFAULT_FILE_ICON = twemojiImg(String.fromCodePoint(parseInt('1f4c4', 16)), 'twemoji');

export { IMAGE_ICON };

const fileIconCache = new Map<string, string>();

export function getFileIcon(filename: string): string {
  const ext = getFileExtension(filename);

  const cached = fileIconCache.get(ext);
  if (cached) return cached;

  const codepoint = FILE_ICON_MAP[ext];
  let icon: string;

  if (!codepoint) {
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
  } else if (codepoint === '1f5bc') {
    icon = IMAGE_ICON;
  } else {
    icon = twemojiImg(String.fromCodePoint(parseInt(codepoint, 16)), 'twemoji');
  }

  fileIconCache.set(ext, icon);
  return icon;
}
