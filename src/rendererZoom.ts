import { ZOOM_POPUP_HIDE_MS } from './rendererLocalConstants.js';

type ZoomConfig = {
  setZoomLevel: (level: number) => Promise<{ success: boolean }>;
};

export function createZoomController(config: ZoomConfig) {
  let currentZoomLevel = 1.0;
  let zoomPopupTimeout: ReturnType<typeof setTimeout> | null = null;
  async function updateZoomLevel(newZoom: number) {
    currentZoomLevel = Math.max(0.5, Math.min(2.0, newZoom));
    const result = await config.setZoomLevel(currentZoomLevel);

    if (result.success) {
      updateZoomDisplay();
      showZoomPopup();
    }
  }

  function updateZoomDisplay() {
    const zoomDisplay = document.getElementById('zoom-level-display');
    if (zoomDisplay) {
      zoomDisplay.textContent = `${Math.round(currentZoomLevel * 100)}%`;
    }
  }

  function showZoomPopup() {
    const zoomPopup = document.getElementById('zoom-popup') as HTMLElement;
    if (!zoomPopup) return;

    zoomPopup.style.display = 'flex';

    if (zoomPopupTimeout) {
      clearTimeout(zoomPopupTimeout);
    }

    zoomPopupTimeout = setTimeout(() => {
      zoomPopup.style.display = 'none';
    }, ZOOM_POPUP_HIDE_MS);
  }

  async function zoomIn() {
    await updateZoomLevel(currentZoomLevel + 0.1);
  }

  async function zoomOut() {
    await updateZoomLevel(currentZoomLevel - 0.1);
  }

  async function zoomReset() {
    await updateZoomLevel(1.0);
  }

  function setCurrentZoomLevel(level: number) {
    currentZoomLevel = level;
  }

  function getCurrentZoomLevel(): number {
    return currentZoomLevel;
  }

  function clearZoomPopupTimeout() {
    if (zoomPopupTimeout) {
      clearTimeout(zoomPopupTimeout);
      zoomPopupTimeout = null;
    }
  }

  return {
    zoomIn,
    zoomOut,
    zoomReset,
    updateZoomDisplay,
    setCurrentZoomLevel,
    getCurrentZoomLevel,
    clearZoomPopupTimeout,
  };
}
