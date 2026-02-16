import type { FileItem, Settings } from './types';
import { ignoreError } from './shared.js';
import { encodeFileUrl } from './rendererUtils.js';
import { generatePdfThumbnailPdfJs } from './rendererPdfViewer.js';
import { ANIMATED_IMAGE_EXTENSIONS } from './fileTypes.js';
import { THUMBNAIL_QUALITY_VALUES } from './constants.js';

const THUMBNAIL_ROOT_MARGIN = '100px';
const THUMBNAIL_CACHE_MAX = 100;
const THUMBNAIL_CONCURRENT_LOADS = 4;
const THUMBNAIL_QUEUE_MAX = 100;

type ThumbnailDeps = {
  getCurrentSettings: () => Settings;
  getFileIcon: (name: string) => string;
  getFileExtension: (filename: string) => string;
  formatFileSize: (bytes: number) => string;
  getFileByPath: (path: string) => FileItem | undefined;
};

export function createThumbnailController(deps: ThumbnailDeps) {
  const thumbnailCache = new Map<string, string>();
  let activeThumbnailLoads = 0;
  const pendingThumbnailLoads: Array<() => void> = [];

  let thumbnailObserver: IntersectionObserver | null = null;
  let thumbnailObserverRoot: HTMLElement | null = null;

  function enqueueThumbnailLoad(loadFn: () => Promise<void>): void {
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
      execute();
    } else if (pendingThumbnailLoads.length < THUMBNAIL_QUEUE_MAX) {
      pendingThumbnailLoads.push(execute);
    }
  }

  function resetThumbnailObserver(): void {
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      thumbnailObserver = null;
    }
    thumbnailObserverRoot = null;
  }

  function disconnectThumbnailObserver(): void {
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }
  }

  function getThumbnailObserver(): IntersectionObserver | null {
    const scrollContainer = document.getElementById('file-view');
    if (!scrollContainer) return null;
    if (thumbnailObserver && thumbnailObserverRoot === scrollContainer) return thumbnailObserver;

    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }

    thumbnailObserverRoot = scrollContainer;
    thumbnailObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const fileItem = entry.target as HTMLElement;
            const path = fileItem.dataset.path;
            const item = path ? deps.getFileByPath(path) : undefined;

            if (item && fileItem.classList.contains('has-thumbnail')) {
              loadThumbnail(fileItem, item);
              thumbnailObserver?.unobserve(fileItem);
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
    return thumbnailObserver;
  }

  function observeThumbnailItem(fileItem: HTMLElement): void {
    const observer = getThumbnailObserver();
    if (observer) {
      observer.observe(fileItem);
    }
  }

  const THUMBNAIL_QUALITY_MAP: Record<string, number> = { low: 0.5, medium: 0.7, high: 0.9 };
  function getThumbnailQuality(): number {
    return THUMBNAIL_QUALITY_MAP[deps.getCurrentSettings().thumbnailQuality || 'medium'] ?? 0.7;
  }

  function generateVideoThumbnail(videoUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';

      const cleanup = () => {
        video.src = '';
        video.load();
      };

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
            const dataUrl = canvas.toDataURL('image/jpeg', getThumbnailQuality());
            cleanup();
            resolve(dataUrl);
          } else {
            cleanup();
            reject(new Error('Could not get canvas context'));
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      video.onerror = () => {
        cleanup();
        reject(new Error('Failed to load video'));
      };

      setTimeout(() => {
        cleanup();
        reject(new Error('Video thumbnail timeout'));
      }, 5000);

      video.src = videoUrl;
    });
  }

  async function generateAudioWaveform(audioUrl: string): Promise<string> {
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

      fetch(audioUrl)
        .then((response) => response.arrayBuffer())
        .then((arrayBuffer) => audioContext.decodeAudioData(arrayBuffer))
        .then((audioBuffer) => {
          const rawData = audioBuffer.getChannelData(0);
          const samples = 80;
          const blockSize = Math.floor(rawData.length / samples);
          const filteredData: number[] = [];

          for (let i = 0; i < samples; i++) {
            const blockStart = blockSize * i;
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
              sum += Math.abs(rawData[blockStart + j]);
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

          audioContext.close();
          resolve(canvas.toDataURL('image/jpeg', getThumbnailQuality()));
        })
        .catch((error) => {
          audioContext.close();
          reject(error);
        });
    });
  }

  function generatePdfThumbnail(pdfUrl: string): Promise<string> {
    const q = deps.getCurrentSettings().thumbnailQuality;
    const quality: 'low' | 'medium' | 'high' =
      q === 'low' ? 'low' : q === 'high' ? 'high' : 'medium';
    return generatePdfThumbnailPdfJs(pdfUrl, quality);
  }

  function loadThumbnail(fileItem: HTMLElement, item: FileItem) {
    const cached = thumbnailCache.get(item.path);
    if (cached) {
      thumbnailCache.delete(item.path);
      thumbnailCache.set(item.path, cached);
      const iconDiv = fileItem.querySelector('.file-icon');
      if (iconDiv) {
        renderThumbnailImage(iconDiv as HTMLElement, cached, item, fileItem);
      }
      return;
    }

    const thumbnailType = fileItem.dataset.thumbnailType || 'image';

    enqueueThumbnailLoad(async () => {
      try {
        if (!document.body.contains(fileItem)) {
          return;
        }

        const iconDiv = fileItem.querySelector('.file-icon');

        if (iconDiv) {
          iconDiv.innerHTML = `<div class="spinner" style="width: 30px; height: 30px; border-width: 2px;"></div>`;
        }

        const currentSettings = deps.getCurrentSettings();

        if (
          thumbnailType !== 'audio' &&
          thumbnailType !== 'pdf' &&
          item.size > (currentSettings.maxThumbnailSizeMB || 10) * 1024 * 1024
        ) {
          if (iconDiv) {
            iconDiv.innerHTML = deps.getFileIcon(item.name);
          }
          fileItem.classList.remove('has-thumbnail');
          return;
        }

        if (
          thumbnailType === 'pdf' &&
          item.size > (currentSettings.maxPreviewSizeMB || 50) * 1024 * 1024
        ) {
          if (iconDiv) {
            iconDiv.innerHTML = deps.getFileIcon(item.name);
          }
          fileItem.classList.remove('has-thumbnail');
          return;
        }

        const diskCacheResult = await window.electronAPI.getCachedThumbnail(item.path);
        if (diskCacheResult.success && diskCacheResult.dataUrl) {
          if (!document.body.contains(fileItem)) return;
          cacheThumbnail(item.path, diskCacheResult.dataUrl);
          if (iconDiv) {
            renderThumbnailImage(iconDiv as HTMLElement, diskCacheResult.dataUrl, item, fileItem);
          }
          return;
        }

        const fileUrl = encodeFileUrl(item.path);

        if (!document.body.contains(fileItem)) {
          return;
        }

        let thumbnailUrl = fileUrl;
        let shouldCacheToDisk = false;

        const thumbnailGenerators: Record<string, (url: string) => Promise<string>> = {
          video: generateVideoThumbnail,
          audio: generateAudioWaveform,
          pdf: generatePdfThumbnail,
        };
        const generator = thumbnailGenerators[thumbnailType];
        if (generator) {
          try {
            thumbnailUrl = await generator(fileUrl);
            shouldCacheToDisk = true;
          } catch {
            if (iconDiv) iconDiv.innerHTML = deps.getFileIcon(item.name);
            fileItem.classList.remove('has-thumbnail');
            return;
          }
        }

        if (!document.body.contains(fileItem)) {
          return;
        }

        if (iconDiv) {
          cacheThumbnail(item.path, thumbnailUrl);
          renderThumbnailImage(iconDiv as HTMLElement, thumbnailUrl, item, fileItem);

          if (shouldCacheToDisk && thumbnailUrl.startsWith('data:')) {
            window.electronAPI.saveCachedThumbnail(item.path, thumbnailUrl).catch(ignoreError);
          }
        }
      } catch {
        if (!document.body.contains(fileItem)) {
          return;
        }
        const iconDiv = fileItem.querySelector('.file-icon');
        if (iconDiv) {
          iconDiv.innerHTML = deps.getFileIcon(item.name);
        }
        fileItem.classList.remove('has-thumbnail');
      }
    });
  }

  function cacheThumbnail(path: string, url: string): void {
    if (thumbnailCache.has(path)) {
      thumbnailCache.delete(path);
    } else if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
      const firstKey = thumbnailCache.keys().next().value;
      if (firstKey) thumbnailCache.delete(firstKey);
    }
    thumbnailCache.set(path, url);
  }

  function renderThumbnailImage(
    iconDiv: HTMLElement,
    thumbnailUrl: string,
    item: FileItem,
    fileItem: HTMLElement
  ): void {
    iconDiv.innerHTML = '';
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
      if (!document.body.contains(fileItem)) {
        return;
      }
      iconDiv.innerHTML = deps.getFileIcon(item.name);
      fileItem.classList.remove('has-thumbnail');
    });
    iconDiv.appendChild(img);
  }

  async function updateThumbnailCacheSize(): Promise<void> {
    const sizeElement = document.getElementById('thumbnail-cache-size');
    if (!sizeElement) return;

    const result = await window.electronAPI.getThumbnailCacheSize();
    if (result.success && typeof result.sizeBytes === 'number') {
      sizeElement.textContent = `(${deps.formatFileSize(result.sizeBytes)}, ${result.fileCount} files)`;
    } else {
      sizeElement.textContent = '';
    }
  }

  return {
    resetThumbnailObserver,
    disconnectThumbnailObserver,
    observeThumbnailItem,
    loadThumbnail,
    updateThumbnailCacheSize,
    getThumbnailForPath: (path: string) => thumbnailCache.get(path),
    clearThumbnailCache: () => thumbnailCache.clear(),
    clearPendingThumbnailLoads: () => {
      pendingThumbnailLoads.length = 0;
    },
  };
}
