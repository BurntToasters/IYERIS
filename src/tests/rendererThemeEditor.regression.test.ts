// @vitest-environment jsdom
/**
 * Regression tests for the theme editor.
 * N6c: saveCustomTheme must revert the in-memory theme and call applySettings
 *      a second time (to un-apply) when the save to disk fails.  Previously
 *      the theme was left applied in the UI even though nothing was persisted.
 *      Also: the error toast must never show "undefined" — result.error is
 *      typed as string | undefined and was not guarded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createThemeEditorController } from '../rendererThemeEditor';
import type { Settings, CustomTheme } from '../types';

function buildDom() {
  // eslint-disable-next-line no-restricted-syntax -- static test DOM fixture, no user input
  document.body.innerHTML = `
    <div id="theme-editor-modal" style="display:none">
      <button id="theme-editor-close"></button>
      <button id="theme-editor-cancel"></button>
      <button id="theme-editor-save"></button>
      <input id="theme-name-input" value="My Theme" />
      <input id="theme-editor-accent" type="color" value="#0078d4" />
      <input id="theme-editor-bg" type="color" value="#1e1e2e" />
      <input id="theme-editor-text" type="color" value="#cdd6f4" />
      <select id="theme-editor-preset"><option value="">Custom</option></select>
      <div id="custom-theme-description"></div>
      <div id="theme-editor-preview"></div>
      <select id="theme-select">
        <option value="default">Default</option>
        <option value="custom">Custom</option>
      </select>
    </div>
  `;
}

function makeSettings(theme: string = 'default', customTheme?: CustomTheme): Settings {
  return {
    theme,
    customTheme,
    showHiddenFiles: false,
  } as Settings;
}

function createDeps(saveResult: { success: boolean; error?: string }, initialTheme = 'default') {
  const currentSettings = makeSettings(initialTheme);

  return {
    getCurrentSettings: () => currentSettings,
    setCurrentSettingsTheme: vi.fn((theme: string, ct: CustomTheme) => {
      // Mutate in-place, matching the real wiring behaviour, so that the
      // 'settings' reference held by the source code stays valid.
      currentSettings.theme = theme as Settings['theme'];
      currentSettings.customTheme = ct;
    }),
    applySettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue(saveResult),
    showToast: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    // Expose a getter so tests can read the latest currentSettings.
    get settings() {
      return currentSettings;
    },
  };
}

describe('rendererThemeEditor — N6c rollback and error message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDom();
  });

  it('calls applySettings a second time (revert) when save fails', async () => {
    const deps = createDeps({ success: false, error: 'disk full' }, 'default');
    const ctrl = createThemeEditorController(deps as any);
    ctrl.setupThemeEditorListeners();

    document.getElementById('theme-editor-save')!.click();
    await new Promise((r) => setTimeout(r, 0));

    // First call: apply new theme. Second call: revert on failure.
    expect(deps.applySettings).toHaveBeenCalledTimes(2);
  });

  it('reverts theme to the previous value in memory after save failure', async () => {
    const deps = createDeps({ success: false, error: 'I/O error' }, 'default');
    const ctrl = createThemeEditorController(deps as any);
    ctrl.setupThemeEditorListeners();

    expect(deps.settings.theme).toBe('default');

    document.getElementById('theme-editor-save')!.click();
    await new Promise((r) => setTimeout(r, 0));

    // Theme must be reverted back to 'default'.
    expect(deps.settings.theme).toBe('default');
  });

  it('shows error toast with the actual error string (never "undefined")', async () => {
    // result.error is undefined when the IPC returns { success: false } with no
    // message.  The fix substitutes 'Unknown error'.
    const deps = createDeps({ success: false }); // no error property
    const ctrl = createThemeEditorController(deps as any);
    ctrl.setupThemeEditorListeners();

    document.getElementById('theme-editor-save')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const toastCalls = (deps.showToast as ReturnType<typeof vi.fn>).mock.calls;
    const errorToast = toastCalls.find(([, , type]) => type === 'error');
    expect(errorToast).toBeTruthy();
    const message = errorToast![0] as string;
    expect(message).not.toContain('undefined');
    expect(message.length).toBeGreaterThan(0);
  });

  it('shows the specific error string when result.error is present', async () => {
    const deps = createDeps({ success: false, error: 'quota exceeded' });
    const ctrl = createThemeEditorController(deps as any);
    ctrl.setupThemeEditorListeners();

    document.getElementById('theme-editor-save')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const toastCalls = (deps.showToast as ReturnType<typeof vi.fn>).mock.calls;
    const errorToast = toastCalls.find(([, , type]) => type === 'error');
    expect(errorToast![0]).toContain('quota exceeded');
  });

  it('does NOT call applySettings a second time on successful save', async () => {
    const deps = createDeps({ success: true }, 'default');
    const ctrl = createThemeEditorController(deps as any);
    ctrl.setupThemeEditorListeners();

    document.getElementById('theme-editor-save')!.click();
    await new Promise((r) => setTimeout(r, 0));

    // Only one applySettings call (apply new theme; no revert).
    expect(deps.applySettings).toHaveBeenCalledTimes(1);
  });
});
