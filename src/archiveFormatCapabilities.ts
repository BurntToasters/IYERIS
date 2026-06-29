/** Archive extensions IYERIS can extract (must match `archive.rs` routing). */
export const EXTRACTABLE_COMPOUND_SUFFIXES = [
  '.tar.gz',
  '.tgz',
  '.tar.xz',
  '.txz',
  '.tar.bz2',
  '.tbz2',
  '.tbz',
] as const;

export const EXTRACTABLE_ARCHIVE_DESCRIPTION =
  '.zip, .7z, .tar, .tar.gz, .tar.bz2, .tar.xz, and plain .gz/.xz files';

/** Archives whose contents can be listed in preview (matches backend `list_archive_contents`). */
export function isListableArchivePath(filePath: string): boolean {
  return isExtractableArchivePath(filePath);
}

export function supportsExtractPassword(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = lower.slice(dot + 1);
  return ext === 'zip' || ext === '7z';
}

export function isExtractableArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (EXTRACTABLE_COMPOUND_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }

  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = lower.slice(dot + 1);

  if (ext === 'zip' || ext === '7z' || ext === 'tar') return true;
  if (ext === 'gz' && !lower.endsWith('.tar.gz')) return true;
  if (ext === 'xz' && !lower.endsWith('.tar.xz')) return true;
  return false;
}
