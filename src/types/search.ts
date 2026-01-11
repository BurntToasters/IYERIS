import type { FileItem } from './files';

export interface SearchFilters {
  fileType?: string;
  minSize?: number;
  maxSize?: number;
  dateFrom?: string;
  dateTo?: string;
  searchInContents?: boolean;
}

export interface ContentSearchResult extends FileItem {
  matchContext?: string;
  matchLineNumber?: number;
}
