import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  type SearchFilters,
  type DateRangeFilter,
  type ContentSearchResult,
  type SearchResult,
  isCancelled,
  parseDateRange,
  matchesDateRange,
  matchesFilters,
  getTextExtensionKey,
  TEXT_FILE_EXTENSIONS,
  normalizeModifiedDate,
  readIndexData,
  parseIndexEntry,
  isHidden,
  batchCheckHidden,
  type IndexSearchResult,
} from './workerUtils';

interface SearchPayload {
  dirPath: string;
  query: string;
  filters?: SearchFilters;
  maxDepth: number;
  maxResults: number;
}

interface ContentSearchPayload {
  dirPath: string;
  query: string;
  filters?: SearchFilters;
  maxDepth: number;
  maxResults: number;
}

interface ContentListSearchPayload {
  files: Array<{ path: string; size: number; name?: string; modified?: number | string | Date }>;
  query: string;
  filters?: SearchFilters;
  maxResults: number;
}

interface ContentIndexSearchPayload extends IndexSearchPayload {
  maxResults: number;
  filters?: SearchFilters;
}

interface IndexSearchPayload {
  indexPath: string;
  query: string;
  maxResults?: number;
}

const CONTENT_SEARCH_MAX_FILE_SIZE = 1024 * 1024;
const CONTENT_CONTEXT_CHARS = 60;

function matchesContentFilters(
  stats: { size: number; mtime: Date },
  filters?: SearchFilters,
  dateRange: DateRangeFilter = parseDateRange(filters)
): boolean {
  const minSize = filters?.minSize;
  const maxSize = filters?.maxSize;
  if (minSize !== undefined && stats.size < minSize) return false;
  if (maxSize !== undefined && stats.size > maxSize) return false;

  return matchesDateRange(stats.mtime, dateRange);
}

interface PendingContentSearchItem {
  filePath: string;
  fileName: string;
  size: number;
  modified: Date;
}

