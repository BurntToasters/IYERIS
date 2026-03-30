import { getById } from './rendererDom.js';

let tooltipElement: HTMLElement | null = null;
let tooltipTimeout: NodeJS.Timeout | null = null;
let currentTooltipAnchor: HTMLElement | null = null;
let mouseoverDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
const TOOLTIP_DELAY = 500;
const tooltipTrackedElements = new Set<HTMLElement>();
let detachTooltipListeners: (() => void) | null = null;

export function initTooltipSystem(): void {
  if (detachTooltipListeners) {
    detachTooltipListeners();
    detachTooltipListeners = null;
  }
  if (tooltipTimeout) {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = null;
  }
  if (mouseoverDebounceTimeout) {
    clearTimeout(mouseoverDebounceTimeout);
    mouseoverDebounceTimeout = null;
  }
  for (const htmlEl of tooltipTrackedElements) {
    if (htmlEl.dataset.originalTitle) {
      htmlEl.setAttribute('title', htmlEl.dataset.originalTitle);
      delete htmlEl.dataset.originalTitle;
    }
  }
  tooltipTrackedElements.clear();
  if (currentTooltipAnchor) {
    currentTooltipAnchor.removeAttribute('aria-describedby');
    currentTooltipAnchor = null;
  }
  tooltipElement = getById('ui-tooltip');
  if (!tooltipElement) return;

  const mouseOverHandler = (e: MouseEvent) => {
    if (mouseoverDebounceTimeout) return;
    mouseoverDebounceTimeout = setTimeout(() => {
      mouseoverDebounceTimeout = null;
    }, 50);

    const target = e.target as HTMLElement;
    const titleAttr =
      target.getAttribute('title') || target.closest('[title]')?.getAttribute('title');

    if (
      titleAttr &&
      !target.closest('.tour-tooltip') &&
      !target.closest('.command-palette-modal')
    ) {
      const actualTarget = target.hasAttribute('title')
        ? target
        : (target.closest('[title]') as HTMLElement);
      if (actualTarget) {
        actualTarget.dataset.originalTitle = titleAttr;
        actualTarget.removeAttribute('title');
        tooltipTrackedElements.add(actualTarget);
      }

      if (tooltipTimeout) clearTimeout(tooltipTimeout);
      tooltipTimeout = setTimeout(() => {
        showTooltip(titleAttr, actualTarget || target);
      }, TOOLTIP_DELAY);
    }
  };

  const mouseOutHandler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const actualTarget = target.hasAttribute('data-original-title')
      ? target
      : (target.closest('[data-original-title]') as HTMLElement);

    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }

    if (actualTarget && actualTarget.dataset.originalTitle) {
      actualTarget.setAttribute('title', actualTarget.dataset.originalTitle);
      delete actualTarget.dataset.originalTitle;
      tooltipTrackedElements.delete(actualTarget);
    }

    if (currentTooltipAnchor) {
      currentTooltipAnchor.removeAttribute('aria-describedby');
      currentTooltipAnchor = null;
    }

    hideTooltip();
  };

  const scrollHandler = () => {
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }
    hideTooltip();
    for (const htmlEl of tooltipTrackedElements) {
      if (htmlEl.dataset.originalTitle) {
        htmlEl.setAttribute('title', htmlEl.dataset.originalTitle);
        delete htmlEl.dataset.originalTitle;
      }
    }
    tooltipTrackedElements.clear();
  };

  detachTooltipListeners = () => {
    document.removeEventListener('mouseover', mouseOverHandler);
    document.removeEventListener('mouseout', mouseOutHandler);
    document.removeEventListener('scroll', scrollHandler, true);
  };

  document.addEventListener('mouseover', mouseOverHandler);
  document.addEventListener('mouseout', mouseOutHandler);
  document.addEventListener('scroll', scrollHandler, true);
}

function showTooltip(text: string, anchor: HTMLElement): void {
  if (!tooltipElement) return;

  currentTooltipAnchor = anchor;
  anchor.setAttribute('aria-describedby', 'ui-tooltip');

  const content = tooltipElement.querySelector('.ui-tooltip-content');
  if (content) {
    content.textContent = text;
  }

  tooltipElement.style.display = 'block';

  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = tooltipElement.getBoundingClientRect();

  let top = anchorRect.bottom + 8;
  let left = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;

  tooltipElement.className = 'ui-tooltip bottom';

  if (top + tooltipRect.height > window.innerHeight) {
    top = anchorRect.top - tooltipRect.height - 8;
    tooltipElement.className = 'ui-tooltip top';
  }

  if (top < 8) top = 8;
  if (left < 8) left = 8;
  if (left + tooltipRect.width > window.innerWidth - 8) {
    left = window.innerWidth - tooltipRect.width - 8;
  }

  tooltipElement.style.left = `${left}px`;
  tooltipElement.style.top = `${top}px`;

  requestAnimationFrame(() => {
    tooltipElement?.classList.add('visible');
  });
}

function hideTooltip(): void {
  if (tooltipElement) {
    tooltipElement.classList.remove('visible');
    if (currentTooltipAnchor) {
      currentTooltipAnchor.removeAttribute('aria-describedby');
      currentTooltipAnchor = null;
    }
    setTimeout(() => {
      if (tooltipElement) tooltipElement.style.display = 'none';
    }, 150);
  }
}
