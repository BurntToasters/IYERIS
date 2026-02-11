import { getById } from './rendererDom.js';

let tooltipElement: HTMLElement | null = null;
let tooltipTimeout: NodeJS.Timeout | null = null;
const TOOLTIP_DELAY = 500;

export function initTooltipSystem(): void {
  tooltipElement = getById('ui-tooltip');
  if (!tooltipElement) return;

  document.addEventListener('mouseover', (e) => {
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
      }

      tooltipTimeout = setTimeout(() => {
        showTooltip(titleAttr, actualTarget || target);
      }, TOOLTIP_DELAY);
    }
  });

  document.addEventListener('mouseout', (e) => {
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
    }

    hideTooltip();
  });
}

function showTooltip(text: string, anchor: HTMLElement): void {
  if (!tooltipElement) return;

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
    setTimeout(() => {
      if (tooltipElement) tooltipElement.style.display = 'none';
    }, 150);
  }
}
