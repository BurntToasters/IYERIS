/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    <div id="command-palette-modal" style="display:none"></div>
  `;
}

const testSteps: TourStep[] = [
  { target: '#home-view', title: 'Step 1', description: 'First step', prefer: 'bottom' },
  { target: '.sidebar', title: 'Step 2', description: 'Second step', prefer: 'right' },
  { target: '.address-bar', title: 'Step 3', description: 'Third step', prefer: 'bottom' },
];

function createTestController(settingsOverrides: Partial<Settings> = {}): {
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
    steps: testSteps,
    promptDelayMs: 0,
    onModalOpen,
    onModalClose,
  });

  return { ctrl, settings, saveSettings, onModalOpen, onModalClose };
}

describe('createTourController', () => {
  beforeEach(() => {
    setupTourDOM();
    vi.useFakeTimers();
  });

  describe('noopController', () => {
    it('returns noop controller when DOM elements are missing', () => {
      document.body.innerHTML = '';

      const settings = makeSettings();
      const ctrl = createTourController({
        getSettings: () => settings,
        saveSettings: vi.fn().mockResolvedValue(undefined),
      });

      expect(ctrl.isActive()).toBe(false);
      expect(() => ctrl.startTour()).not.toThrow();
      expect(() => ctrl.endTour()).not.toThrow();
      expect(() => ctrl.showPrompt()).not.toThrow();
      expect(() => ctrl.hidePrompt()).not.toThrow();
      expect(() => ctrl.handleLaunch(1)).not.toThrow();
    });
  });

  describe('handleLaunch', () => {
    it('shows prompt on first launch after delay', () => {
      const { ctrl } = createTestController();
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.handleLaunch(1);
      vi.runAllTimers();

      expect(promptModal.style.display).toBe('flex');
    });

    it('does not show prompt on subsequent launches', () => {
      const { ctrl } = createTestController();
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.handleLaunch(2);
      vi.runAllTimers();

      expect(promptModal.style.display).toBe('none');
    });

    it('does not show prompt if already dismissed', () => {
      const { ctrl } = createTestController({ tourPromptDismissed: true });
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.handleLaunch(1);
      vi.runAllTimers();

      expect(promptModal.style.display).toBe('none');
    });

    it('does not show prompt if tour already completed', () => {
      const { ctrl } = createTestController({ tourCompleted: true });
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.handleLaunch(1);
      vi.runAllTimers();

      expect(promptModal.style.display).toBe('none');
    });
  });

  describe('showPrompt / hidePrompt', () => {
    it('shows prompt modal', () => {
      const { ctrl, onModalOpen } = createTestController();
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.showPrompt();

      expect(promptModal.style.display).toBe('flex');
      expect(onModalOpen).toHaveBeenCalledWith(promptModal);
    });

    it('does not show prompt if tour is active', () => {
      const { ctrl } = createTestController();
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.startTour();
      ctrl.showPrompt();

      expect(promptModal.style.display).toBe('none');
    });

    it('hides prompt modal', () => {
      const { ctrl, onModalClose } = createTestController();
      const promptModal = document.getElementById('tour-prompt-modal')!;

      ctrl.showPrompt();
      ctrl.hidePrompt();

      expect(promptModal.style.display).toBe('none');
      expect(onModalClose).toHaveBeenCalledWith(promptModal);
    });
  });

  describe('startTour', () => {
    it('activates the tour', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();

      expect(ctrl.isActive()).toBe(true);
    });

    it('shows overlay', () => {
      const { ctrl } = createTestController();
      const overlay = document.getElementById('tour-overlay')!;

      ctrl.startTour();

      expect(overlay.style.display).toBe('block');
    });

    it('adds tour-active class to body', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();

      expect(document.body.classList.contains('tour-active')).toBe(true);
    });

    it('sets step count text', () => {
      const { ctrl } = createTestController();
      const stepCount = document.getElementById('tour-step-count')!;

      ctrl.startTour();

      expect(stepCount.textContent).toBe(`Step 1 of ${testSteps.length}`);
    });

    it('sets first step title and description', () => {
      const { ctrl } = createTestController();
      const title = document.getElementById('tour-title')!;
      const desc = document.getElementById('tour-description')!;

      ctrl.startTour();

      expect(title.textContent).toBe('Step 1');
      expect(desc.textContent).toBe('First step');
    });

    it('does not start if already active', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();
      const overlay = document.getElementById('tour-overlay')!;
      overlay.style.display = 'none';

      ctrl.startTour();
      expect(overlay.style.display).toBe('none');
    });
  });

  describe('endTour', () => {
    it('deactivates the tour', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();
      ctrl.endTour();

      expect(ctrl.isActive()).toBe(false);
    });

    it('hides overlay', () => {
      const { ctrl } = createTestController();
      const overlay = document.getElementById('tour-overlay')!;

      ctrl.startTour();
      ctrl.endTour();

      expect(overlay.style.display).toBe('none');
    });

    it('removes tour-active class from body', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();
      ctrl.endTour();

      expect(document.body.classList.contains('tour-active')).toBe(false);
    });

    it('saves completed state when completed=true', async () => {
      const { ctrl, settings, saveSettings } = createTestController();

      ctrl.startTour();
      ctrl.endTour(true);

      await vi.runAllTimersAsync();

      expect(settings.tourCompleted).toBe(true);
      expect(saveSettings).toHaveBeenCalled();
    });

    it('does nothing when not active', () => {
      const { ctrl, saveSettings } = createTestController();

      ctrl.endTour();

      expect(saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('keyboard navigation', () => {
    it('advances step on ArrowRight', () => {
      const { ctrl } = createTestController();
      const title = document.getElementById('tour-title')!;

      ctrl.startTour();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      expect(title.textContent).toBe('Step 2');
    });

    it('goes back on ArrowLeft', () => {
      const { ctrl } = createTestController();
      const title = document.getElementById('tour-title')!;

      ctrl.startTour();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

      expect(title.textContent).toBe('Step 1');
    });

    it('ends tour on Escape', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(ctrl.isActive()).toBe(false);
    });

    it('finishes tour on ArrowRight at last step', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      expect(ctrl.isActive()).toBe(false);
    });

    it('finishes tour on Enter at last step', () => {
      const { ctrl } = createTestController();

      ctrl.startTour();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(ctrl.isActive()).toBe(false);
    });
  });

  describe('button interactions', () => {
    it('skip button on prompt dismisses and hides', async () => {
      const { ctrl, settings, saveSettings } = createTestController();
      const skipBtn = document.getElementById('tour-prompt-skip')!;

      ctrl.showPrompt();
      skipBtn.click();
      await vi.runAllTimersAsync();

      expect(settings.tourPromptDismissed).toBe(true);
      expect(saveSettings).toHaveBeenCalled();
    });

    it('yes button on prompt starts tour', async () => {
      const { ctrl, settings, saveSettings } = createTestController();
      const yesBtn = document.getElementById('tour-prompt-yes')!;

      ctrl.showPrompt();
      yesBtn.click();
      await vi.runAllTimersAsync();

      expect(ctrl.isActive()).toBe(true);
      expect(settings.tourPromptDismissed).toBe(true);
    });

    it('next button advances step', () => {
      const { ctrl } = createTestController();
      const nextBtn = document.getElementById('tour-next')!;
      const title = document.getElementById('tour-title')!;

      ctrl.startTour();
      nextBtn.click();

      expect(title.textContent).toBe('Step 2');
    });

    it('back button goes to previous step', () => {
      const { ctrl } = createTestController();
      const nextBtn = document.getElementById('tour-next')!;
      const backBtn = document.getElementById('tour-back')!;
      const title = document.getElementById('tour-title')!;

      ctrl.startTour();
      nextBtn.click();
      backBtn.click();

      expect(title.textContent).toBe('Step 1');
    });

    it('skip button ends tour', () => {
      const { ctrl } = createTestController();
      const skipBtn = document.getElementById('tour-skip')!;

      ctrl.startTour();
      skipBtn.click();

      expect(ctrl.isActive()).toBe(false);
    });

    it('close button ends tour', () => {
      const { ctrl } = createTestController();
      const closeBtn = document.getElementById('tour-close')!;

      ctrl.startTour();
      closeBtn.click();

      expect(ctrl.isActive()).toBe(false);
    });

    it('next button finishes tour on last step', () => {
      const { ctrl } = createTestController();
      const nextBtn = document.getElementById('tour-next')!;

      ctrl.startTour();
      nextBtn.click();
      nextBtn.click();
      nextBtn.click();

      expect(ctrl.isActive()).toBe(false);
    });
  });

  describe('isActive', () => {
    it('returns false initially', () => {
      const { ctrl } = createTestController();
      expect(ctrl.isActive()).toBe(false);
    });

    it('returns true when tour is running', () => {
      const { ctrl } = createTestController();
      ctrl.startTour();
      expect(ctrl.isActive()).toBe(true);
    });

    it('returns false after tour ends', () => {
      const { ctrl } = createTestController();
      ctrl.startTour();
      ctrl.endTour();
      expect(ctrl.isActive()).toBe(false);
    });
  });
});