async function searchFileContent(
  filePath: string,
  searchQuery: string,
  operationId?: string,
  sizeHint?: number,
  searchRegex?: RegExp | null
): Promise<{ found: boolean; context?: string; lineNumber?: number }> {
  const key = getTextExtensionKey(filePath);
  if (!key || !TEXT_FILE_EXTENSIONS.has(key)) {
    return { found: false };
  }

  try {
    let size = Number.isFinite(sizeHint) ? Number(sizeHint) : undefined;
    if (size === undefined) {
      const stats = await fs.stat(filePath);
      size = stats.size;
    }
    if (size > CONTENT_SEARCH_MAX_FILE_SIZE) {
      return { found: false };
    }

    const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;

    try {
      for await (const line of rl) {
        if (isCancelled(operationId)) {
          throw new Error('Calculation cancelled');
        }
        lineNumber++;
        let matchIndex: number;
        let matchLength: number;
        if (searchRegex) {
          const m = searchRegex.exec(line);
          matchIndex = m ? m.index : -1;
          matchLength = m ? m[0].length : 0;
        } else {
          const lowerLine = line.toLowerCase();
          matchIndex = lowerLine.indexOf(searchQuery);
          matchLength = searchQuery.length;
        }
        if (matchIndex !== -1) {
          const start = Math.max(0, matchIndex - CONTENT_CONTEXT_CHARS);
          const end = Math.min(line.length, matchIndex + matchLength + CONTENT_CONTEXT_CHARS);
          let context = line.substring(start, end).trim();
          if (start > 0) context = '...' + context;
          if (end < line.length) context = context + '...';
          return { found: true, context, lineNumber };
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Calculation cancelled') {
      throw error;
    }
    return { found: false };
  }

  return { found: false };
}

async function flushContentSearchBatch(
  batch: PendingContentSearchItem[],
  searchQuery: string,
  results: ContentSearchResult[],
  maxResults: number,
  operationId?: string,
  searchRegex?: RegExp | null
): Promise<void> {
  if (batch.length === 0 || results.length >= maxResults) {
    batch.length = 0;
    return;
  }

  const searchResults = await Promise.allSettled(
    batch.map(({ filePath, size }) =>
      searchFileContent(filePath, searchQuery, operationId, size, searchRegex)
    )
  );
  const foundItems: Array<PendingContentSearchItem & { context?: string; lineNumber?: number }> =
    [];

  for (let i = 0; i < searchResults.length; i++) {
    if (results.length + foundItems.length >= maxResults) break;
    const result = searchResults[i];
    if (result.status === 'fulfilled' && result.value.found) {
      foundItems.push({
        ...batch[i],
        context: result.value.context,
        lineNumber: result.value.lineNumber,
      });
    }
  }

  if (foundItems.length > 0) {
    const hiddenStates = await Promise.all(
      foundItems.map(({ filePath, fileName }) => isHidden(filePath, fileName))
    );
    for (let i = 0; i < foundItems.length; i++) {
      if (results.length >= maxResults) break;
      const item = foundItems[i];
      results.push({
        name: item.fileName,
        path: item.filePath,
        isDirectory: false,
        isFile: true,
        size: item.size,
        modified: item.modified,
        isHidden: hiddenStates[i],
        matchContext: item.context,
        matchLineNumber: item.lineNumber,
      });
    }
  }

  batch.length = 0;
}

export async function searchDirectoryFiles(
  payload: SearchPayload,
  operationId?: string
): Promise<SearchResult[]> {
  const { dirPath, query, filters, maxDepth, maxResults } = payload;
  const results: SearchResult[] = [];
  const searchQuery = String(query || '').toLowerCase();
  const useRegex = filters?.regex === true;
  let searchRegex: RegExp | null = null;
  if (useRegex) {
    try {
      searchRegex = new RegExp(query, 'i');
    } catch {
      return results;
    }
  }
  const dateRange = parseDateRange(filters);
  const STAT_BATCH_SIZE = 50;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];
  while (stack.length && results.length < maxResults) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth >= maxDepth) continue;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    let items: fsSync.Dirent[];
    try {
      items = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const matchingItems: Array<{ item: fsSync.Dirent; fullPath: string }> = [];

    for (const item of items) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(current.dir, item.name);
      const matches = searchRegex
        ? searchRegex.test(item.name)
        : item.name.toLowerCase().includes(searchQuery);

      if (matches) {
        matchingItems.push({ item, fullPath });
      }

      if (item.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }

    for (let i = 0; i < matchingItems.length && results.length < maxResults; i += STAT_BATCH_SIZE) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const batch = matchingItems.slice(i, i + STAT_BATCH_SIZE);
      const statResults = await Promise.allSettled(batch.map(({ fullPath }) => fs.stat(fullPath)));

      const filteredItems: Array<{ item: fsSync.Dirent; fullPath: string; stats: fsSync.Stats }> =
        [];

      for (let j = 0; j < statResults.length; j++) {
        if (results.length >= maxResults) break;
        const result = statResults[j];
        if (result.status === 'fulfilled') {
          const { item, fullPath } = batch[j];
          const isDir = item.isDirectory();
          if (matchesFilters(item.name, isDir, result.value, filters, dateRange)) {
            filteredItems.push({ item, fullPath, stats: result.value });
          }
        }
      }

      if (filteredItems.length === 0) continue;

      const hiddenMap = await batchCheckHidden(
        current.dir,
        filteredItems.map(({ item }) => item.name)
      );

      for (const { item, fullPath, stats } of filteredItems) {
        if (results.length >= maxResults) break;
        const attrFlags = hiddenMap.get(item.name);
        results.push({
          name: item.name,
          path: fullPath,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
          size: stats.size,
          modified: stats.mtime,
          isHidden: attrFlags?.isHidden || false,
          isSystemProtected: attrFlags?.isSystemProtected || undefined,
        });
      }
    }
  }

  return results;
}

