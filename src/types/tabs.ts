import type { FileItem } from './files';

export interface Tab {
  id: string;
  path: string;
  history: string[];
  historyIndex: number;
  selectedItems: string[];
  scrollPosition: number;
  cachedFiles?: FileItem[];
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string;
}
