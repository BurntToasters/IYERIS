// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared.js', () => ({
  escapeHtml: vi.fn((s: string) => s),
}));

import { createToastManager } from '../rendererToasts';

function makeOptions() {
  const container = {
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    contains: vi.fn(() => true),
  };
  return {
    durationMs: 3000,
    maxVisible: 3,
    getContainer: vi.fn(() => container) as any,
    twemojiImg: vi.fn((emoji: string) => `<img alt="${emoji}" />`),
    _container: container,
  };
}

describe('createToastManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a manager with showToast method', () => {
    const opts = makeOptions();
    const manager = createToastManager(opts);
    expect(manager.showToast).toBeTypeOf('function');
  });

  it('shows toast immediately when under max visible', () => {
    const opts = makeOptions();
    const manager = createToastManager(opts);

    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        className: '',
        style: {},
        setAttribute: vi.fn(),
        innerHTML: '',
        addEventListener: vi.fn(),
        querySelector: vi.fn(() => null),
        classList: { add: vi.fn() },
      })),
    });

    manager.showToast('Hello', 'Title', 'success');
    expect(opts._container.appendChild).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('queues toasts when at max visible', () => {
    const opts = makeOptions();
    const manager = createToastManager(opts);

    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        className: '',
        style: {},
        setAttribute: vi.fn(),
        innerHTML: '',
        addEventListener: vi.fn(),
        querySelector: vi.fn(() => null),
        classList: { add: vi.fn() },
      })),
    });

    manager.showToast('Toast 1', '', 'info');
    manager.showToast('Toast 2', '', 'info');
    manager.showToast('Toast 3', '', 'info');
    expect(opts._container.appendChild).toHaveBeenCalledTimes(3);

    manager.showToast('Toast 4', '', 'info');
    expect(opts._container.appendChild).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  it('uses correct role for error/warning types', () => {
    const opts = makeOptions();
    const manager = createToastManager(opts);

    const mockElement = {
      className: '',
      style: {},
      setAttribute: vi.fn(),
      innerHTML: '',
      addEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      classList: { add: vi.fn() },
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => mockElement),
    });

    manager.showToast('Error!', '', 'error');
    expect(mockElement.setAttribute).toHaveBeenCalledWith('role', 'alert');

    vi.unstubAllGlobals();
  });

  it('auto-removes toast after duration', () => {
    const opts = makeOptions();
    const manager = createToastManager(opts);

    const mockElement = {
      className: '',
      style: {},
      setAttribute: vi.fn(),
      innerHTML: '',
      addEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      classList: { add: vi.fn() },
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => mockElement),
    });

    manager.showToast('Test', '', 'info');

    vi.advanceTimersByTime(opts.durationMs + 400);

    expect(mockElement.classList.add).toHaveBeenCalledWith('removing');
    expect(opts._container.removeChild).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('handles null container gracefully', () => {
    const opts = makeOptions();
    opts.getContainer = vi.fn(() => null) as any;
    const manager = createToastManager(opts);

    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        className: '',
        style: {},
        setAttribute: vi.fn(),
        innerHTML: '',
        addEventListener: vi.fn(),
        querySelector: vi.fn(() => null),
        classList: { add: vi.fn() },
      })),
    });

    expect(() => manager.showToast('Test', '', 'info')).not.toThrow();

    vi.unstubAllGlobals();
  });

  it('defaults to info type and empty title', () => {
    const opts = makeOptions();
    const manager = createToastManager(opts);

    const mockElement = {
      className: '',
      style: {},
      setAttribute: vi.fn(),
      innerHTML: '',
      addEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
      classList: { add: vi.fn() },
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => mockElement),
    });

    manager.showToast('Just a message');
    expect(mockElement.setAttribute).toHaveBeenCalledWith('role', 'status');

    vi.unstubAllGlobals();
  });

  it('renders action buttons and executes action callbacks', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const action = vi.fn();

    const manager = createToastManager({
      durationMs: 200,
      maxVisible: 2,
      getContainer: () => container,
      twemojiImg: () => '<img />',
    });

    manager.showToast('Retry this', 'Upload', 'warning', [{ label: 'Retry', onClick: action }]);

    const actionBtn = container.querySelector('.toast-action-btn') as HTMLButtonElement;
    expect(actionBtn).toBeTruthy();
    expect(actionBtn.textContent).toBe('Retry');

    actionBtn.click();
    expect(action).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(container.children.length).toBe(0);
  });

  it('dismiss button removes toast and dequeues the next one', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const manager = createToastManager({
      durationMs: 500,
      maxVisible: 1,
      getContainer: () => container,
      twemojiImg: () => '<img />',
    });

    manager.showToast('First', 'A', 'info');
    manager.showToast('Second', 'B', 'info');

    const firstDismiss = container.querySelector('.toast-dismiss') as HTMLButtonElement;
    expect(firstDismiss).toBeTruthy();
    firstDismiss.click();

    vi.advanceTimersByTime(1000);

    expect(container.children.length).toBe(1);
    expect(container.textContent).toContain('Second');
  });

  it('clicking toast and dismiss does not remove twice', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const removeChildSpy = vi.spyOn(container, 'removeChild');

    const manager = createToastManager({
      durationMs: 500,
      maxVisible: 1,
      getContainer: () => container,
      twemojiImg: () => '<img />',
    });

    manager.showToast('Only once', '', 'info');

    const toast = container.querySelector('.toast') as HTMLElement;
    const dismiss = container.querySelector('.toast-dismiss') as HTMLButtonElement;
    toast.click();
    dismiss.click();

    vi.advanceTimersByTime(1000);

    expect(removeChildSpy).toHaveBeenCalledTimes(1);
  });
});
