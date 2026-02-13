import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./shared.js', () => ({
  escapeHtml: vi.fn((s: string) => s),
}));

import { createToastManager } from './rendererToasts';

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
        classList: { add: vi.fn() },
      })),
    });

    // Show max toasts
    manager.showToast('Toast 1', '', 'info');
    manager.showToast('Toast 2', '', 'info');
    manager.showToast('Toast 3', '', 'info');
    expect(opts._container.appendChild).toHaveBeenCalledTimes(3);

    // 4th should be queued
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
      classList: { add: vi.fn() },
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => mockElement),
    });

    manager.showToast('Test', '', 'info');

    // Fast-forward past duration + removal animation
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
        classList: { add: vi.fn() },
      })),
    });

    // Should not throw
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
      classList: { add: vi.fn() },
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => mockElement),
    });

    manager.showToast('Just a message');
    expect(mockElement.setAttribute).toHaveBeenCalledWith('role', 'status');

    vi.unstubAllGlobals();
  });
});
