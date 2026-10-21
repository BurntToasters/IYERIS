import type { FileItem, Settings } from './types';
import { ignoreError } from './shared.js';
import { encodeFileUrl } from './rendererUtils.js';
import { generatePdfThumbnailPdfJs } from './rendererPdfViewer.js';
import { ANIMATED_IMAGE_EXTENSIONS } from './fileTypes.js';
import { isForeground, onActivityChange } from './rendererActivityState.js';
import {
  THUMBNAIL_TIMEOUT_MS,
  DEFAULT_MAX_THUMBNAIL_SIZE_MB,
  DEFAULT_MAX_PREVIEW_SIZE_MB,
} from './rendererLocalConstants.js';

const MEDIA_THUMBNAIL_TYPES = new Set(['video', 'audio', 'pdf', 'office']);

const THUMBNAIL_ROOT_MARGIN = '100px';
const THUMBNAIL_CACHE_MAX = 100;
const THUMBNAIL_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const THUMBNAIL_CONCURRENT_LOADS = 4;
const THUMBNAIL_QUEUE_MAX = 100;
type ThumbnailQuality = 'low' | 'medium' | 'high';
type ThumbnailCacheEntry = { url: string; path: string; bytes: number };
type ThumbnailWaiter = {
  fileItem: HTMLElement;
  item: FileItem;
  thumbnailType: string;
  quality: ThumbnailQuality;
  cacheKey: string;
  requestId: number;
};
type ThumbnailInflight = { waiters: Map<HTMLElement, ThumbnailWaiter> };

type ThumbnailDeps = {
  getCurrentSettings: () => Settings;
  getFileIcon: (name: string) => string;
  getFileExtension: (filename: string) => string;
  formatFileSize: (bytes: number) => string;
  getFileByPath: (path: string) => FileItem | undefined;
};

