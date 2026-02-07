import type { FileItem } from './types';
import { clearHtml, getById } from './rendererDom.js';

type HoverCardDeps = {
  getFileItemData: (fileItem: HTMLElement) => FileItem | null;
  formatFileSize: (size: number) => string;
  getFileTypeFromName: (name: string) => string;
  getFileIcon: (name: string) => string;
  getThumbnailForPath: (path: string) => string | undefined;
  isRubberBandActive: () => boolean;
};

export function createHoverCardController(deps: HoverCardDeps) {
  let hoverCardEnabled = true;
  let hoverCardInitialized = false;
  let hoverCardTimeout: NodeJS.Timeout | null = null;
  let currentHoverItem: HTMLElement | null = null;

  let hoverCard: HTMLElement | null = null;
  let hoverThumbnail: HTMLElement | null = null;
  let hoverName: HTMLElement | null = null;
  let hoverSize: HTMLElement | null = null;
  let hoverType: HTMLElement | null = null;
  let hoverDate: HTMLElement | null = null;
  let hoverExtraRow: HTMLElement | null = null;
  let hoverExtraLabel: HTMLElement | null = null;
  let hoverExtraValue: HTMLElement | null = null;

  const ensureElements = () => {
    if (!hoverCard) hoverCard = getById('file-hover-card');
    if (!hoverThumbnail) hoverThumbnail = getById('hover-card-thumbnail');
    if (!hoverName) hoverName = getById('hover-card-name');
    if (!hoverSize) hoverSize = getById('hover-card-size');
    if (!hoverType) hoverType = getById('hover-card-type');
    if (!hoverDate) hoverDate = getById('hover-card-date');
    if (!hoverExtraRow) hoverExtraRow = getById('hover-card-extra-row');
    if (!hoverExtraLabel) hoverExtraLabel = getById('hover-card-extra-label');
    if (!hoverExtraValue) hoverExtraValue = getById('hover-card-extra-value');
  };

  const hideHoverCard = () => {
    ensureElements();
    if (hoverCard) {
      hoverCard.classList.remove('visible');
    }
    if (hoverCardTimeout) {
      clearTimeout(hoverCardTimeout);
      hoverCardTimeout = null;
    }
    currentHoverItem = null;
  };

  function setEnabled(enabled: boolean): void {
    hoverCardEnabled = enabled;
    if (!enabled) {
      hideHoverCard();
    }
  }

  function setup(): void {
    if (hoverCardInitialized) return;

    ensureElements();
    if (!hoverCard || !hoverThumbnail || !hoverName || !hoverSize || !hoverType || !hoverDate) {
      return;
    }

    hoverCardInitialized = true;

    const card = hoverCard;
    const thumbnail = hoverThumbnail;
    const nameEl = hoverName;
    const sizeEl = hoverSize;
    const typeEl = hoverType;
    const dateEl = hoverDate;

    const showHoverCard = (fileItem: HTMLElement, x: number, y: number) => {
      const item = deps.getFileItemData(fileItem);
      if (!item) return;

      nameEl.textContent = item.name;
      sizeEl.textContent = item.isDirectory ? '--' : deps.formatFileSize(item.size);
      typeEl.textContent = item.isDirectory ? 'Folder' : deps.getFileTypeFromName(item.name);
      dateEl.textContent = new Date(item.modified).toLocaleString();

      const cached = deps.getThumbnailForPath(item.path);
      clearHtml(thumbnail);
      if (cached) {
        const img = document.createElement('img');
        img.src = cached;
        img.alt = item.name;
        thumbnail.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'hover-icon';
        icon.innerHTML = deps.getFileIcon(item.name);
        thumbnail.appendChild(icon);
      }

      if (hoverExtraRow && hoverExtraLabel && hoverExtraValue) {
        hoverExtraRow.style.display = 'none';
      }

      const padding = 16;
      const cardWidth = 260;
      const cardHeight = 180;

      let posX = x + padding;
      let posY = y + padding;

      if (posX + cardWidth > window.innerWidth) {
        posX = x - cardWidth - padding;
      }
      if (posY + cardHeight > window.innerHeight) {
        posY = y - cardHeight - padding;
      }
      if (posX < 0) posX = padding;
      if (posY < 0) posY = padding;

      card.style.left = `${posX}px`;
      card.style.top = `${posY}px`;
      card.classList.add('visible');
    };

    document.addEventListener('mouseover', (e) => {
      if (!hoverCardEnabled) return;

      const target = e.target as HTMLElement;
      const fileItem = target.closest('.file-item') as HTMLElement;

      if (!fileItem || deps.isRubberBandActive()) {
        if (currentHoverItem && !fileItem) {
          hideHoverCard();
        }
        return;
      }

      if (fileItem === currentHoverItem) return;

      hideHoverCard();
      currentHoverItem = fileItem;

      hoverCardTimeout = setTimeout(() => {
        if (currentHoverItem === fileItem && document.body.contains(fileItem)) {
          const rect = fileItem.getBoundingClientRect();
          showHoverCard(fileItem, rect.right, rect.top);
        }
      }, 1000);
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target as HTMLElement;
      const relatedTarget = e.relatedTarget as HTMLElement;
      const fileItem = target.closest('.file-item');
      const toFileItem = relatedTarget?.closest('.file-item');
      const toHoverCard = relatedTarget?.closest('.file-hover-card');

      if (fileItem && !toFileItem && !toHoverCard) {
        hideHoverCard();
      }
    });

    document.addEventListener('scroll', hideHoverCard, true);
    document.addEventListener('mousedown', hideHoverCard);
  }

  return {
    setEnabled,
    setup,
  };
}
