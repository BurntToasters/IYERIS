// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createZoomController } from '../rendererZoom';

function createDeps() {
  return {
    setZoomLevel: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('rendererZoom – extended coverage', () => {
  let deps: ReturnType<typeof createDeps>;
  let ctrl: ReturnType<typeof createZoomController>;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createDeps();
    ctrl = createZoomController(deps as any);
    ctrl.setCurrentZoomLevel(1.0);
  });

  afterEach(() => {
    ctrl.clearZoomPopupTimeout();
    vi.useRealTimers();
  });

  describe('showZoomPopup via updateZoomLevel', () => {
    it('shows the zoom popup when element exists and setZoomLevel succeeds', async () => {
      const zoomPopup = document.createElement('div');
      zoomPopup.id = 'zoom-popup';
      zoomPopup.style.display = 'none';
      document.body.appendChild(zoomPopup);

      const zoomDisplay = document.createElement('span');
      zoomDisplay.id = 'zoom-level-display';
      document.body.appendChild(zoomDisplay);

      await ctrl.zoomIn();

      expect(zoomPopup.style.display).toBe('flex');

      zoomPopup.remove();
      zoomDisplay.remove();
    });

    it('hides the zoom popup after 2000ms timeout', async () => {
      const zoomPopup = document.createElement('div');
      zoomPopup.id = 'zoom-popup';
      zoomPopup.style.display = 'none';
      document.body.appendChild(zoomPopup);

      await ctrl.zoomIn();
      expect(zoomPopup.style.display).toBe('flex');

      vi.advanceTimersByTime(2000);
      expect(zoomPopup.style.display).toBe('none');

      zoomPopup.remove();
    });

    it('clears the previous popup timeout when zooming again before timeout fires', async () => {
      const zoomPopup = document.createElement('div');
      zoomPopup.id = 'zoom-popup';
      zoomPopup.style.display = 'none';
      document.body.appendChild(zoomPopup);

      await ctrl.zoomIn();
      expect(zoomPopup.style.display).toBe('flex');

      vi.advanceTimersByTime(1000);
      expect(zoomPopup.style.display).toBe('flex');

      await ctrl.zoomIn();
      expect(zoomPopup.style.display).toBe('flex');

      vi.advanceTimersByTime(1500);
      expect(zoomPopup.style.display).toBe('flex');

      vi.advanceTimersByTime(500);
      expect(zoomPopup.style.display).toBe('none');

      zoomPopup.remove();
    });

    it('does not show popup when zoom-popup element is missing', async () => {
      await ctrl.zoomIn();
      expect(deps.setZoomLevel).toHaveBeenCalled();
    });

    it('does not show popup when setZoomLevel returns success false', async () => {
      deps.setZoomLevel.mockResolvedValue({ success: false });

      const zoomPopup = document.createElement('div');
      zoomPopup.id = 'zoom-popup';
      zoomPopup.style.display = 'none';
      document.body.appendChild(zoomPopup);

      await ctrl.zoomIn();

      expect(zoomPopup.style.display).toBe('none');

      zoomPopup.remove();
    });
  });

  describe('clearZoomPopupTimeout', () => {
    it('clears an active popup timeout', async () => {
      const zoomPopup = document.createElement('div');
      zoomPopup.id = 'zoom-popup';
      zoomPopup.style.display = 'none';
      document.body.appendChild(zoomPopup);

      await ctrl.zoomIn();
      expect(zoomPopup.style.display).toBe('flex');

      ctrl.clearZoomPopupTimeout();

      vi.advanceTimersByTime(3000);
      expect(zoomPopup.style.display).toBe('flex');

      zoomPopup.remove();
    });

    it('is safe when no timeout is pending', () => {
      expect(() => ctrl.clearZoomPopupTimeout()).not.toThrow();
    });
  });

  describe('updateZoomDisplay', () => {
    it('rounds zoom percentage correctly for fractional levels', () => {
      const zoomDisplay = document.createElement('span');
      zoomDisplay.id = 'zoom-level-display';
      document.body.appendChild(zoomDisplay);

      ctrl.setCurrentZoomLevel(0.75);
      ctrl.updateZoomDisplay();
      expect(zoomDisplay.textContent).toBe('75%');

      ctrl.setCurrentZoomLevel(1.0);
      ctrl.updateZoomDisplay();
      expect(zoomDisplay.textContent).toBe('100%');

      zoomDisplay.remove();
    });
  });
});