export function createThumbnailController(deps: ThumbnailDeps) {
  const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
  let thumbnailCacheBytes = 0;
  let activeThumbnailLoads = 0;
  const pendingThumbnailLoads: Array<() => void> = [];
  const inflightThumbnails = new Map<string, ThumbnailInflight>();
  const rowRequests = new WeakMap<HTMLElement, { cacheKey: string; requestId: number }>();
  let nextRequestId = 0;

  const thumbnailObservers = new Map<string, IntersectionObserver>();

  const activeMediaCleanups = new Set<() => void>();
  let paused = false;

  function pauseThumbnails(): void {
    if (paused) return;
    paused = true;

    pendingThumbnailLoads.length = 0;
    inflightThumbnails.clear();
    for (const cleanup of Array.from(activeMediaCleanups)) {
      try {
        cleanup();
      } catch (error) {
        ignoreError(error);
      }
    }
    activeMediaCleanups.clear();
  }

  function resumeThumbnails(): void {
    if (!paused) return;
    paused = false;
    // Re-drive observers for unrendered thumbnails in view.
    thumbnailObservers.forEach((observer, rootId) => {
      const root = document.getElementById(rootId);
      if (!root) return;
      root.querySelectorAll<HTMLElement>('.file-item.has-thumbnail').forEach((fileItem) => {
        if (fileItem.querySelector('img.file-thumbnail')) return;
        observer.unobserve(fileItem);
        observer.observe(fileItem);
      });
    });
  }

  const cleanupActivity = onActivityChange((foreground) => {
    if (foreground) {
      resumeThumbnails();
    } else {
      pauseThumbnails();
    }
  });

  function enqueueThumbnailLoad(loadFn: () => Promise<void>): boolean {
    const execute = async () => {
      activeThumbnailLoads++;
      try {
        await loadFn();
      } finally {
        activeThumbnailLoads--;
        if (pendingThumbnailLoads.length > 0) {
          const next = pendingThumbnailLoads.shift();
          if (next) next();
        }
      }
    };

    if (activeThumbnailLoads < THUMBNAIL_CONCURRENT_LOADS) {
      execute().catch(ignoreError);
      return true;
    } else if (pendingThumbnailLoads.length < THUMBNAIL_QUEUE_MAX) {
      pendingThumbnailLoads.push(execute);
      return true;
    }
    return false;
  }

  function resetThumbnailObserver(): void {
    thumbnailObservers.forEach((observer) => observer.disconnect());
    thumbnailObservers.clear();
  }

  function disconnectThumbnailObserver(): void {
    thumbnailObservers.forEach((observer) => observer.disconnect());
  }

  function getThumbnailObserver(rootId = 'file-view'): IntersectionObserver | null {
    const scrollContainer = document.getElementById(rootId);
    if (!scrollContainer) return null;
    const existing = thumbnailObservers.get(rootId);
    if (existing) return existing;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            if (paused || !isForeground()) return;
            const fileItem = entry.target as HTMLElement;
            const path = fileItem.dataset.path;
            const item = path ? deps.getFileByPath(path) : undefined;

            if (item && fileItem.classList.contains('has-thumbnail')) {
              loadThumbnail(fileItem, item);
              observer.unobserve(fileItem);
            }
          }
        });
      },
      {
        root: scrollContainer,
        rootMargin: THUMBNAIL_ROOT_MARGIN,
        threshold: 0.01,
      }
    );
    thumbnailObservers.set(rootId, observer);
    return observer;
  }

  function observeThumbnailItem(fileItem: HTMLElement, rootId = 'file-view'): void {
    const observer = getThumbnailObserver(rootId);
    if (observer) {
      observer.observe(fileItem);
    }
  }

  const THUMBNAIL_QUALITY_MAP: Record<ThumbnailQuality, number> = {
    low: 0.5,
    medium: 0.7,
    high: 0.9,
  };
  function getThumbnailQualityName(): ThumbnailQuality {
    const quality = deps.getCurrentSettings().thumbnailQuality;
    return quality === 'low' || quality === 'high' ? quality : 'medium';
  }

  function getThumbnailCacheKey(
    item: FileItem,
    thumbnailType: string,
    quality: ThumbnailQuality
  ): string {
    const fingerprint = getThumbnailFingerprint(item);
    return JSON.stringify([
      item.path,
      fingerprint.mtimeMs,
      fingerprint.size,
      quality,
      thumbnailType,
    ]);
  }

  function getThumbnailFingerprint(item: FileItem): { mtimeMs: number; size: number } {
    const modified =
      item.modified instanceof Date ? item.modified.getTime() : Number(item.modified);
    const size = Number(item.size);
    return {
      mtimeMs: Number.isFinite(modified) && modified >= 0 ? Math.trunc(modified) : 0,
      size: Number.isFinite(size) && size >= 0 ? Math.trunc(size) : 0,
    };
  }

  function getThumbnailVariant(thumbnailType: string, quality: ThumbnailQuality): string {
    return `v1:${quality}:${thumbnailType}`;
  }

  function getThumbnailTypeForPath(path: string): string {
    const fileItems = document.querySelectorAll<HTMLElement>('.file-item[data-path]');
    for (const fileItem of fileItems) {
      if (fileItem.dataset.path === path) return fileItem.dataset.thumbnailType || 'image';
    }
    return 'image';
  }

  function requestIdForRow(fileItem: HTMLElement, cacheKey: string): number {
    const existing = rowRequests.get(fileItem);
    if (existing?.cacheKey === cacheKey) return existing.requestId;
    const requestId = ++nextRequestId;
    rowRequests.set(fileItem, { cacheKey, requestId });
    return requestId;
  }

  function isCurrentWaiter(waiter: ThumbnailWaiter): boolean {
    const { fileItem, item, thumbnailType, quality, cacheKey, requestId } = waiter;
    if (!document.body.contains(fileItem)) return false;
    if (fileItem.dataset.path && fileItem.dataset.path !== item.path) return false;
    if (rowRequests.get(fileItem)?.requestId !== requestId) return false;
    if ((fileItem.dataset.thumbnailType || 'image') !== thumbnailType) return false;
    if (getThumbnailQualityName() !== quality) return false;

    const currentItem = deps.getFileByPath(item.path);
    return !currentItem || getThumbnailCacheKey(currentItem, thumbnailType, quality) === cacheKey;
  }

  function renderForCurrentWaiters(
    inflight: ThumbnailInflight,
    cacheKey: string,
    thumbnailType: string,
    quality: ThumbnailQuality,
    thumbnailUrl: string
  ): void {
    const currentWaiters = Array.from(inflight.waiters.values()).filter(isCurrentWaiter);
    if (currentWaiters.length === 0) return;

    const cacheItem = currentWaiters[0]?.item;
    if (cacheItem) cacheThumbnail(cacheKey, thumbnailUrl, cacheItem.path);
    for (const waiter of currentWaiters) {
      const iconDiv = waiter.fileItem.querySelector('.file-icon');
      if (iconDiv) {
        renderThumbnailImage(
          iconDiv as HTMLElement,
          thumbnailUrl,
          waiter.item,
          waiter.fileItem,
          () => isCurrentWaiter(waiter)
        );
      }
    }
  }

  function generateVideoThumbnail(videoUrl: string, quality: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';

      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        video.src = '';
        video.load();
        activeMediaCleanups.delete(abort);
      };

      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };

      const abort = () => finish(() => reject(new Error('Video thumbnail aborted')));
      activeMediaCleanups.add(abort);

      video.onloadedmetadata = () => {
        video.currentTime = Math.min(1, video.duration * 0.1);
      };

      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas');
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const size = 160 * dpr;
          const aspectRatio = video.videoWidth / video.videoHeight;

          if (aspectRatio > 1) {
            canvas.width = size;
            canvas.height = Math.round(size / aspectRatio);
          } else {
            canvas.width = Math.round(size * aspectRatio);
            canvas.height = size;
          }

          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            finish(() => resolve(dataUrl));
          } else {
            finish(() => reject(new Error('Could not get canvas context')));
          }
        } catch (err) {
          finish(() => reject(err));
        }
      };

      video.onerror = () => finish(() => reject(new Error('Failed to load video')));

      timeout = setTimeout(
        () => finish(() => reject(new Error('Video thumbnail timeout'))),
        THUMBNAIL_TIMEOUT_MS
      );

      video.src = videoUrl;
    });
  }

  async function generateAudioWaveform(audioUrl: string, quality: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(160 * dpr);
      canvas.height = Math.round(160 * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Cannot get canvas context'));
        return;
      }
      ctx.scale(dpr, dpr);

      const audioContext = new AudioContext();
      const abortController = new AbortController();
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          activeMediaCleanups.delete(abort);
          abortController.abort();
          audioContext.close();
          reject(new Error('Audio waveform timeout'));
        }
      }, THUMBNAIL_TIMEOUT_MS);

      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        activeMediaCleanups.delete(abort);
        abortController.abort();
        audioContext.close();
        reject(new Error('Audio waveform aborted'));
      };
      activeMediaCleanups.add(abort);

      fetch(audioUrl, { signal: abortController.signal })
        .then((response) => response.arrayBuffer())
        .then((arrayBuffer) => audioContext.decodeAudioData(arrayBuffer))
        .then((audioBuffer) => {
          if (settled) return;
          const rawData = audioBuffer.getChannelData(0);
          const samples = 80;
          const blockSize = Math.floor(rawData.length / samples);
          const filteredData: number[] = [];

          for (let i = 0; i < samples; i++) {
            const blockStart = blockSize * i;
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
              sum += Math.abs(rawData[blockStart + j] ?? 0);
            }
            filteredData.push(sum / blockSize);
          }

          const maxVal = Math.max(...filteredData);
          const normalizedData = filteredData.map((d) => d / maxVal);

          const logicalW = 160;
          const logicalH = 160;

          ctx.fillStyle = 'rgba(30, 30, 40, 0.8)';
          ctx.fillRect(0, 0, logicalW, logicalH);

          const barWidth = logicalW / samples;
          const centerY = logicalH / 2;

          ctx.fillStyle = 'rgba(99, 179, 237, 0.8)';
          normalizedData.forEach((value, index) => {
            const barHeight = value * (logicalH * 0.4);
            const x = index * barWidth;
            ctx.fillRect(x, centerY - barHeight, barWidth - 1, barHeight * 2);
          });

          ctx.fillStyle = 'rgba(99, 179, 237, 0.4)';
          ctx.beginPath();
          ctx.arc(logicalW / 2, logicalH / 2, 25, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.beginPath();
          ctx.moveTo(logicalW / 2 - 8, logicalH / 2 - 12);
          ctx.lineTo(logicalW / 2 + 12, logicalH / 2);
          ctx.lineTo(logicalW / 2 - 8, logicalH / 2 + 12);
          ctx.closePath();
          ctx.fill();

          settled = true;
          clearTimeout(timeout);
          activeMediaCleanups.delete(abort);
          audioContext.close();
          resolve(canvas.toDataURL('image/jpeg', quality));
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          activeMediaCleanups.delete(abort);
          audioContext.close();
          reject(error);
        });
    });
  }

  function generatePdfThumbnail(pdfUrl: string, quality: ThumbnailQuality): Promise<string> {
    return generatePdfThumbnailPdfJs(pdfUrl, quality);
  }

  async function generateOfficeThumbnail(filePath: string): Promise<string> {
    const maxBytes =
      (deps.getCurrentSettings().maxThumbnailSizeMB || DEFAULT_MAX_THUMBNAIL_SIZE_MB) * 1024 * 1024;
    const result = await window.tauriAPI.getEmbeddedOfficeThumbnail(filePath, maxBytes);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.dataUrl;
  }

  function loadThumbnail(fileItem: HTMLElement, item: FileItem) {
    const thumbnailType = fileItem.dataset.thumbnailType || 'image';
    const quality = getThumbnailQualityName();
    const cacheKey = getThumbnailCacheKey(item, thumbnailType, quality);
    const requestId = requestIdForRow(fileItem, cacheKey);
    const waiter: ThumbnailWaiter = {
      fileItem,
      item,
      thumbnailType,
      quality,
      cacheKey,
      requestId,
    };

    const cached = thumbnailCache.get(cacheKey);
    if (cached) {
      thumbnailCache.delete(cacheKey);
      thumbnailCache.set(cacheKey, cached);
      const iconDiv = fileItem.querySelector('.file-icon');
      if (iconDiv && isCurrentWaiter(waiter)) {
        renderThumbnailImage(iconDiv as HTMLElement, cached.url, item, fileItem, () =>
          isCurrentWaiter(waiter)
        );
      }
      return;
    }

    const existingInflight = inflightThumbnails.get(cacheKey);
    if (existingInflight) {
      existingInflight.waiters.set(fileItem, waiter);
      return;
    }

    const inflight: ThumbnailInflight = { waiters: new Map([[fileItem, waiter]]) };
    inflightThumbnails.set(cacheKey, inflight);
    const qualityValue = THUMBNAIL_QUALITY_MAP[quality];
    const variant = getThumbnailVariant(thumbnailType, quality);

    const scheduled = enqueueThumbnailLoad(async () => {
      try {
        if (![...inflight.waiters.values()].some(isCurrentWaiter)) return;

        const firstWaiter = [...inflight.waiters.values()].find(isCurrentWaiter);
        const iconDiv = firstWaiter?.fileItem.querySelector('.file-icon');
        if (iconDiv) {
          // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
          iconDiv.innerHTML = `<div class="spinner" style="width: 30px; height: 30px; border-width: 2px;"></div>`;
        }

        const currentSettings = deps.getCurrentSettings();

        if (
          thumbnailType !== 'pdf' &&
          thumbnailType !== 'office' &&
          item.size >
            (currentSettings.maxThumbnailSizeMB || DEFAULT_MAX_THUMBNAIL_SIZE_MB) * 1024 * 1024
        ) {
          for (const current of inflight.waiters.values()) {
            if (!isCurrentWaiter(current)) continue;
            const currentIcon = current.fileItem.querySelector('.file-icon');
            if (currentIcon) currentIcon.innerHTML = deps.getFileIcon(current.item.name);
            current.fileItem.classList.remove('has-thumbnail');
          }
          return;
        }

        if (
          thumbnailType === 'pdf' &&
          item.size >
            (currentSettings.maxPreviewSizeMB || DEFAULT_MAX_PREVIEW_SIZE_MB) * 1024 * 1024
        ) {
          for (const current of inflight.waiters.values()) {
            if (!isCurrentWaiter(current)) continue;
            const currentIcon = current.fileItem.querySelector('.file-icon');
            if (currentIcon) currentIcon.innerHTML = deps.getFileIcon(current.item.name);
            current.fileItem.classList.remove('has-thumbnail');
          }
          return;
        }

        const fingerprint = getThumbnailFingerprint(item);
        const thumbMtime = fingerprint.mtimeMs;
        const thumbSize = fingerprint.size;
        const diskCacheResult = await window.tauriAPI.getCachedThumbnail(
          item.path,
          thumbMtime,
          thumbSize,
          variant
        );
        if (diskCacheResult.success) {
          renderForCurrentWaiters(
            inflight,
            cacheKey,
            thumbnailType,
            quality,
            diskCacheResult.dataUrl
          );
          return;
        }

        const fileUrl = encodeFileUrl(item.path);

        if (![...inflight.waiters.values()].some(isCurrentWaiter)) {
          return;
        }

        // Defensive: no heavy media decode in bg. Keep has-thumbnail so resume re-drives.
        if (MEDIA_THUMBNAIL_TYPES.has(thumbnailType) && !isForeground()) {
          for (const current of inflight.waiters.values()) {
            if (!isCurrentWaiter(current)) continue;
            const currentIcon = current.fileItem.querySelector('.file-icon');
            if (currentIcon) currentIcon.innerHTML = deps.getFileIcon(current.item.name);
          }
          return;
        }

        let thumbnailUrl = fileUrl;
        let shouldCacheToDisk = false;

        if (thumbnailType === 'office') {
          try {
            thumbnailUrl = await generateOfficeThumbnail(item.path);
            shouldCacheToDisk = true;
          } catch {
            for (const current of inflight.waiters.values()) {
              if (!isCurrentWaiter(current)) continue;
              const currentIcon = current.fileItem.querySelector('.file-icon');
              if (currentIcon) currentIcon.innerHTML = deps.getFileIcon(current.item.name);
              current.fileItem.classList.remove('has-thumbnail');
            }
            return;
          }
        } else {
          const thumbnailGenerators: Record<string, (url: string) => Promise<string>> = {
            video: (url) => generateVideoThumbnail(url, qualityValue),
            audio: (url) => generateAudioWaveform(url, qualityValue),
            pdf: (url) => generatePdfThumbnail(url, quality),
          };
          const generator = thumbnailGenerators[thumbnailType];
          if (generator) {
            try {
              thumbnailUrl = await generator(fileUrl);
              shouldCacheToDisk = true;
            } catch {
              for (const current of inflight.waiters.values()) {
                if (!isCurrentWaiter(current)) continue;
                const currentIcon = current.fileItem.querySelector('.file-icon');
                if (currentIcon) currentIcon.innerHTML = deps.getFileIcon(current.item.name);
                current.fileItem.classList.remove('has-thumbnail');
              }
              return;
            }
          }
        }

        if (![...inflight.waiters.values()].some(isCurrentWaiter)) return;
        renderForCurrentWaiters(inflight, cacheKey, thumbnailType, quality, thumbnailUrl);

        if (shouldCacheToDisk && thumbnailUrl.startsWith('data:')) {
          window.tauriAPI
            .saveCachedThumbnail(item.path, thumbnailUrl, thumbMtime, thumbSize, variant)
            .catch(ignoreError);
        }
      } catch {
        for (const current of inflight.waiters.values()) {
          if (!isCurrentWaiter(current)) continue;
          const iconDiv = current.fileItem.querySelector('.file-icon');
          if (iconDiv) iconDiv.innerHTML = deps.getFileIcon(current.item.name);
          current.fileItem.classList.remove('has-thumbnail');
        }
      } finally {
        if (inflightThumbnails.get(cacheKey) === inflight) {
          inflightThumbnails.delete(cacheKey);
        }
      }
    });
    if (!scheduled) {
      if (inflightThumbnails.get(cacheKey) === inflight) {
        inflightThumbnails.delete(cacheKey);
      }
    }
  }

  function removeThumbnailCacheEntry(cacheKey: string): void {
    const entry = thumbnailCache.get(cacheKey);
    if (!entry) return;
    thumbnailCache.delete(cacheKey);
    thumbnailCacheBytes = Math.max(0, thumbnailCacheBytes - entry.bytes);
  }

  function cacheThumbnail(cacheKey: string, url: string, path: string): void {
    removeThumbnailCacheEntry(cacheKey);
    // Data URLs are UTF-16 in memory; length * 2 is a conservative estimate.
    const bytes = url.length * 2;
    thumbnailCache.set(cacheKey, { url, path, bytes });
    thumbnailCacheBytes += bytes;
    while (
      thumbnailCache.size > 0 &&
      (thumbnailCache.size > THUMBNAIL_CACHE_MAX || thumbnailCacheBytes > THUMBNAIL_CACHE_MAX_BYTES)
    ) {
      const oldestKey = thumbnailCache.keys().next().value;
      if (oldestKey === undefined) break;
      removeThumbnailCacheEntry(oldestKey);
    }
  }

  function renderThumbnailImage(
    iconDiv: HTMLElement,
    thumbnailUrl: string,
    item: FileItem,
    fileItem: HTMLElement,
    isStillCurrent: () => boolean
  ): void {
    iconDiv.replaceChildren();
    const img = document.createElement('img');
    img.src = thumbnailUrl;
    img.className = 'file-thumbnail';
    img.alt = item.name;
    img.style.opacity = '0';
    img.loading = 'lazy';
    img.decoding = 'async';

    img.addEventListener(
      'load',
      () => {
        if (!isStillCurrent() || iconDiv.querySelector('img.file-thumbnail') !== img) return;
        img.style.transition = 'opacity 0.2s ease';
        img.style.opacity = '1';
      },
      { once: true }
    );

    const ext = deps.getFileExtension(item.name);
    if (ANIMATED_IMAGE_EXTENSIONS.has(ext)) {
      img.dataset.animated = 'true';
      img.dataset.staticSrc = thumbnailUrl;
      img.dataset.animatedSrc = encodeFileUrl(item.path);
    }

    img.addEventListener('error', () => {
      if (!isStillCurrent() || iconDiv.querySelector('img.file-thumbnail') !== img) return;
      iconDiv.innerHTML = deps.getFileIcon(item.name);
      fileItem.classList.remove('has-thumbnail');
    });
    iconDiv.appendChild(img);
  }

  async function updateThumbnailCacheSize(): Promise<void> {
    const sizeElement = document.getElementById('thumbnail-cache-size');
    if (!sizeElement) return;

    const result = await window.tauriAPI.getThumbnailCacheSize();
    if (!result.success) {
      sizeElement.textContent = '';
      return;
    }
    sizeElement.textContent = `(${deps.formatFileSize(result.sizeBytes)}, ${result.fileCount} files)`;
  }

  return {
    resetThumbnailObserver,
    disconnectThumbnailObserver,
    observeThumbnailItem,
    loadThumbnail,
    updateThumbnailCacheSize,
    pauseThumbnails,
    resumeThumbnails,
    destroy: cleanupActivity,
    getThumbnailForPath: (path: string, item?: FileItem) => {
      const quality = getThumbnailQualityName();
      if (item) {
        const key = getThumbnailCacheKey(item, getThumbnailTypeForPath(path), quality);
        return thumbnailCache.get(key)?.url;
      }
      const entries = Array.from(thumbnailCache.values());
      return entries.reverse().find((entry) => entry.path === path)?.url;
    },
    clearThumbnailCache: () => {
      thumbnailCache.clear();
      thumbnailCacheBytes = 0;
      inflightThumbnails.clear();
    },
    clearPendingThumbnailLoads: () => {
      pendingThumbnailLoads.length = 0;
      inflightThumbnails.clear();
    },
  };
}
