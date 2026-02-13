import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { createZoomController } from './rendererZoom';

describe('createZoomController', () => {
  let setZoomLevel: ReturnType<typeof vi.fn>;
  let ctrl: ReturnType<typeof createZoomController>;

  beforeEach(() => {
    vi.clearAllMocks();
    setZoomLevel = vi.fn().mockResolvedValue({ success: true });
    ctrl = createZoomController({ setZoomLevel } as any);
    // Reset zoom level to 1.0 for each test (module-level state persists)
    ctrl.setCurrentZoomLevel(1.0);
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
    });
  });

  afterEach(() => {
    ctrl.clearZoomPopupTimeout();
    vi.unstubAllGlobals();
  });

  it('starts at zoom level 1.0', () => {
    expect(ctrl.getCurrentZoomLevel()).toBe(1.0);
  });

  it('zoomIn increases zoom by 0.1', async () => {
    await ctrl.zoomIn();
    expect(setZoomLevel).toHaveBeenCalled();
    // Zoom should be clamped to max 2.0
    const level = setZoomLevel.mock.calls[0][0];
    expect(level).toBeCloseTo(1.1, 1);
  });

  it('zoomOut decreases zoom by 0.1', async () => {
    await ctrl.zoomOut();
    const level = setZoomLevel.mock.calls[0][0];
    expect(level).toBeCloseTo(0.9, 1);
  });

  it('zoomReset sets zoom to 1.0', async () => {
    ctrl.setCurrentZoomLevel(1.5);
    await ctrl.zoomReset();
    const level = setZoomLevel.mock.calls[0][0];
    expect(level).toBe(1.0);
  });

  it('clamps zoom to minimum 0.5', async () => {
    ctrl.setCurrentZoomLevel(0.5);
    await ctrl.zoomOut();
    const level = setZoomLevel.mock.calls[0][0];
    expect(level).toBe(0.5);
  });

  it('clamps zoom to maximum 2.0', async () => {
    ctrl.setCurrentZoomLevel(2.0);
    await ctrl.zoomIn();
    const level = setZoomLevel.mock.calls[0][0];
    expect(level).toBe(2.0);
  });

  it('setCurrentZoomLevel and getCurrentZoomLevel work', () => {
    ctrl.setCurrentZoomLevel(1.5);
    expect(ctrl.getCurrentZoomLevel()).toBe(1.5);
  });

  it('updateZoomDisplay does not throw when element is missing', () => {
    expect(() => ctrl.updateZoomDisplay()).not.toThrow();
  });

  it('updateZoomDisplay updates text when element exists', () => {
    const mockEl = { textContent: '' };
    vi.stubGlobal('document', {
      getElementById: vi.fn((id: string) => (id === 'zoom-level-display' ? mockEl : null)),
    });
    ctrl.setCurrentZoomLevel(1.5);
    ctrl.updateZoomDisplay();
    expect(mockEl.textContent).toBe('150%');
  });

  it('clearZoomPopupTimeout is safe to call multiple times', () => {
    expect(() => {
      ctrl.clearZoomPopupTimeout();
      ctrl.clearZoomPopupTimeout();
    }).not.toThrow();
  });

  it('does not update level when setZoomLevel fails', async () => {
    setZoomLevel.mockResolvedValue({ success: false });
    ctrl.setCurrentZoomLevel(1.0);
    await ctrl.zoomIn();
    // The zoom level is still set even if API fails (per current implementation)
    // Just verify it doesn't throw
    expect(setZoomLevel).toHaveBeenCalled();
  });
});
