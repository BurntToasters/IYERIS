export type CompressFormat = '7z' | 'zip' | 'tar.gz';

export type CompressUiCapabilities = {
  compressionLevel: boolean;
  allowStoreLevel: boolean;
  compressionMethod: boolean;
  dictionarySize: boolean;
  solidBlockSize: boolean;
  cpuThreads: boolean;
  encryption: boolean;
  encryptFileNames: boolean;
  encryptionMethod: boolean;
  splitVolume: boolean;
};

/** Per-format option visibility aligned with 7-Zip format rules. */
export const COMPRESS_FORMAT_UI: Record<CompressFormat, CompressUiCapabilities> = {
  '7z': {
    compressionLevel: true,
    allowStoreLevel: true,
    compressionMethod: true,
    dictionarySize: true,
    solidBlockSize: true,
    cpuThreads: true,
    encryption: true,
    encryptFileNames: true,
    encryptionMethod: false,
    splitVolume: true,
  },
  zip: {
    compressionLevel: true,
    allowStoreLevel: true,
    compressionMethod: true,
    dictionarySize: true,
    solidBlockSize: false,
    cpuThreads: true,
    encryption: true,
    encryptFileNames: false,
    encryptionMethod: true,
    splitVolume: true,
  },
  'tar.gz': {
    compressionLevel: true,
    allowStoreLevel: false,
    compressionMethod: false,
    dictionarySize: false,
    solidBlockSize: false,
    cpuThreads: false,
    encryption: false,
    encryptFileNames: false,
    encryptionMethod: false,
    splitVolume: false,
  },
};

/** Methods offered per archive format (7-Zip "Add to archive" dialog). */
export const COMPRESS_FORMAT_METHODS: Record<CompressFormat, readonly string[]> = {
  '7z': ['LZMA2', 'LZMA', 'PPMd', 'BZip2', 'Deflate'],
  zip: ['Deflate', 'BZip2', 'LZMA'],
  'tar.gz': [],
};

/** Methods the Rust backend can encode for each format. */
export const BACKEND_COMPRESS_METHODS: Record<CompressFormat, readonly string[]> = {
  '7z': ['LZMA2'],
  zip: ['Deflate', 'BZip2', 'LZMA'],
  'tar.gz': [],
};

/** Dictionary size applies to these compression methods only. */
export const DICTIONARY_METHODS_7Z = new Set(['LZMA2', 'LZMA', 'PPMd']);
export const DICTIONARY_METHODS_ZIP = new Set(['LZMA']);

/** Options the Rust backend applies when compressing. */
export const BACKEND_SUPPORTED_OPTIONS: Record<CompressFormat, ReadonlySet<string>> = {
  '7z': new Set(['compressionLevel', 'dictionarySize', 'password', 'encryptFileNames']),
  zip: new Set(['compressionLevel', 'method', 'password', 'encryptionMethod']),
  'tar.gz': new Set(['compressionLevel']),
};

export function methodSupportsDictionary(format: CompressFormat, method: string): boolean {
  if (format === '7z') return DICTIONARY_METHODS_7Z.has(method);
  if (format === 'zip') return DICTIONARY_METHODS_ZIP.has(method);
  return false;
}

export function getVisibleCompressUi(format: CompressFormat): CompressUiCapabilities {
  const ui = COMPRESS_FORMAT_UI[format];
  const supported = BACKEND_SUPPORTED_OPTIONS[format];
  const backendMethods = new Set(BACKEND_COMPRESS_METHODS[format]);

  return {
    compressionLevel: ui.compressionLevel && supported.has('compressionLevel'),
    allowStoreLevel: ui.allowStoreLevel && supported.has('compressionLevel'),
    compressionMethod: ui.compressionMethod && supported.has('method') && backendMethods.size > 1,
    dictionarySize: ui.dictionarySize && supported.has('dictionarySize'),
    solidBlockSize: false,
    cpuThreads: false,
    encryption: ui.encryption && supported.has('password'),
    encryptFileNames: ui.encryptFileNames && supported.has('encryptFileNames'),
    encryptionMethod: ui.encryptionMethod && supported.has('encryptionMethod'),
    splitVolume: false,
  };
}

export function getVisibleCompressMethods(format: CompressFormat): readonly string[] {
  const ui = getVisibleCompressUi(format);
  if (!ui.compressionMethod) return [];
  return COMPRESS_FORMAT_METHODS[format].filter((method) =>
    BACKEND_COMPRESS_METHODS[format].includes(method)
  );
}

export function getUnsupportedBackendOptionKeys(
  format: CompressFormat,
  options: Record<string, unknown>
): string[] {
  const supported = BACKEND_SUPPORTED_OPTIONS[format];
  return Object.keys(options).filter((key) => !supported.has(key));
}
