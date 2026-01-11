export const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'js', 'jsx', 'ts', 'tsx', 'json',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'py', 'rb',
  'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bash',
  'ps1', 'bat', 'cmd', 'sql', 'log', 'csv', 'env', 'gitignore',
  'vue', 'svelte', 'php', 'pl', 'r', 'lua', 'kt', 'kts', 'scala'
]);

export const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'log', 'readme', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'pyc', 'pyw', 'java', 'c', 'cpp', 'cc', 'cxx',
  'h', 'hpp', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'kts', 'scala', 'r', 'lua', 'perl',
  'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'json', 'xml', 'yml', 'yaml', 'toml', 'csv', 'tsv', 'sql',
  'ini', 'conf', 'config', 'cfg', 'env', 'properties', 'gitignore', 'gitattributes',
  'editorconfig', 'dockerfile', 'dockerignore',
  'rst', 'tex', 'adoc', 'asciidoc', 'makefile', 'cmake', 'gradle', 'maven'
]);

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'jfif', 'svg'
]);

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'm4v'
]);

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'
]);

export const PDF_EXTENSIONS = new Set(['pdf']);

export const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'
]);

export const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v'
};

export const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  opus: 'audio/ogg'
};

export const FILE_ICON_MAP: Record<string, string> = {
  'jpg': '1f5bc', 'jpeg': '1f5bc', 'png': '1f5bc', 'gif': '1f5bc', 'svg': '1f5bc', 'bmp': '1f5bc',
  'webp': '1f5bc', 'ico': '1f5bc', 'tiff': '1f5bc', 'tif': '1f5bc', 'avif': '1f5bc', 'jfif': '1f5bc',
  'mp4': '1f3ac', 'avi': '1f3ac', 'mov': '1f3ac', 'mkv': '1f3ac', 'webm': '1f3ac',
  'mp3': '1f3b5', 'wav': '1f3b5', 'flac': '1f3b5', 'ogg': '1f3b5', 'm4a': '1f3b5',
  'pdf': '1f4c4', 'doc': '1f4dd', 'docx': '1f4dd', 'txt': '1f4dd', 'rtf': '1f4dd',
  'xls': '1f4ca', 'xlsx': '1f4ca', 'csv': '1f4ca',
  'ppt': '1f4ca', 'pptx': '1f4ca',
  'js': '1f4dc', 'ts': '1f4dc', 'jsx': '1f4dc', 'tsx': '1f4dc',
  'html': '1f310', 'css': '1f3a8', 'json': '2699', 'xml': '2699',
  'py': '1f40d', 'java': '2615', 'c': 'a9', 'cpp': 'a9', 'cs': 'a9',
  'php': '1f418', 'rb': '1f48e', 'go': '1f439', 'rs': '1f980',
  'zip': '1f5dc', 'rar': '1f5dc', '7z': '1f5dc', 'tar': '1f5dc', 'gz': '1f5dc',
  'exe': '2699', 'app': '2699', 'msi': '2699', 'dmg': '2699'
};