export async function searchDirectoryContent(
  payload: ContentSearchPayload,
  operationId?: string
): Promise<ContentSearchResult[]> {
  const { dirPath, query, filters, maxDepth, maxResults } = payload;
  const results: ContentSearchResult[] = [];
  const searchQuery = String(query || '').toLowerCase();
  let contentRegex: RegExp | null = null;
  if (filters?.regex) {
    try {
      contentRegex = new RegExp(query, 'i');
    } catch {
      return results;
    }
  }
  const dateRange = parseDateRange(filters);
  const STAT_BATCH_SIZE = 50;
  const CONTENT_SEARCH_BATCH_SIZE = 8;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];
  while (stack.length && results.length < maxResults) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth >= maxDepth) continue;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    let items: fsSync.Dirent[];
    try {
      items = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const fileItems: Array<{ item: fsSync.Dirent; fullPath: string }> = [];

    for (const item of items) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');
      const fullPath = path.join(current.dir, item.name);

      if (item.isFile()) {
        fileItems.push({ item, fullPath });
      }

      if (item.isDirectory()) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }

    for (let i = 0; i < fileItems.length && results.length < maxResults; i += STAT_BATCH_SIZE) {
      if (isCancelled(operationId)) throw new Error('Calculation cancelled');

      const statBatch = fileItems.slice(i, i + STAT_BATCH_SIZE);
      const statResults = await Promise.allSettled(
        statBatch.map(({ fullPath }) => fs.stat(fullPath))
      );

      const contentBatch: Array<{ item: fsSync.Dirent; fullPath: string; stats: fsSync.Stats }> =
        [];

      for (let j = 0; j < statResults.length; j++) {
        if (results.length >= maxResults) break;
        const result = statResults[j];
        if (result.status === 'fulfilled') {
          const { item, fullPath } = statBatch[j];
          if (matchesContentFilters(result.value, filters, dateRange)) {
            contentBatch.push({ item, fullPath, stats: result.value });
          }
        }
      }

      for (
        let k = 0;
        k < contentBatch.length && results.length < maxResults;
        k += CONTENT_SEARCH_BATCH_SIZE
      ) {
        if (isCancelled(operationId)) throw new Error('Calculation cancelled');

        const batch = contentBatch.slice(
          k,
          Math.min(k + CONTENT_SEARCH_BATCH_SIZE, contentBatch.length)
        );
        const contentResults = await Promise.allSettled(
          batch.map(({ fullPath, stats }) =>
            searchFileContent(fullPath, searchQuery, operationId, stats.size, contentRegex)
          )
        );

        const foundItems: Array<{
          item: fsSync.Dirent;
          fullPath: string;
          stats: fsSync.Stats;
          contentResult: { found: boolean; context?: string; lineNumber?: number };
        }> = [];

        for (let j = 0; j < contentResults.length; j++) {
          const result = contentResults[j];
          if (result.status === 'fulfilled' && result.value.found) {
            foundItems.push({ ...batch[j], contentResult: result.value });
          }
        }

        if (foundItems.length > 0) {
          const hiddenMap = await batchCheckHidden(
            current.dir,
            foundItems.map(({ item }) => item.name)
          );

          for (const { item, fullPath, stats, contentResult } of foundItems) {
            if (results.length >= maxResults) break;
            const attrFlags = hiddenMap.get(item.name);
            results.push({
              name: item.name,
              path: fullPath,
              isDirectory: false,
              isFile: true,
              size: stats.size,
              modified: stats.mtime,
              isHidden: attrFlags?.isHidden || false,
              isSystemProtected: attrFlags?.isSystemProtected || undefined,
              matchContext: contentResult.context,
              matchLineNumber: contentResult.lineNumber,
            });
          }
        }
      }
    }
  }

  return results;
}

export async function searchContentList(
  payload: ContentListSearchPayload,
  operationId?: string
): Promise<ContentSearchResult[]> {
  const { files, query, maxResults, filters } = payload;
  const results: ContentSearchResult[] = [];
  const searchQuery = String(query || '').toLowerCase();
  let listRegex: RegExp | null = null;
  if (filters?.regex) {
    try {
      listRegex = new RegExp(query, 'i');
    } catch {
      return results;
    }
  }
  const dateRange = parseDateRange(filters);
  const CONTENT_SEARCH_BATCH_SIZE = 8;
  const batch: PendingContentSearchItem[] = [];

  for (const item of files || []) {
    if (results.length >= maxResults) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const filePath = item.path;
    const fileName = item.name || path.basename(filePath);
    const key = getTextExtensionKey(fileName);
    if (!TEXT_FILE_EXTENSIONS.has(key)) continue;

    if (filters?.minSize !== undefined && item.size < filters.minSize) continue;
    if (filters?.maxSize !== undefined && item.size > filters.maxSize) continue;
    const modified = normalizeModifiedDate(item.modified);
    if (!matchesDateRange(modified, dateRange)) continue;

    batch.push({ filePath, fileName, size: item.size, modified });

    if (batch.length >= CONTENT_SEARCH_BATCH_SIZE) {
      await flushContentSearchBatch(
        batch,
        searchQuery,
        results,
        maxResults,
        operationId,
        listRegex
      );
    }
  }

  if (batch.length > 0 && results.length < maxResults) {
    await flushContentSearchBatch(batch, searchQuery, results, maxResults, operationId, listRegex);
  }

  return results;
}

