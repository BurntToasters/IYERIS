import { describe, it, expect, vi } from 'vitest';
import { createSupportUiController } from '../rendererSupportUi';

function makeDeps() {
  return {
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    escapeHtml: vi.fn((s: string) => s),
    getErrorMessage: vi.fn((e: unknown) => String(e)),
    getCurrentSettings: vi.fn(() => ({}) as any),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    openExternal: vi.fn(),
  };
}

describe('rendererSupportUi', () => {
  it('creates controller from deps', () => {
    const deps = makeDeps();
    const ctrl = createSupportUiController(deps);
    expect(ctrl).toBeDefined();
  });
});
