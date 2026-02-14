import { twemojiImg } from './rendererUtils.js';
import { escapeHtml } from './shared.js';

export interface DiskSpaceControllerDeps {
  getCurrentPath: () => string;
  getPlatformOS: () => string;
  formatFileSize: (bytes: number) => string;
  isHomeViewPath: (p: string) => boolean;
  getDiskSpace: (drivePath: string) => Promise<{
    success: boolean;
    total?: number;
    free?: number;
    error?: string;
  }>;
}

export function createDiskSpaceController(deps: DiskSpaceControllerDeps) {
  const DISK_SPACE_CACHE_TTL_MS = 60000;
  const DISK_SPACE_CACHE_MAX = 50;
  const DISK_SPACE_DEBOUNCE_MS = 300;
  const diskSpaceCache = new Map<string, { timestamp: number; total: number; free: number }>();
  let diskSpaceDebounceTimer: NodeJS.Timeout | null = null;
  let lastDiskSpacePath: string = '';

  function getUnixDrivePath(pathValue: string): string {
    const normalized = pathValue.replace(/\\/g, '/');
    const roots = ['/Volumes', '/media', '/mnt', '/run/media'];
    for (const root of roots) {
      if (normalized === root || normalized.startsWith(root + '/')) {
        const parts = normalized.split('/').filter(Boolean);
        const rootParts = root.split('/').filter(Boolean);
        const extraSegments = root === '/run/media' ? 2 : 1;
        const needed = rootParts.length + extraSegments;
        if (parts.length >= needed) {
          return '/' + parts.slice(0, needed).join('/');
        }
        return root;
      }
    }
    return '/';
  }

  function getWindowsDrivePath(pathValue: string): string {
    const normalized = pathValue.replace(/\//g, '\\');
    if (normalized.startsWith('\\\\')) {
      const parts = normalized.split('\\').filter(Boolean);
      if (parts.length >= 2) {
        return `\\\\${parts[0]}\\${parts[1]}\\`;
      }
      return normalized;
    }
    return normalized.substring(0, 3);
  }

  function getCachedDiskSpace(drivePath: string): { total: number; free: number } | null {
    const cached = diskSpaceCache.get(drivePath);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > DISK_SPACE_CACHE_TTL_MS) {
      diskSpaceCache.delete(drivePath);
      return null;
    }
    return { total: cached.total, free: cached.free };
  }

  function renderDiskSpace(element: HTMLElement, total: number, free: number): void {
    const freeStr = deps.formatFileSize(free);
    const totalStr = deps.formatFileSize(total);
    const usedBytes = total - free;
    const usedPercent = ((usedBytes / total) * 100).toFixed(1);
    const usedPercentNumeric = parseFloat(usedPercent);
    const usageState =
      usedPercentNumeric > 90 ? 'critical' : usedPercentNumeric > 80 ? 'warning' : 'healthy';

    element.innerHTML = `
    <span class="status-disk">
      ${twemojiImg(String.fromCodePoint(0x1f4be), 'twemoji')} ${freeStr} free of ${totalStr}
      <span class="status-disk-meter">
        <span class="status-disk-meter-fill ${usageState}" style="width: ${usedPercent}%"></span>
      </span>
      <span class="status-disk-percent">(${usedPercent}% used)</span>
    </span>
  `;
  }

  function renderDiskSpaceUnavailable(element: HTMLElement, message: string): void {
    element.innerHTML = `
    <span class="status-disk status-disk-unavailable">
      ${twemojiImg(String.fromCodePoint(0x26a0), 'twemoji')} ${escapeHtml(message)}
    </span>
  `;
  }

  async function updateDiskSpace() {
    const statusDiskSpace = document.getElementById('status-disk-space');
    const currentPath = deps.getCurrentPath();
    const platformOS = deps.getPlatformOS();
    if (!statusDiskSpace || !currentPath || deps.isHomeViewPath(currentPath)) return;

    let drivePath = currentPath;
    if (platformOS === 'win32') {
      drivePath = getWindowsDrivePath(currentPath);
    } else {
      drivePath = getUnixDrivePath(currentPath);
    }

    if (drivePath === lastDiskSpacePath && diskSpaceDebounceTimer) {
      return;
    }

    if (diskSpaceDebounceTimer) {
      clearTimeout(diskSpaceDebounceTimer);
    }

    lastDiskSpacePath = drivePath;

    const cached = getCachedDiskSpace(drivePath);
    if (cached) {
      renderDiskSpace(statusDiskSpace, cached.total, cached.free);
      return;
    }

    diskSpaceDebounceTimer = setTimeout(async () => {
      const result = await deps.getDiskSpace(drivePath);
      if (
        result.success &&
        typeof result.total === 'number' &&
        typeof result.free === 'number' &&
        result.total > 0
      ) {
        const total = result.total;
        const free = result.free;
        if (diskSpaceCache.size >= DISK_SPACE_CACHE_MAX) {
          const firstKey = diskSpaceCache.keys().next().value;
          if (firstKey) diskSpaceCache.delete(firstKey);
        }
        diskSpaceCache.set(drivePath, { timestamp: Date.now(), total, free });
        renderDiskSpace(statusDiskSpace, total, free);
      } else {
        const isUnc = platformOS === 'win32' && drivePath.startsWith('\\\\');
        const message = isUnc
          ? 'Disk space unavailable for network share'
          : 'Disk space unavailable';
        renderDiskSpaceUnavailable(statusDiskSpace, message);
      }
      diskSpaceDebounceTimer = null;
    }, DISK_SPACE_DEBOUNCE_MS);
  }

  function clearCache() {
    lastDiskSpacePath = '';
    diskSpaceCache.clear();
    if (diskSpaceDebounceTimer) {
      clearTimeout(diskSpaceDebounceTimer);
      diskSpaceDebounceTimer = null;
    }
  }

  return {
    updateDiskSpace,
    getCachedDiskSpace,
    renderDiskSpace,
    renderDiskSpaceUnavailable,
    clearCache,
  };
}