export async function searchContentIndex(
  payload: ContentIndexSearchPayload,
  operationId?: string
): Promise<ContentSearchResult[]> {
  const { indexPath, query, maxResults, filters } = payload;
  const searchQuery = String(query || '').toLowerCase();
  const limit = Number.isFinite(maxResults) ? Math.max(1, maxResults) : 100;
  const dateRange = parseDateRange(filters);

  const parsed = await readIndexData(
    indexPath,
    'Index is empty. Rebuild the index to enable global content search.'
  );

  const indexEntries = parsed?.index;
  if (!Array.isArray(indexEntries) || indexEntries.length === 0) {
    throw new Error('Index is empty. Rebuild the index to enable global content search.');
  }

  const results: ContentSearchResult[] = [];
  const CONTENT_SEARCH_BATCH_SIZE = 8;
  const batch: PendingContentSearchItem[] = [];

  let indexRegex: RegExp | null = null;
  if (filters?.regex) {
    try {
      indexRegex = new RegExp(query, 'i');
    } catch {}
  }

  for (const entry of indexEntries) {
    if (results.length >= limit) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const { filePath, item } = parseIndexEntry(entry);
    if (!item || item.isFile !== true || !filePath) continue;

    const fileName = typeof item.name === 'string' ? item.name : path.basename(filePath);
    const key = getTextExtensionKey(fileName);
    if (!TEXT_FILE_EXTENSIONS.has(key)) continue;

    const modified = normalizeModifiedDate(item.modified);
    const sizeValue = typeof item.size === 'number' ? item.size : Number(item.size);
    const size = Number.isFinite(sizeValue) ? sizeValue : 0;
    if (filters?.minSize !== undefined && size < filters.minSize) continue;
    if (filters?.maxSize !== undefined && size > filters.maxSize) continue;
    if (!matchesDateRange(modified, dateRange)) continue;

    batch.push({ filePath, fileName, size, modified });

    if (batch.length >= CONTENT_SEARCH_BATCH_SIZE) {
      await flushContentSearchBatch(batch, searchQuery, results, limit, operationId, indexRegex);
    }
  }

  if (batch.length > 0 && results.length < limit) {
    await flushContentSearchBatch(batch, searchQuery, results, limit, operationId, indexRegex);
  }

  return results;
}

export async function searchIndexFile(
  payload: IndexSearchPayload,
  operationId?: string
): Promise<IndexSearchResult[]> {
  const { indexPath, query, maxResults } = payload;
  const searchQuery = String(query || '').toLowerCase();
  const limit =
    typeof maxResults === 'number' && Number.isFinite(maxResults) ? Math.max(1, maxResults) : 100;

  if (!searchQuery) {
    return [];
  }

  const parsed = await readIndexData(
    indexPath,
    'Index is empty. Rebuild the index to enable global search.'
  );

  const indexEntries = parsed?.index;
  if (!Array.isArray(indexEntries) || indexEntries.length === 0) {
    throw new Error('Index is empty. Rebuild the index to enable global search.');
  }

  const results: IndexSearchResult[] = [];

  for (const entry of indexEntries) {
    if (results.length >= limit) break;
    if (isCancelled(operationId)) throw new Error('Calculation cancelled');

    const { filePath, item } = parseIndexEntry(entry);
    if (!item || !filePath) continue;
    const name = typeof item.name === 'string' ? item.name : path.basename(filePath);
    if (!String(name).toLowerCase().includes(searchQuery)) continue;

    const sizeValue = typeof item.size === 'number' ? item.size : Number(item.size);
    const size = Number.isFinite(sizeValue) ? sizeValue : 0;
    const modified = normalizeModifiedDate(item.modified);

    results.push({
      name,
      path: filePath,
      isDirectory: item.isDirectory === true,
      isFile: item.isFile === true,
      size,
      modified,
    });
  }

  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === searchQuery;
    const bExact = b.name.toLowerCase() === searchQuery;

    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}
