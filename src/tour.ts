import type { Settings } from './types';

type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface TourStep {
  target: string;
  title: string;
  description: string;
  prefer?: TourPlacement;
}

export interface TourControllerOptions {
  getSettings: () => Settings;
  saveSettings: (settings: Settings) => Promise<unknown>;
  steps?: TourStep[];
  promptDelayMs?: number;
  onModalOpen?: (modal: HTMLElement) => void;
  onModalClose?: (modal: HTMLElement) => void;
}

export interface TourController {
  handleLaunch: (launchCount: number) => void;
  showPrompt: () => void;
  hidePrompt: () => void;
  startTour: () => void;
  endTour: (completed?: boolean) => void;
  isActive: () => boolean;
}

const TOUR_HIGHLIGHT_PADDING = 8;
const TOUR_TOOLTIP_MARGIN = 12;
const TOUR_VIEWPORT_PADDING = 16;

const defaultSteps: TourStep[] = [
  {
    target: '#home-view',
    title: 'Welcome to Home',
    description:
      'Your central hub for Quick Access, Recent Files, Bookmarks, and Drives. Click the Home button in the sidebar anytime to return here.',
    prefer: 'top',
  },
  {
    target: '.sidebar',
    title: 'Sidebar Navigation',
    description:
      'Quickly jump between Home, Bookmarks, Recent Files, and your Drives. Toggle the sidebar with Ctrl+B.',
    prefer: 'right',
  },
  {
    target: '.address-bar',
    title: 'Smart Address Bar',
    description:
      'Click breadcrumbs to jump to parent folders, or type a path directly to navigate anywhere instantly.',
    prefer: 'bottom',
  },
  {
    target: '#search-btn',
    title: 'Powerful Search',
    description:
      'Search files and folders with advanced filters. Press Ctrl+F to search the current folder, or Shift+Ctrl+F for global search.',
    prefer: 'bottom',
  },
  {
    target: '.command-palette-modal',
    title: 'Command Palette',
    description:
      'Access any action quickly with Ctrl+K. Type to search commands, navigate, or change settings.',
    prefer: 'bottom',
  },
  {
    target: '#view-options',
    title: 'View Modes',
    description:
      'Switch between Grid, List, and Column views to browse your files the way you prefer.',
    prefer: 'bottom',
  },
  {
    target: '#settings-btn',
    title: 'Customize Everything',
    description:
      'Change themes, adjust accessibility options, configure keyboard shortcuts, and much more in Settings.',
    prefer: 'left',
  },
];

const noopController: TourController = {
  handleLaunch: () => {},
  showPrompt: () => {},
  hidePrompt: () => {},
  startTour: () => {},
  endTour: () => {},
  isActive: () => false,
};

