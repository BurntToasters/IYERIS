export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
  isHidden: boolean;
}

export interface DirectoryContentsProgress {
  dirPath: string;
  items?: FileItem[];
  loaded: number;
  operationId?: string;
}

export interface ItemProperties {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  created: Date;
  modified: Date;
  accessed: Date;
}

export interface IndexEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: Date;
}

export interface IndexStatus {
  isIndexing: boolean;
  totalFiles: number;
  indexedFiles: number;
  lastIndexTime: Date | null;
}

export interface FolderSizeProgress {
  calculatedSize: number;
  fileCount: number;
  folderCount: number;
  currentPath: string;
}

export interface FileTypeStats {
  extension: string;
  count: number;
  size: number;
}

export interface FolderSizeResult {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  fileTypes?: FileTypeStats[];
}

export interface ChecksumResult {
  md5?: string;
  sha256?: string;
  error?: string;
}
