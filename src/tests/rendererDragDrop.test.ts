import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDragDropController } from './rendererDragDrop';

function createDragEvent(
  type: string,
  options: {
    textData?: string;
    files?: Array<{ path: string }>;
    ctrlKey?: boolean;
    altKey?: boolean;
    clientX?: number;
    clientY?: number;
  } = {}
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dataTransfer = {
    files: options.files ?? [],
    dropEffect: 'move',
    getData: vi.fn((key: string) => (key === 'text/plain' ? options.textData || '' : '')),
  };

  Object.assign(event, {
    dataTransfer,
    ctrlKey: !!options.ctrlKey,
    altKey: !!options.altKey,
    clientX: options.clientX ?? 20,
    clientY: options.clientY ?? 20,
  });

  return event;
}

function createConfig() {
  const fileGrid = document.getElementById('file-grid') as HTMLElement;
  const fileView = document.getElementById('file-view') as HTMLElement;
  const dropIndicator = document.getElementById('drop-indicator') as HTMLElement;
  const dropIndicatorAction = document.getElementById('drop-indicator-action') as HTMLElement;
  const dropIndicatorPath = document.getElementById('drop-indicator-path') as HTMLElement;
  const showToast = vi.fn();
  const config = {
    getCurrentPath: () => '/dest',
    getCurrentSettings: () =>
      ({
        fileConflictBehavior: 'ask',
      }) as never,
    getShowToast: () => showToast,
    getFileGrid: () => fileGrid,
    getFileView: () => fileView,
    getDropIndicator: () => dropIndicator,
    getDropIndicatorAction: () => dropIndicatorAction,
    getDropIndicatorPath: () => dropIndicatorPath,
    consumeEvent: vi.fn((e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    }),
    clearSelection: vi.fn(),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    updateUndoRedoState: vi.fn().mockResolvedValue(undefined),
  };

  return { config, showToast };
}

describe('createDragDropController', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="file-view"></div>
      <div id="file-grid"></div>
      <div id="drop-indicator" style="display:none">
        <span id="drop-indicator-action"></span>
        <span id="drop-indicator-path"></span>
      </div>
    `;

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getDragData: vi.fn().mockResolvedValue({ paths: ['/fallback.txt'] }),
        copyItems: vi.fn().mockResolvedValue({ success: true }),
        moveItems: vi.fn().mockResolvedValue({ success: true }),
        clearDragData: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
      writable: true,
    });
  });

  it('detects copy vs move drag operation', () => {
    const { config } = createConfig();
    const controller = createDragDropController(config);

    expect(controller.getDragOperation({ ctrlKey: true } as DragEvent)).toBe('copy');
    expect(controller.getDragOperation({ altKey: true } as DragEvent)).toBe('copy');
    expect(controller.getDragOperation({ ctrlKey: false, altKey: false } as DragEvent)).toBe(
      'move'
    );
  });

  it('resolves dragged paths from text payload or fallback API', async () => {
    const { config } = createConfig();
    const controller = createDragDropController(config);

    const fromText = await controller.getDraggedPaths(
      createDragEvent('drop', { textData: JSON.stringify(['/text/path.txt']) })
    );
    expect(fromText).toEqual(['/text/path.txt']);

    const fromFallback = await controller.getDraggedPaths(createDragEvent('drop'));
    expect(fromFallback).toEqual(['/fallback.txt']);
  });

  it('handles move drop success path and refreshes state', async () => {
    const { config, showToast } = createConfig();
    const controller = createDragDropController(config);
    const electronAPI = (
      window as unknown as { electronAPI: Record<string, ReturnType<typeof vi.fn>> }
    ).electronAPI;

    await controller.handleDrop(['/source.txt'], '/dest', 'move');

    expect(electronAPI.moveItems).toHaveBeenCalledWith(['/source.txt'], '/dest', 'ask');
    expect(electronAPI.clearDragData).toHaveBeenCalledTimes(1);
    expect(config.updateUndoRedoState).toHaveBeenCalledTimes(1);
    expect(config.navigateTo).toHaveBeenCalledWith('/dest');
    expect(config.clearSelection).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Moved 1 item(s)', 'Success', 'success');
  });

  it('shows and hides drop indicator', () => {
    const { config } = createConfig();
    const controller = createDragDropController(config);
    const indicator = document.getElementById('drop-indicator') as HTMLElement;

    controller.showDropIndicator('copy', '/dest', 30, 40);
    expect(indicator.style.display).toBe('inline-flex');
    expect((document.getElementById('drop-indicator-action') as HTMLElement).textContent).toBe(
      'Copy'
    );
    expect((document.getElementById('drop-indicator-path') as HTMLElement).textContent).toBe(
      'dest'
    );

    controller.hideDropIndicator();
    expect(indicator.style.display).toBe('none');
  });

  it('prevents dropping items into the current directory via file-grid drop listener', async () => {
    const { config, showToast } = createConfig();
    const controller = createDragDropController(config);
    controller.initDragAndDropListeners();

    const fileGrid = document.getElementById('file-grid') as HTMLElement;
    const dropEvent = createDragEvent('drop', {
      textData: JSON.stringify(['/dest/already-here.txt']),
    });

    fileGrid.dispatchEvent(dropEvent);
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith('Items are already in this directory', 'Info', 'info');
    const electronAPI = (
      window as unknown as { electronAPI: Record<string, ReturnType<typeof vi.fn>> }
    ).electronAPI;
    expect(electronAPI.copyItems).not.toHaveBeenCalled();
    expect(electronAPI.moveItems).not.toHaveBeenCalled();
  });
});
