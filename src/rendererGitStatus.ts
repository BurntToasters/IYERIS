import type { GitStatusResponse, GitFileStatus } from './types';

type GitStatusDeps = {
  getCurrentSettings: () => { enableGitStatus?: boolean; gitIncludeUntracked?: boolean };
  getCurrentPath: () => string;
  getFileElement: (path: string) => HTMLElement | undefined;
  getGitStatus: (dirPath: string, includeUntracked: boolean) => Promise<GitStatusResponse>;
  getGitBranch: (dirPath: string) => Promise<{ success: boolean; branch?: string }>;
};

const GIT_STATUS_CACHE_TTL_MS = 3000;
const GIT_STATUS_CACHE_MAX = 100;

export function createGitStatusController(deps: GitStatusDeps) {
  const { getCurrentSettings, getCurrentPath, getFileElement, getGitStatus, getGitBranch } = deps;

  const gitIndicatorPaths = new Set<string>();
  const gitStatusCache = new Map<
    string,
    { timestamp: number; isGitRepo: boolean; statuses: GitFileStatus[] }
  >();
  const gitStatusInFlight = new Map<string, Promise<GitStatusResponse>>();
  const currentGitStatuses: Map<string, string> = new Map();
  let gitStatusRequestId = 0;

  function clearGitIndicators(): void {
    currentGitStatuses.clear();
    for (const itemPath of gitIndicatorPaths) {
      getFileElement(itemPath)?.querySelector('.git-indicator')?.remove();
    }
    gitIndicatorPaths.clear();
  }

  async function fetchGitStatusAsync(dirPath: string) {
    if (!getCurrentSettings().enableGitStatus) {
      return;
    }

    const requestId = ++gitStatusRequestId;
    const includeUntracked = getCurrentSettings().gitIncludeUntracked !== false;

    try {
      const result = await getGitStatusCached(dirPath, includeUntracked);
      if (
        requestId !== gitStatusRequestId ||
        dirPath !== getCurrentPath() ||
        !getCurrentSettings().enableGitStatus
      ) {
        return;
      }

      currentGitStatuses.clear();

      if (result.success && result.isGitRepo && result.statuses) {
        for (const item of result.statuses) {
          currentGitStatuses.set(item.path, item.status);
        }
        updateGitIndicators();
      } else {
        clearGitIndicators();
      }
    } catch (error) {
      console.error('[Git Status] Failed to fetch:', error);
    }
  }

  async function getGitStatusCached(
    dirPath: string,
    includeUntracked: boolean
  ): Promise<GitStatusResponse> {
    const cacheKey = `${dirPath}|${includeUntracked ? 'all' : 'tracked'}`;
    const cached = gitStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
      return { success: true, isGitRepo: cached.isGitRepo, statuses: cached.statuses };
    }

    const inFlight = gitStatusInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const request = getGitStatus(dirPath, includeUntracked)
      .then((result) => {
        if (result.success) {
          if (gitStatusCache.size >= GIT_STATUS_CACHE_MAX) {
            const firstKey = gitStatusCache.keys().next().value;
            if (firstKey) gitStatusCache.delete(firstKey);
          }
          gitStatusCache.set(cacheKey, {
            timestamp: Date.now(),
            isGitRepo: result.isGitRepo === true,
            statuses: result.statuses || [],
          });
        }
        return result;
      })
      .finally(() => {
        gitStatusInFlight.delete(cacheKey);
      });

    gitStatusInFlight.set(cacheKey, request);
    return request;
  }

  async function updateGitBranch(dirPath: string) {
    const statusGitBranch = document.getElementById('status-git-branch');
    const statusGitBranchName = document.getElementById('status-git-branch-name');

    if (!statusGitBranch || !statusGitBranchName) return;

    if (!getCurrentSettings().enableGitStatus) {
      statusGitBranch.style.display = 'none';
      return;
    }

    try {
      const result = await getGitBranch(dirPath);
      if (result.success && result.branch && dirPath === getCurrentPath()) {
        statusGitBranchName.textContent = result.branch;
        statusGitBranch.style.display = 'inline-flex';
      } else {
        statusGitBranch.style.display = 'none';
      }
    } catch {
      statusGitBranch.style.display = 'none';
    }
  }

  function updateGitIndicators() {
    if (!getCurrentSettings().enableGitStatus) {
      clearGitIndicators();
      return;
    }

    for (const itemPath of Array.from(gitIndicatorPaths)) {
      if (!currentGitStatuses.has(itemPath)) {
        getFileElement(itemPath)?.querySelector('.git-indicator')?.remove();
        gitIndicatorPaths.delete(itemPath);
      }
    }

    applyGitIndicatorsToPaths(Array.from(currentGitStatuses.keys()));
  }

  function applyGitIndicatorsToPaths(paths: string[]): void {
    for (const itemPath of paths) {
      const status = currentGitStatuses.get(itemPath);
      if (!status) continue;
      const item = getFileElement(itemPath);
      if (!item) continue;

      let indicator = item.querySelector('.git-indicator') as HTMLElement | null;
      if (!indicator) {
        indicator = document.createElement('span');
        item.appendChild(indicator);
      }
      indicator.className = `git-indicator ${status}`;
      indicator.title = status.charAt(0).toUpperCase() + status.slice(1);
      gitIndicatorPaths.add(itemPath);
    }
  }

  function clearCache(): void {
    gitIndicatorPaths.clear();
    gitStatusCache.clear();
    gitStatusInFlight.clear();
  }

  return {
    clearGitIndicators,
    fetchGitStatusAsync,
    updateGitBranch,
    updateGitIndicators,
    applyGitIndicatorsToPaths,
    clearCache,
    gitIndicatorPaths,
    gitStatusCache,
    gitStatusInFlight,
  };
}
