import type { FileItem, ItemProperties, IndexEntry, IndexStatus } from './files';
import type { Settings } from './settings';
import type { ContentSearchResult } from './search';
import type { UpdateInfo } from './updates';
import type { GitFileStatus } from './git';

export interface ApiResponse<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface DirectoryResponse extends ApiResponse {
  contents?: FileItem[];
}

export interface PropertiesResponse extends ApiResponse {
  properties?: ItemProperties;
}

export interface SettingsResponse extends ApiResponse {
  settings?: Settings;
}

export interface PathResponse extends ApiResponse {
  path?: string;
}

export interface SearchResponse extends ApiResponse {
  results?: FileItem[];
}

export interface ContentSearchResponse extends ApiResponse {
  results?: ContentSearchResult[];
}

export interface IndexSearchResponse extends ApiResponse {
  results?: IndexEntry[];
}

export interface UndoResponse extends ApiResponse {
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface UpdateCheckResponse extends ApiResponse {
  hasUpdate?: boolean;
  updateInfo?: UpdateInfo;
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  isBeta?: boolean;
  isFlatpak?: boolean;
  flatpakMessage?: string;
  isMas?: boolean;
  masMessage?: string;
  isMsStore?: boolean;
  msStoreMessage?: string;
  isMsi?: boolean;
  msiMessage?: string;
}

export interface GitStatusResponse extends ApiResponse {
  isGitRepo?: boolean;
  statuses?: GitFileStatus[];
}
