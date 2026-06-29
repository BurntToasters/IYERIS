/**
 * Archive format capability audit — run with: npx tsx scripts/audit-archive-capabilities.ts
 */
import {
  EXTRACTABLE_COMPOUND_SUFFIXES,
  isExtractableArchivePath,
  isListableArchivePath,
  supportsExtractPassword,
} from '../src/archiveFormatCapabilities';
import {
  BACKEND_COMPRESS_METHODS,
  BACKEND_SUPPORTED_OPTIONS,
  COMPRESS_FORMAT_UI,
  getVisibleCompressMethods,
  getVisibleCompressUi,
  type CompressFormat,
} from '../src/compressFormatCapabilities';

const COMPRESS_FORMATS: CompressFormat[] = ['7z', 'zip', 'tar.gz'];

const EXTRACT_POSITIVE = [
  'a.zip',
  'a.7z',
  'a.tar',
  'a.tar.gz',
  'a.tgz',
  'a.tar.bz2',
  'a.tbz2',
  'a.tar.xz',
  'a.txz',
  'a.gz',
  'a.xz',
];

const EXTRACT_NEGATIVE = ['a.rar', 'a.cab', 'a.iso', 'a.wim', 'readme.txt'];

let failures = 0;

function fail(message: string): void {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

function pass(message: string): void {
  console.log(`OK: ${message}`);
}

console.log('=== IYERIS archive capability audit ===\n');

for (const path of EXTRACT_POSITIVE) {
  if (!isExtractableArchivePath(path)) {
    fail(`expected extractable: ${path}`);
  }
}
pass(`extract routing accepts ${EXTRACT_POSITIVE.length} supported paths`);

for (const path of EXTRACT_NEGATIVE) {
  if (isExtractableArchivePath(path)) {
    fail(`expected not extractable: ${path}`);
  }
}
pass(`extract routing rejects ${EXTRACT_NEGATIVE.length} unsupported paths`);

for (const suffix of EXTRACTABLE_COMPOUND_SUFFIXES) {
  if (!isExtractableArchivePath(`backup${suffix}`)) {
    fail(`compound suffix not registered: ${suffix}`);
  }
}
pass('compound archive suffixes registered');

const LISTABLE_POSITIVE = ['backup.zip', 'backup.7z', 'backup.tar.gz'];
const LISTABLE_NEGATIVE = ['backup.rar', 'backup.cab', 'readme.txt'];
for (const path of LISTABLE_POSITIVE) {
  if (!isListableArchivePath(path)) {
    fail(`expected listable for preview: ${path}`);
  }
}
for (const path of LISTABLE_NEGATIVE) {
  if (isListableArchivePath(path)) {
    fail(`expected not listable for preview: ${path}`);
  }
}
pass('archive preview list routing matches backend list support');

if (!supportsExtractPassword('secret.7z')) fail('7z should support extract password');
if (!supportsExtractPassword('secret.zip')) fail('zip should support extract password');
if (supportsExtractPassword('data.tar.gz')) fail('tar.gz should not support extract password');
pass('extract password UI routing matches backend support');

for (const format of COMPRESS_FORMATS) {
  const ui = getVisibleCompressUi(format);
  const supported = BACKEND_SUPPORTED_OPTIONS[format];

  if (ui.encryption && !supported.has('password')) {
    fail(`${format}: encryption shown but password unsupported`);
  }
  if (ui.encryptionMethod && !supported.has('encryptionMethod')) {
    fail(`${format}: encryption method shown but unsupported`);
  }
  if (ui.compressionMethod && !supported.has('method')) {
    fail(`${format}: compression method shown but unsupported`);
  }
  if (ui.dictionarySize && !supported.has('dictionarySize')) {
    fail(`${format}: dictionary shown but unsupported`);
  }
  if (ui.encryptFileNames && !supported.has('encryptFileNames')) {
    fail(`${format}: encrypt filenames shown but unsupported`);
  }

  for (const hidden of ['solidBlockSize', 'cpuThreads', 'splitVolume'] as const) {
    if (ui[hidden]) {
      fail(`${format}: ${hidden} should be hidden (backend gap)`);
    }
  }

  const visibleMethods = getVisibleCompressMethods(format);
  for (const method of visibleMethods) {
    if (!BACKEND_COMPRESS_METHODS[format].includes(method)) {
      fail(`${format}: visible method ${method} not in backend list`);
    }
  }

  if (ui.compressionMethod && visibleMethods.length < 2) {
    fail(`${format}: compression method UI shown with fewer than 2 methods`);
  }

  const docUi = COMPRESS_FORMAT_UI[format];
  if (ui.compressionLevel && !docUi.compressionLevel) {
    fail(`${format}: compression level visible but not in 7-Zip UI spec`);
  }
}
pass('compress UI visibility matches backend support matrix');

console.log(`\n=== Audit complete: ${failures} failure(s) ===`);
process.exit(failures > 0 ? 1 : 0);
