/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemeEditorController, hexToRgb } from './rendererThemeEditor';

function createDeps() {
  const settings = {
    theme: 'default' as string,
    customTheme: null as null | Record<string, string>,
  };
  return {
    settings,
    getCurrentSettings: vi.fn(() => settings as never),
    setCurrentSettingsTheme: vi.fn((theme: string, customTheme: Record<string, string>) => {
      settings.theme = theme;
      settings.customTheme = customTheme;
    }),
    applySettings: vi.fn(),
    saveSettingsWithTimestamp: vi.fn().mockResolvedValue({ success: true }),
    showToast: vi.fn(),
    showConfirm: vi.fn().mockResolvedValue(true),
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
  };
}

const COLOR_FIELDS = [
  'theme-accent-color',
  'theme-bg-primary',
  'theme-bg-secondary',
  'theme-text-primary',
  'theme-text-secondary',
  'theme-glass-bg',
  'theme-glass-border',
];

function setupThemeEditorDOM() {
  let html = `
    <div id="theme-editor-modal" style="display:none" class="modal-overlay"></div>
    <div id="theme-preview"></div>
    <input id="theme-name-input" />
    <div id="custom-theme-description"></div>
    <select id="theme-select">
      <option value="default">Default</option>
      <option value="custom">Custom</option>
    </select>
    <button id="open-theme-editor-btn"></button>
    <button id="theme-editor-close"></button>
    <button id="theme-editor-cancel"></button>
    <button id="theme-editor-save"></button>
    <button class="preset-btn" data-preset="midnight">Midnight</button>
    <button class="preset-btn" data-preset="forest">Forest</button>
  `;

  for (const id of COLOR_FIELDS) {
    html += `<input id="${id}" type="color" value="#000000" />`;
    html += `<input id="${id}-text" type="text" value="#000000" />`;
  }

  document.body.innerHTML = html;
}