export function createTourController(options: TourControllerOptions): TourController {
  const steps = options.steps ?? defaultSteps;
  const promptDelayMs = options.promptDelayMs ?? 1500;

  const promptModal = document.getElementById('tour-prompt-modal') as HTMLElement | null;
  const promptSkip = document.getElementById('tour-prompt-skip') as HTMLButtonElement | null;
  const promptYes = document.getElementById('tour-prompt-yes') as HTMLButtonElement | null;
  const overlay = document.getElementById('tour-overlay') as HTMLElement | null;
  const highlight = document.getElementById('tour-highlight') as HTMLElement | null;
  const tooltip = document.getElementById('tour-tooltip') as HTMLElement | null;
  const stepCount = document.getElementById('tour-step-count') as HTMLElement | null;
  const title = document.getElementById('tour-title') as HTMLElement | null;
  const description = document.getElementById('tour-description') as HTMLElement | null;
  const back = document.getElementById('tour-back') as HTMLButtonElement | null;
  const skip = document.getElementById('tour-skip') as HTMLButtonElement | null;
  const next = document.getElementById('tour-next') as HTMLButtonElement | null;
  const close = document.getElementById('tour-close') as HTMLButtonElement | null;

  if (
    !promptModal ||
    !promptSkip ||
    !promptYes ||
    !overlay ||
    !highlight ||
    !tooltip ||
    !stepCount ||
    !title ||
    !description ||
    !back ||
    !skip ||
    !next ||
    !close
  ) {
    return noopController;
  }

  let tourActive = false;
  let tourStepIndex = 0;
  let tourUpdateRaf: number | null = null;
  let launchTimeout: number | null = null;
  let allowPaletteShortcut = false;

  const clearLaunchTimeout = (): void => {
    if (launchTimeout !== null) {
      window.clearTimeout(launchTimeout);
      launchTimeout = null;
    }
  };

  const saveSettings = async (): Promise<void> => {
    try {
      await options.saveSettings(options.getSettings());
    } catch {
      return;
    }
  };

  const acknowledgePrompt = async (): Promise<void> => {
    const settings = options.getSettings();
    settings.tourPromptDismissed = true;
    await saveSettings();
  };

  const setTourCompleted = async (completed: boolean): Promise<void> => {
    const settings = options.getSettings();
    settings.tourPromptDismissed = true;
    settings.tourCompleted = completed;
    await saveSettings();
  };

  const showPrompt = (): void => {
    if (tourActive) return;
    const settings = options.getSettings();
    if (settings.tourPromptDismissed || settings.tourCompleted) return;
    promptModal.style.display = 'flex';
    options.onModalOpen?.(promptModal);
  };

  const hidePrompt = (): void => {
    promptModal.style.display = 'none';
    options.onModalClose?.(promptModal);
  };

  const showOverlay = (): void => {
    overlay.style.display = 'block';
  };

  const hideOverlay = (): void => {
    overlay.style.display = 'none';
  };

  const getTargetRect = (selector: string): DOMRect | null => {
    const target = document.querySelector(selector) as HTMLElement | null;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return rect;
  };

  const applyHighlight = (rect: DOMRect | null): void => {
    if (!rect) {
      highlight.style.display = 'none';
      return;
    }

    const left = Math.max(rect.left - TOUR_HIGHLIGHT_PADDING, 0);
    const top = Math.max(rect.top - TOUR_HIGHLIGHT_PADDING, 0);
    const width = rect.width + TOUR_HIGHLIGHT_PADDING * 2;
    const height = rect.height + TOUR_HIGHLIGHT_PADDING * 2;

    highlight.style.display = 'block';
    highlight.style.left = `${left}px`;
    highlight.style.top = `${top}px`;
    highlight.style.width = `${width}px`;
    highlight.style.height = `${height}px`;
  };

  const clamp = (value: number, min: number, max: number): number => {
    return Math.min(Math.max(value, min), max);
  };

  const getPlacementOrder = (prefer?: TourPlacement): TourPlacement[] => {
    const base: TourPlacement[] = ['bottom', 'top', 'right', 'left', 'center'];
    if (!prefer) return base;
    return [prefer, ...base.filter((item) => item !== prefer)];
  };

  const computePlacementPosition = (
    placement: TourPlacement,
    targetRect: DOMRect,
    tooltipRect: DOMRect
  ): { left: number; top: number } => {
    switch (placement) {
      case 'top':
        return {
          left: targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
          top: targetRect.top - tooltipRect.height - TOUR_TOOLTIP_MARGIN,
        };
      case 'bottom':
        return {
          left: targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
          top: targetRect.bottom + TOUR_TOOLTIP_MARGIN,
        };
      case 'left':
        return {
          left: targetRect.left - tooltipRect.width - TOUR_TOOLTIP_MARGIN,
          top: targetRect.top + targetRect.height / 2 - tooltipRect.height / 2,
        };
      case 'right':
        return {
          left: targetRect.right + TOUR_TOOLTIP_MARGIN,
          top: targetRect.top + targetRect.height / 2 - tooltipRect.height / 2,
        };
      default:
        return {
          left: window.innerWidth / 2 - tooltipRect.width / 2,
          top: window.innerHeight / 2 - tooltipRect.height / 2,
        };
    }
  };

  const placementFits = (left: number, top: number, tooltipRect: DOMRect): boolean => {
    const right = left + tooltipRect.width;
    const bottom = top + tooltipRect.height;
    return (
      left >= TOUR_VIEWPORT_PADDING &&
      top >= TOUR_VIEWPORT_PADDING &&
      right <= window.innerWidth - TOUR_VIEWPORT_PADDING &&
      bottom <= window.innerHeight - TOUR_VIEWPORT_PADDING
    );
  };

  const positionTooltip = (targetRect: DOMRect | null, prefer?: TourPlacement): void => {
    if (!targetRect) {
      tooltip.style.left = `${TOUR_VIEWPORT_PADDING}px`;
      tooltip.style.top = `${TOUR_VIEWPORT_PADDING}px`;
      return;
    }

    const tooltipRect = tooltip.getBoundingClientRect();
    const placements = getPlacementOrder(prefer);
    let chosen: TourPlacement = 'center';
    let position = computePlacementPosition(chosen, targetRect, tooltipRect);

    for (const placement of placements) {
      const candidate = computePlacementPosition(placement, targetRect, tooltipRect);
      if (placementFits(candidate.left, candidate.top, tooltipRect)) {
        chosen = placement;
        position = candidate;
        break;
      }
    }

    const clampedLeft = clamp(
      position.left,
      TOUR_VIEWPORT_PADDING,
      window.innerWidth - tooltipRect.width - TOUR_VIEWPORT_PADDING
    );
    const clampedTop = clamp(
      position.top,
      TOUR_VIEWPORT_PADDING,
      window.innerHeight - tooltipRect.height - TOUR_VIEWPORT_PADDING
    );

    tooltip.style.left = `${clampedLeft}px`;
    tooltip.style.top = `${clampedTop}px`;
  };

  const updateStepUI = (updateText: boolean): void => {
    const step = steps[tourStepIndex];
    if (!step) return;

    if (updateText) {
      stepCount.textContent = `Step ${tourStepIndex + 1} of ${steps.length}`;
      title.textContent = step.title;
      description.textContent = step.description;
      back.disabled = tourStepIndex === 0;
      back.style.opacity = tourStepIndex === 0 ? '0.5' : '1';
      next.textContent = tourStepIndex === steps.length - 1 ? 'Finish' : 'Next';
    }

    if (step.target === '.command-palette-modal') {
      const paletteModal = document.getElementById('command-palette-modal');
      if (!paletteModal || paletteModal.style.display !== 'flex') {
        allowPaletteShortcut = true;
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })
        );
        window.requestAnimationFrame(() => {
          allowPaletteShortcut = false;
          if (tourActive && steps[tourStepIndex]?.target === '.command-palette-modal') {
            updateStepUI(false);
          }
        });
        return;
      }
    }

    const targetRect = getTargetRect(step.target);
    applyHighlight(targetRect);
    positionTooltip(targetRect, step.prefer);
  };

  const scheduleTourUpdate = (): void => {
    if (!tourActive) return;
    if (tourUpdateRaf !== null) return;
    tourUpdateRaf = window.requestAnimationFrame(() => {
      tourUpdateRaf = null;
      if (!tourActive) return;
      updateStepUI(false);
    });
  };

  const goToStep = (index: number): void => {
    const prevStep = steps[tourStepIndex];
    const boundedIndex = Math.max(0, Math.min(index, steps.length - 1));
    tourStepIndex = boundedIndex;
    if (prevStep?.target === '.command-palette-modal') {
      const paletteModal = document.getElementById('command-palette-modal');
      if (paletteModal && paletteModal.style.display === 'flex') {
        paletteModal.style.display = 'none';
      }
    }
    updateStepUI(true);
  };

  const attachListeners = (): void => {
    window.addEventListener('resize', scheduleTourUpdate, { passive: true });
    window.addEventListener('scroll', scheduleTourUpdate, true);
    document.addEventListener('keydown', handleKeydown, true);
  };

  const detachListeners = (): void => {
    window.removeEventListener('resize', scheduleTourUpdate);
    window.removeEventListener('scroll', scheduleTourUpdate, true);
    document.removeEventListener('keydown', handleKeydown, true);
  };

  const startTour = (): void => {
    if (tourActive || steps.length === 0) return;
    tourActive = true;
    tourStepIndex = 0;
    clearLaunchTimeout();
    hidePrompt();
    showOverlay();
    document.body.classList.add('tour-active');
    updateStepUI(true);
    attachListeners();
    next.focus();
  };

  const endTour = (completed: boolean = false): void => {
    if (!tourActive) return;
    tourActive = false;
    clearLaunchTimeout();
    hideOverlay();
    detachListeners();
    document.body.classList.remove('tour-active');
    const paletteModal = document.getElementById('command-palette-modal');
    if (paletteModal && paletteModal.style.display === 'flex') {
      paletteModal.style.display = 'none';
    }
    setTourCompleted(completed);
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!tourActive) return;
    const isPaletteStep = steps[tourStepIndex]?.target === '.command-palette-modal';
    const isPaletteShortcut =
      (event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K');
    if (isPaletteStep && isPaletteShortcut) {
      if (allowPaletteShortcut) {
        allowPaletteShortcut = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      endTour(false);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      if (tourStepIndex > 0) goToStep(tourStepIndex - 1);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (tourStepIndex === steps.length - 1) {
        endTour(true);
      } else {
        goToStep(tourStepIndex + 1);
      }
      return;
    }

    if (isPaletteStep) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleLaunch = (launchCount: number): void => {
    const settings = options.getSettings();
    if (launchCount !== 1) return;
    if (settings.tourPromptDismissed || settings.tourCompleted) return;
    clearLaunchTimeout();
    launchTimeout = window.setTimeout(showPrompt, promptDelayMs);
  };

  promptSkip.addEventListener('click', async () => {
    await acknowledgePrompt();
    hidePrompt();
  });

  promptYes.addEventListener('click', async () => {
    await acknowledgePrompt();
    startTour();
  });

  back.addEventListener('click', () => {
    if (tourStepIndex > 0) goToStep(tourStepIndex - 1);
  });

  next.addEventListener('click', () => {
    if (tourStepIndex === steps.length - 1) {
      endTour(true);
      return;
    }
    goToStep(tourStepIndex + 1);
  });

  skip.addEventListener('click', () => {
    endTour(false);
  });

  close.addEventListener('click', () => {
    endTour(false);
  });

  return {
    handleLaunch,
    showPrompt,
    hidePrompt,
    startTour,
    endTour,
    isActive: () => tourActive,
  };
}
