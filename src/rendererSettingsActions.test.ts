import { describe, it, expect, vi } from 'vitest';

vi.mock('./shared.js', () => ({
  isRecord: vi.fn((v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)),
}));

import { createSettingsActionsController } from './rendererSettingsActions';

function makeDeps() {
  return {
    getCurrentSettings: vi.fn(() => ({}) as any),
    setCurrentSettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    loadBookmarks: vi.fn(),
    updateThumbnailCacheSize: vi.fn(),
    clearThumbnailCacheLocal: vi.fn(),
    hideSettingsModal: vi.fn(),
    showSettingsModal: vi.fn(),
    isOneOf: vi.fn((value: string, options: readonly string[]) => options.includes(value)),
    themeValues: ['light', 'dark', 'system', 'custom'] as const,
    sortByValues: ['name', 'size', 'modified', 'type'] as const,
    sortOrderValues: ['asc', 'desc'] as const,
    viewModeValues: ['grid', 'list', 'column'] as const,
  };
}

describe('validateImportedSettings', () => {
  it('creates controller with initSettingsActions method', () => {
    const deps = makeDeps();
    const ctrl = createSettingsActionsController(deps as any);
    expect(ctrl.initSettingsActions).toBeTypeOf('function');
  });
});
