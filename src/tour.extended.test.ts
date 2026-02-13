import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Settings } from './types';
import { createTourController, type TourStep, type TourController } from './tour';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    tourPromptDismissed: false,
    tourCompleted: false,
    ...overrides,
  } as Settings;
}

function setupTourDOM(): void {
  document.body.innerHTML = `
    <div id="tour-prompt-modal" style="display:none"></div>
    <button id="tour-prompt-skip"></button>
    <button id="tour-prompt-yes"></button>
    <div id="tour-overlay" style="display:none"></div>
    <div id="tour-highlight" style="display:none"></div>
    <div id="tour-tooltip" style="display:none"></div>
    <span id="tour-step-count"></span>
    <span id="tour-title"></span>
    <span id="tour-description"></span>
    <button id="tour-back"></button>
    <button id="tour-skip"></button>
    <button id="tour-next"></button>
    <button id="tour-close"></button>
    <div id="home-view" style="width:100px;height:100px"></div>
    <div class="sidebar" style="width:50px;height:200px"></div>
    <div class="address-bar" style="width:300px;height:40px"></div>
    <div id="search-btn" style="width:40px;height:40px"></div>
    <div class="command-palette-modal" style="width:400px;height:300px"></div>
    <div id="command-palette-modal" style="display:none"></div>
    <div id="view-options" style="width:40px;height:40px"></div>
    <div id="settings-btn" style="width:40px;height:40px"></div>
  `;
}

function mockBoundingClientRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  el.getBoundingClientRect = vi.fn().mockReturnValue({
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect);
}

const testSteps: TourStep[] = [
  { target: '#home-view', title: 'Step 1', description: 'First step', prefer: 'bottom' },
  { target: '.sidebar', title: 'Step 2', description: 'Second step', prefer: 'right' },
  { target: '.address-bar', title: 'Step 3', description: 'Third step', prefer: 'left' },
];

function createTestController(
  settingsOverrides: Partial<Settings> = {},
  steps?: TourStep[]
): {
  ctrl: TourController;
  settings: Settings;
  saveSettings: ReturnType<typeof vi.fn>;
  onModalOpen: ReturnType<typeof vi.fn>;
  onModalClose: ReturnType<typeof vi.fn>;
} {
  const settings = makeSettings(settingsOverrides);
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const onModalOpen = vi.fn();
  const onModalClose = vi.fn();

  const ctrl = createTourController({
    getSettings: () => settings,
    saveSettings,
    steps,
    promptDelayMs: 0,
    onModalOpen,
    onModalClose,
  });

  return { ctrl, settings, saveSettings, onModalOpen, onModalClose };
}