describe('createThemeEditorController', () => {
  beforeEach(() => {
    setupThemeEditorDOM();
  });

  describe('applyCustomThemeColors', () => {
    it('sets CSS custom properties on documentElement', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.applyCustomThemeColors({
        name: 'Test',
        accentColor: '#ff0000',
        bgPrimary: '#111111',
        bgSecondary: '#222222',
        textPrimary: '#ffffff',
        textSecondary: '#cccccc',
        glassBg: '#ffffff',
        glassBorder: '#ff0000',
      } as never);

      const root = document.documentElement;
      expect(root.style.getPropertyValue('--custom-accent-color')).toBe('#ff0000');
      expect(root.style.getPropertyValue('--custom-bg-primary')).toBe('#111111');
      expect(document.body.style.backgroundColor).toBeTruthy();
    });
  });

  describe('clearCustomThemeColors', () => {
    it('removes all custom properties', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      // Apply then clear
      ctrl.applyCustomThemeColors({
        name: 'Test',
        accentColor: '#ff0000',
        bgPrimary: '#111111',
        bgSecondary: '#222222',
        textPrimary: '#ffffff',
        textSecondary: '#cccccc',
        glassBg: '#ffffff',
        glassBorder: '#ff0000',
      } as never);
      ctrl.clearCustomThemeColors();

      const root = document.documentElement;
      expect(root.style.getPropertyValue('--custom-accent-color')).toBe('');
      expect(document.body.style.backgroundColor).toBe('');
    });
  });

  describe('showThemeEditor', () => {
    it('opens modal and populates inputs from settings', () => {
      const deps = createDeps();
      deps.settings.customTheme = {
        name: 'My Theme',
        accentColor: '#aabbcc',
        bgPrimary: '#111111',
        bgSecondary: '#222222',
        textPrimary: '#ffffff',
        textSecondary: '#cccccc',
        glassBg: '#ffffff',
        glassBorder: '#aabbcc',
      };
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();

      const modal = document.getElementById('theme-editor-modal')!;
      expect(modal.style.display).toBe('flex');
      expect(deps.activateModal).toHaveBeenCalledWith(modal);

      const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('My Theme');
    });

    it('uses default theme when no custom theme in settings', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();

      const modal = document.getElementById('theme-editor-modal')!;
      expect(modal.style.display).toBe('flex');
    });

    it('does nothing when modal element is missing', () => {
      document.getElementById('theme-editor-modal')!.remove();
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      expect(deps.activateModal).not.toHaveBeenCalled();
    });
  });

  describe('hideThemeEditor', () => {
    it('hides modal with skipConfirmation', async () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      await ctrl.hideThemeEditor(true);
      const modal = document.getElementById('theme-editor-modal')!;
      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalled();
    });

    it('prompts when unsaved changes and user cancels', async () => {
      const deps = createDeps();
      deps.showConfirm = vi.fn().mockResolvedValue(false);
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();

      // Make a change to trigger unsaved state
      ctrl.setupThemeEditorListeners();
      const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
      nameInput.value = 'Changed';
      nameInput.dispatchEvent(new Event('input'));

      await ctrl.hideThemeEditor();
      // Modal should still be visible since user cancelled
      const modal = document.getElementById('theme-editor-modal')!;
      expect(modal.style.display).toBe('flex');
    });

    it('closes when user confirms unsaved changes', async () => {
      const deps = createDeps();
      deps.showConfirm = vi.fn().mockResolvedValue(true);
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();

      ctrl.setupThemeEditorListeners();
      const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
      nameInput.value = 'Changed';
      nameInput.dispatchEvent(new Event('input'));

      await ctrl.hideThemeEditor();
      const modal = document.getElementById('theme-editor-modal')!;
      expect(modal.style.display).toBe('none');
    });
  });

  describe('updateCustomThemeUI', () => {
    it('shows "currently using" text when theme is custom', () => {
      const deps = createDeps();
      deps.settings.theme = 'custom';
      deps.settings.customTheme = { name: 'My Cool Theme' } as never;
      const ctrl = createThemeEditorController(deps as any);
      ctrl.updateCustomThemeUI();
      const desc = document.getElementById('custom-theme-description')!;
      expect(desc.textContent).toContain('Currently using: My Cool Theme');
    });

    it('shows "ready" text when theme is not custom', () => {
      const deps = createDeps();
      deps.settings.theme = 'default';
      deps.settings.customTheme = { name: 'Ready Theme' } as never;
      const ctrl = createThemeEditorController(deps as any);
      ctrl.updateCustomThemeUI();
      const desc = document.getElementById('custom-theme-description')!;
      expect(desc.textContent).toContain('Custom theme ready: Ready Theme');
    });

    it('shows default text when no custom theme exists', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.updateCustomThemeUI();
      const desc = document.getElementById('custom-theme-description')!;
      expect(desc.textContent).toBe('Create your own color scheme');
    });

    it('syncs theme select value', () => {
      const deps = createDeps();
      deps.settings.theme = 'custom';
      deps.settings.customTheme = { name: 'Theme' } as never;
      const ctrl = createThemeEditorController(deps as any);
      ctrl.updateCustomThemeUI();
      const select = document.getElementById('theme-select') as HTMLSelectElement;
      expect(select.value).toBe('custom');
    });
  });

  describe('setupThemeEditorListeners', () => {
    it('preset buttons apply preset colors', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.setupThemeEditorListeners();

      const midnightBtn = document.querySelector(
        '.preset-btn[data-preset="midnight"]'
      ) as HTMLElement;
      midnightBtn.click();

      const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Midnight Blue');
    });

    it('color input change updates text input', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      ctrl.setupThemeEditorListeners();

      const colorInput = document.getElementById('theme-accent-color') as HTMLInputElement;
      colorInput.value = '#ff5500';
      colorInput.dispatchEvent(new Event('input'));

      const textInput = document.getElementById('theme-accent-color-text') as HTMLInputElement;
      expect(textInput.value).toBe('#FF5500');
    });

    it('text input with valid hex updates color input', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      ctrl.setupThemeEditorListeners();

      const textInput = document.getElementById('theme-accent-color-text') as HTMLInputElement;
      textInput.value = '#00ff00';
      textInput.dispatchEvent(new Event('input'));

      const colorInput = document.getElementById('theme-accent-color') as HTMLInputElement;
      expect(colorInput.value).toBe('#00ff00');
      expect(textInput.classList.contains('invalid')).toBe(false);
    });

    it('text input with invalid hex adds invalid class', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      ctrl.setupThemeEditorListeners();

      const textInput = document.getElementById('theme-accent-color-text') as HTMLInputElement;
      textInput.value = '#gg';
      textInput.dispatchEvent(new Event('input'));
      expect(textInput.classList.contains('invalid')).toBe(true);
    });

    it('text input blur resets to color value on invalid', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      ctrl.setupThemeEditorListeners();

      const colorInput = document.getElementById('theme-accent-color') as HTMLInputElement;
      colorInput.value = '#aabbcc';
      const textInput = document.getElementById('theme-accent-color-text') as HTMLInputElement;
      textInput.value = 'invalid';
      textInput.dispatchEvent(new Event('blur'));
      expect(textInput.value).toBe('#AABBCC');
      expect(textInput.classList.contains('invalid')).toBe(false);
    });

    it('save button saves theme successfully', async () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      ctrl.setupThemeEditorListeners();

      const saveBtn = document.getElementById('theme-editor-save')!;
      saveBtn.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith('Custom theme saved!', 'Theme', 'success');
      });
    });

    it('save button shows error on failure', async () => {
      const deps = createDeps();
      deps.saveSettingsWithTimestamp = vi.fn().mockResolvedValue({
        success: false,
        error: 'write error',
      });
      const ctrl = createThemeEditorController(deps as any);
      ctrl.showThemeEditor();
      ctrl.setupThemeEditorListeners();

      const saveBtn = document.getElementById('theme-editor-save')!;
      saveBtn.click();
      await vi.waitFor(() => {
        expect(deps.showToast).toHaveBeenCalledWith(
          'Failed to save theme: write error',
          'Error',
          'error'
        );
      });
    });

    it('open-theme-editor-btn opens the editor', () => {
      const deps = createDeps();
      const ctrl = createThemeEditorController(deps as any);
      ctrl.setupThemeEditorListeners();
      const btn = document.getElementById('open-theme-editor-btn')!;
      btn.click();
      const modal = document.getElementById('theme-editor-modal')!;
      expect(modal.style.display).toBe('flex');
    });
  });
});

describe('hexToRgb standalone', () => {
  it('converts valid hex to rgb string', () => {
    expect(hexToRgb('#ff0000')).toBe('255, 0, 0');
  });

  it('returns fallback for invalid hex', () => {
    expect(hexToRgb('invalid')).toBe('0, 120, 212');
  });
});