describe('tour.extended', () => {
  beforeEach(() => {
    setupTourDOM();
    vi.useFakeTimers();

    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('positionTooltip — placement directions', () => {
    function setupPositionTest(prefer: 'top' | 'bottom' | 'left' | 'right'): {
      ctrl: TourController;
      tooltip: HTMLElement;
      highlight: HTMLElement;
    } {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Pos Test', description: 'Positioning', prefer },
      ];
      const { ctrl } = createTestController({}, steps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const target = document.getElementById('home-view')!;
      const highlight = document.getElementById('tour-highlight')!;

      mockBoundingClientRect(target, { left: 400, top: 300, width: 100, height: 100 });

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      return { ctrl, tooltip, highlight };
    }

    it('positions tooltip below target with prefer=bottom', () => {
      const { ctrl, tooltip } = setupPositionTest('bottom');
      ctrl.startTour();

      expect(tooltip.style.top).toBe('412px');
      expect(tooltip.style.left).toBe('350px');
    });

    it('positions tooltip above target with prefer=top', () => {
      const { ctrl, tooltip } = setupPositionTest('top');
      ctrl.startTour();

      expect(tooltip.style.top).toBe('208px');
      expect(tooltip.style.left).toBe('350px');
    });

    it('positions tooltip to the right of target with prefer=right', () => {
      const { ctrl, tooltip } = setupPositionTest('right');
      ctrl.startTour();

      expect(tooltip.style.left).toBe('512px');
      expect(tooltip.style.top).toBe('310px');
    });

    it('positions tooltip to the left of target with prefer=left', () => {
      const { ctrl, tooltip } = setupPositionTest('left');
      ctrl.startTour();

      expect(tooltip.style.left).toBe('188px');
      expect(tooltip.style.top).toBe('310px');
    });

    it('falls back to center when no placement fits', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Fallback', description: 'Center fallback', prefer: 'top' },
      ];
      const { ctrl } = createTestController({}, steps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const target = document.getElementById('home-view')!;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 980, height: 740 });
      mockBoundingClientRect(target, { left: 20, top: 20, width: 100, height: 100 });

      ctrl.startTour();

      const tooltipLeft = parseFloat(tooltip.style.left);
      const tooltipTop = parseFloat(tooltip.style.top);

      expect(tooltipLeft).toBeGreaterThanOrEqual(0);
      expect(tooltipTop).toBeGreaterThanOrEqual(0);
      expect(tooltipLeft + 980).toBeLessThanOrEqual(1024);
    });

    it('positions tooltip at viewport padding when target rect is null', () => {
      const steps: TourStep[] = [
        { target: '#nonexistent', title: 'Missing', description: 'No target', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);
      const tooltip = document.getElementById('tour-tooltip')!;

      ctrl.startTour();

      expect(tooltip.style.left).toBe('16px');
      expect(tooltip.style.top).toBe('16px');
    });

    it('clamps tooltip position to stay within viewport', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Clamp', description: 'Clamped', prefer: 'left' },
      ];
      const { ctrl } = createTestController({}, steps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const target = document.getElementById('home-view')!;

      mockBoundingClientRect(target, { left: 50, top: 300, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const tooltipLeft = parseFloat(tooltip.style.left);

      expect(tooltipLeft).toBeGreaterThanOrEqual(16);
    });
  });

  describe('applyHighlight — highlight dimensions', () => {
    it('sets highlight dimensions matching target rect with padding', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'HL', description: 'Highlight test', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const highlight = document.getElementById('tour-highlight')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 100, top: 200, width: 150, height: 80 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(highlight.style.display).toBe('block');
      expect(highlight.style.left).toBe('92px');
      expect(highlight.style.top).toBe('192px');
      expect(highlight.style.width).toBe('166px');
      expect(highlight.style.height).toBe('96px');
    });

    it('clamps highlight left/top to 0 when target is near viewport edge', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Edge', description: 'Edge test', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const highlight = document.getElementById('tour-highlight')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 3, top: 2, width: 100, height: 80 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(highlight.style.left).toBe('0px');
      expect(highlight.style.top).toBe('0px');
    });

    it('hides highlight when target element is missing', () => {
      const steps: TourStep[] = [
        { target: '#nonexistent', title: 'Gone', description: 'No element', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const highlight = document.getElementById('tour-highlight')!;

      ctrl.startTour();

      expect(highlight.style.display).toBe('none');
    });
  });

  describe('command palette step', () => {
    const paletteSteps: TourStep[] = [
      { target: '#home-view', title: 'Before', description: 'Start', prefer: 'bottom' },
      {
        target: '.command-palette-modal',
        title: 'Palette',
        description: 'Open palette',
        prefer: 'bottom',
      },
      { target: '.sidebar', title: 'After', description: 'Next', prefer: 'right' },
    ];

    it('dispatches Ctrl+K keydown when stepping to command palette step', () => {
      const { ctrl } = createTestController({}, paletteSteps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const target = document.querySelector('.command-palette-modal') as HTMLElement;
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(target, { left: 200, top: 200, width: 400, height: 300 });

      const homeView = document.getElementById('home-view')!;
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });

      const keydownSpy = vi.fn();
      document.addEventListener('keydown', keydownSpy);

      ctrl.startTour();

      const nextBtn = document.getElementById('tour-next')!;
      nextBtn.click();

      const ctrlKEvents = keydownSpy.mock.calls.filter(
        (call) => call[0].key === 'k' && call[0].ctrlKey
      );
      expect(ctrlKEvents.length).toBeGreaterThanOrEqual(1);

      document.removeEventListener('keydown', keydownSpy);
    });

    it('closes command palette modal when navigating away from palette step', () => {
      const { ctrl } = createTestController({}, paletteSteps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const paletteTarget = document.querySelector('.command-palette-modal') as HTMLElement;
      const homeView = document.getElementById('home-view')!;
      const sidebar = document.querySelector('.sidebar') as HTMLElement;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(paletteTarget, { left: 200, top: 200, width: 400, height: 300 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(sidebar, { left: 0, top: 0, width: 50, height: 200 });

      ctrl.startTour();
      const nextBtn = document.getElementById('tour-next')!;

      nextBtn.click();

      const paletteModal = document.getElementById('command-palette-modal')!;
      paletteModal.style.display = 'flex';

      nextBtn.click();

      expect(paletteModal.style.display).toBe('none');
    });

    it('closes palette on endTour if it is open', () => {
      const { ctrl } = createTestController({}, paletteSteps);
      const paletteModal = document.getElementById('command-palette-modal')!;

      ctrl.startTour();
      paletteModal.style.display = 'flex';
      ctrl.endTour(false);

      expect(paletteModal.style.display).toBe('none');
    });

    it('skips palette dispatch if palette modal is already open', () => {
      const { ctrl } = createTestController({}, paletteSteps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const paletteTarget = document.querySelector('.command-palette-modal') as HTMLElement;
      const homeView = document.getElementById('home-view')!;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(paletteTarget, { left: 200, top: 200, width: 400, height: 300 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });

      const paletteModal = document.getElementById('command-palette-modal')!;
      paletteModal.style.display = 'flex';

      const keydownSpy = vi.fn();
      document.addEventListener('keydown', keydownSpy);

      ctrl.startTour();
      const nextBtn = document.getElementById('tour-next')!;
      nextBtn.click();

      const ctrlKEvents = keydownSpy.mock.calls.filter(
        (call) => call[0].key === 'k' && call[0].ctrlKey
      );
      expect(ctrlKEvents.length).toBe(0);

      document.removeEventListener('keydown', keydownSpy);
    });
  });

  describe('keyboard suppression during command palette step', () => {
    const paletteSteps: TourStep[] = [
      { target: '#home-view', title: 'Before', description: 'Start', prefer: 'bottom' },
      {
        target: '.command-palette-modal',
        title: 'Palette',
        description: 'Open palette',
        prefer: 'bottom',
      },
    ];

    it('blocks Ctrl+K during palette step after initial dispatch', () => {
      const { ctrl } = createTestController({}, paletteSteps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const paletteTarget = document.querySelector('.command-palette-modal') as HTMLElement;
      const homeView = document.getElementById('home-view')!;
      const paletteModal = document.getElementById('command-palette-modal')!;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(paletteTarget, { left: 200, top: 200, width: 400, height: 300 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });

      ctrl.startTour();

      paletteModal.style.display = 'flex';

      const nextBtn = document.getElementById('tour-next')!;
      nextBtn.click();

      const event = new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      document.dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
    });

    it('blocks Ctrl+K with metaKey during palette step', () => {
      const { ctrl } = createTestController({}, paletteSteps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const paletteTarget = document.querySelector('.command-palette-modal') as HTMLElement;
      const homeView = document.getElementById('home-view')!;
      const paletteModal = document.getElementById('command-palette-modal')!;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(paletteTarget, { left: 200, top: 200, width: 400, height: 300 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });

      ctrl.startTour();

      paletteModal.style.display = 'flex';
      document.getElementById('tour-next')!.click();

      const event = new KeyboardEvent('keydown', {
        key: 'K',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      document.dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
    });

    it('blocks arbitrary keys during palette step', () => {
      const { ctrl } = createTestController({}, paletteSteps);

      const tooltip = document.getElementById('tour-tooltip')!;
      const paletteTarget = document.querySelector('.command-palette-modal') as HTMLElement;
      const homeView = document.getElementById('home-view')!;
      const paletteModal = document.getElementById('command-palette-modal')!;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(paletteTarget, { left: 200, top: 200, width: 400, height: 300 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });

      ctrl.startTour();

      paletteModal.style.display = 'flex';
      document.getElementById('tour-next')!.click();

      const event = new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      document.dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
    });
  });

  describe('window resize and scroll listeners', () => {
    it('calls scheduleTourUpdate on window resize', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

      ctrl.startTour();
      rafSpy.mockClear();

      window.dispatchEvent(new Event('resize'));

      expect(rafSpy).toHaveBeenCalled();
    });

    it('calls scheduleTourUpdate on scroll', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

      ctrl.startTour();
      rafSpy.mockClear();

      window.dispatchEvent(new Event('scroll'));

      expect(rafSpy).toHaveBeenCalled();
    });

    it('does not request duplicate rAF when scheduleTourUpdate is called twice', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      let rafCallCount = 0;
      const originalRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = vi.fn((...args: Parameters<typeof originalRaf>) => {
        rafCallCount++;
        return originalRaf(...args);
      }) as unknown as typeof window.requestAnimationFrame;

      ctrl.startTour();
      rafCallCount = 0;

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));

      expect(rafCallCount).toBe(1);

      window.requestAnimationFrame = originalRaf;
    });

    it('removes listeners on endTour', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

      ctrl.startTour();
      ctrl.endTour();
      rafSpy.mockClear();

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));

      expect(rafSpy).not.toHaveBeenCalled();
    });
  });

  describe('getTargetRect', () => {
    it('returns null for missing elements (highlight hidden)', () => {
      const steps: TourStep[] = [
        {
          target: '#does-not-exist',
          title: 'Missing',
          description: 'No element',
          prefer: 'bottom',
        },
      ];
      const { ctrl } = createTestController({}, steps);

      const highlight = document.getElementById('tour-highlight')!;

      ctrl.startTour();

      expect(highlight.style.display).toBe('none');
    });

    it('returns null for zero-size elements (highlight hidden)', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Zero', description: 'Zero size', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const highlight = document.getElementById('tour-highlight')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 100, top: 100, width: 0, height: 0 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(highlight.style.display).toBe('none');
    });

    it('returns rect for existing elements with non-zero size (highlight shown)', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Exists', description: 'Has size', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const highlight = document.getElementById('tour-highlight')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 100, top: 200, width: 150, height: 80 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(highlight.style.display).toBe('block');
    });

    it('returns null when element has zero width but non-zero height', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'ZeroW', description: 'Zero width', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const highlight = document.getElementById('tour-highlight')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 100, top: 100, width: 0, height: 50 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(highlight.style.display).toBe('none');
    });
  });

  describe('default steps', () => {
    it('uses default steps when no custom steps array is provided', () => {
      const { ctrl } = createTestController();

      const settings = makeSettings();
      const saveSettings = vi.fn().mockResolvedValue(undefined);

      const tooltip = document.getElementById('tour-tooltip')!;
      const homeView = document.getElementById('home-view')!;
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });

      const defaultCtrl = createTourController({
        getSettings: () => settings,
        saveSettings,
      });

      defaultCtrl.startTour();

      const titleEl = document.getElementById('tour-title')!;
      const stepCountEl = document.getElementById('tour-step-count')!;

      expect(titleEl.textContent).toBe('Welcome to Home');

      expect(stepCountEl.textContent).toBe('Step 1 of 7');
    });

    it('navigates through multiple default steps', () => {
      const settings = makeSettings();
      const saveSettings = vi.fn().mockResolvedValue(undefined);

      const tooltip = document.getElementById('tour-tooltip')!;
      const homeView = document.getElementById('home-view')!;
      const sidebar = document.querySelector('.sidebar') as HTMLElement;

      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });
      mockBoundingClientRect(homeView, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(sidebar, { left: 0, top: 0, width: 50, height: 200 });

      const defaultCtrl = createTourController({
        getSettings: () => settings,
        saveSettings,
      });

      defaultCtrl.startTour();

      const nextBtn = document.getElementById('tour-next')!;
      const titleEl = document.getElementById('tour-title')!;

      nextBtn.click();
      expect(titleEl.textContent).toBe('Sidebar Navigation');

      nextBtn.click();
      expect(titleEl.textContent).toBe('Smart Address Bar');
    });
  });

  describe('clamp edge cases', () => {
    it('clamps tooltip to left viewport edge when position would be negative', () => {
      Object.defineProperty(window, 'innerWidth', {
        value: 300,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: 768,
        writable: true,
        configurable: true,
      });

      const steps: TourStep[] = [
        { target: '#home-view', title: 'Clamp L', description: 'Left', prefer: 'left' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 10, top: 400, width: 50, height: 50 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 260, height: 80 });

      ctrl.startTour();

      const tooltipLeft = parseFloat(tooltip.style.left);

      expect(tooltipLeft).toBeGreaterThanOrEqual(16);

      expect(tooltipLeft + 260).toBeLessThanOrEqual(300);
    });

    it('clamps tooltip to top viewport edge when position would be negative', () => {
      Object.defineProperty(window, 'innerWidth', {
        value: 1024,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: 200,
        writable: true,
        configurable: true,
      });

      const steps: TourStep[] = [
        { target: '#home-view', title: 'Clamp T', description: 'Top', prefer: 'top' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 400, top: 10, width: 100, height: 50 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 160 });

      ctrl.startTour();

      const tooltipTop = parseFloat(tooltip.style.top);

      expect(tooltipTop).toBeGreaterThanOrEqual(16);

      expect(tooltipTop + 160).toBeLessThanOrEqual(200);
    });

    it('clamps tooltip to right viewport edge when position exceeds width', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Clamp R', description: 'Right', prefer: 'right' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 900, top: 400, width: 100, height: 50 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const tooltipLeft = parseFloat(tooltip.style.left);

      expect(tooltipLeft).toBeLessThanOrEqual(808);
    });

    it('clamps tooltip to bottom viewport edge when position exceeds height', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Clamp B', description: 'Bottom', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 400, top: 700, width: 100, height: 50 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const tooltipTop = parseFloat(tooltip.style.top);

      expect(tooltipTop).toBeLessThanOrEqual(672);
    });

    it('value exactly at min boundary stays at min', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'Exact', description: 'Exact boundary', prefer: 'bottom' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 66, top: 300, width: 100, height: 50 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const tooltipLeft = parseFloat(tooltip.style.left);
      expect(tooltipLeft).toBeGreaterThanOrEqual(16);
    });
  });

  describe('startTour with empty steps', () => {
    it('does not start tour when steps array is empty', () => {
      const { ctrl } = createTestController({}, []);

      ctrl.startTour();

      expect(ctrl.isActive()).toBe(false);
    });
  });

  describe('ArrowLeft at first step', () => {
    it('does nothing on ArrowLeft at step 0', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const titleEl = document.getElementById('tour-title')!;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

      expect(titleEl.textContent).toBe('Step 1');
    });
  });

  describe('back button disabled state', () => {
    it('back button is disabled at first step', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const backBtn = document.getElementById('tour-back') as HTMLButtonElement;
      expect(backBtn.disabled).toBe(true);
      expect(backBtn.style.opacity).toBe('0.5');
    });

    it('back button is enabled at second step', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const sidebar = document.querySelector('.sidebar') as HTMLElement;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(sidebar, { left: 0, top: 0, width: 50, height: 200 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();
      document.getElementById('tour-next')!.click();

      const backBtn = document.getElementById('tour-back') as HTMLButtonElement;
      expect(backBtn.disabled).toBe(false);
      expect(backBtn.style.opacity).toBe('1');
    });
  });

  describe('next button text', () => {
    it('shows "Finish" on last step', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const sidebar = document.querySelector('.sidebar') as HTMLElement;
      const addressBar = document.querySelector('.address-bar') as HTMLElement;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(sidebar, { left: 0, top: 0, width: 50, height: 200 });
      mockBoundingClientRect(addressBar, { left: 100, top: 0, width: 300, height: 40 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const nextBtn = document.getElementById('tour-next')!;
      nextBtn.click();
      nextBtn.click();

      expect(nextBtn.textContent).toBe('Finish');
    });

    it('shows "Next" on non-last step', () => {
      const { ctrl } = createTestController({}, testSteps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      const nextBtn = document.getElementById('tour-next')!;
      expect(nextBtn.textContent).toBe('Next');
    });
  });

  describe('saveSettings error handling', () => {
    it('does not throw when saveSettings rejects', async () => {
      const settings = makeSettings();
      const saveSettings = vi.fn().mockRejectedValue(new Error('save failed'));

      const ctrl = createTourController({
        getSettings: () => settings,
        saveSettings,
        steps: testSteps,
        promptDelayMs: 0,
      });

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(() => ctrl.endTour(true)).not.toThrow();
      await vi.runAllTimersAsync();
    });
  });

  describe('handleLaunch clears previous timeout', () => {
    it('clears prior launch timeout on second call', () => {
      const { ctrl } = createTestController();

      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.handleLaunch(1);

      ctrl.handleLaunch(2);
      vi.runAllTimers();
    });

    it('clears launch timeout when startTour is called', () => {
      const settings = makeSettings();
      const saveSettings = vi.fn().mockResolvedValue(undefined);

      const ctrl = createTourController({
        getSettings: () => settings,
        saveSettings,
        steps: testSteps,
        promptDelayMs: 5000,
      });

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.handleLaunch(1);

      ctrl.startTour();

      const promptModal = document.getElementById('tour-prompt-modal')!;
      vi.runAllTimers();

      expect(promptModal.style.display).toBe('none');
    });
  });

  describe('scheduleTourUpdate when not active', () => {
    it('does not schedule rAF when tour is not active', () => {
      const { ctrl } = createTestController({}, testSteps);

      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

      window.dispatchEvent(new Event('resize'));

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;
      mockBoundingClientRect(target, { left: 100, top: 100, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();
      ctrl.endTour();
      rafSpy.mockClear();

      window.dispatchEvent(new Event('resize'));
      expect(rafSpy).not.toHaveBeenCalled();
    });
  });

  describe('getPlacementOrder', () => {
    it('uses default placement order when no prefer is set', () => {
      const steps: TourStep[] = [
        { target: '#home-view', title: 'No Pref', description: 'No preference' },
      ];
      const { ctrl } = createTestController({}, steps);

      const target = document.getElementById('home-view')!;
      const tooltip = document.getElementById('tour-tooltip')!;

      mockBoundingClientRect(target, { left: 400, top: 300, width: 100, height: 100 });
      mockBoundingClientRect(tooltip, { left: 0, top: 0, width: 200, height: 80 });

      ctrl.startTour();

      expect(tooltip.style.top).toBe('412px');
      expect(tooltip.style.left).toBe('350px');
    });
  });
});
