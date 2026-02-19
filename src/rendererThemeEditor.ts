import type { Settings, CustomTheme } from './types';
import type { DialogType } from './rendererModals.js';

type ThemeEditorDeps = {
  getCurrentSettings: () => Settings;
  setCurrentSettingsTheme: (theme: Settings['theme'], customTheme: CustomTheme) => void;
  applySettings: (settings: Settings) => void;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  showToast: (message: string, title: string, type: 'success' | 'error' | 'info') => void;
  showConfirm: (message: string, title: string, type?: DialogType) => Promise<boolean>;
  activateModal: (el: HTMLElement) => void;
  deactivateModal: (el: HTMLElement) => void;
};

function parseHexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

export function hexToRgb(hex: string): string {
  const c = parseHexRgb(hex);
  return c ? `${c[0]}, ${c[1]}, ${c[2]}` : '0, 120, 212';
}

function hexToRgba(hex: string, alpha: number): string {
  const c = parseHexRgb(hex);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
}

function setThemeCustomProperties(el: HTMLElement, theme: CustomTheme) {
  el.style.setProperty('--custom-accent-color', theme.accentColor);
  el.style.setProperty('--custom-accent-rgb', hexToRgb(theme.accentColor));
  el.style.setProperty('--custom-bg-primary', theme.bgPrimary);
  el.style.setProperty('--custom-bg-primary-rgb', hexToRgb(theme.bgPrimary));
  el.style.setProperty('--custom-bg-secondary', theme.bgSecondary);
  el.style.setProperty('--custom-text-primary', theme.textPrimary);
  el.style.setProperty('--custom-text-secondary', theme.textSecondary);
  el.style.setProperty('--custom-glass-bg', hexToRgba(theme.glassBg, 0.03));
  el.style.setProperty('--custom-glass-border', hexToRgba(theme.glassBorder, 0.08));
}

const CUSTOM_THEME_PROPERTIES = [
  '--custom-accent-color',
  '--custom-accent-rgb',
  '--custom-bg-primary',
  '--custom-bg-primary-rgb',
  '--custom-bg-secondary',
  '--custom-text-primary',
  '--custom-text-secondary',
  '--custom-glass-bg',
  '--custom-glass-border',
];

const themePresets: Record<string, CustomTheme> = {
  midnight: {
    name: 'Midnight Blue',
    accentColor: '#4a9eff',
    bgPrimary: '#0d1b2a',
    bgSecondary: '#1b263b',
    textPrimary: '#e0e1dd',
    textSecondary: '#a0a4a8',
    glassBg: '#ffffff',
    glassBorder: '#4a9eff',
  },
  forest: {
    name: 'Forest Green',
    accentColor: '#2ecc71',
    bgPrimary: '#1a2f1a',
    bgSecondary: '#243524',
    textPrimary: '#e8f5e9',
    textSecondary: '#a5d6a7',
    glassBg: '#ffffff',
    glassBorder: '#2ecc71',
  },
  sunset: {
    name: 'Sunset Orange',
    accentColor: '#ff7043',
    bgPrimary: '#1f1410',
    bgSecondary: '#2d1f1a',
    textPrimary: '#fff3e0',
    textSecondary: '#ffab91',
    glassBg: '#ffffff',
    glassBorder: '#ff7043',
  },
  lavender: {
    name: 'Lavender Purple',
    accentColor: '#9c7cf4',
    bgPrimary: '#1a1625',
    bgSecondary: '#251f33',
    textPrimary: '#ede7f6',
    textSecondary: '#b39ddb',
    glassBg: '#ffffff',
    glassBorder: '#9c7cf4',
  },
  rose: {
    name: 'Rose Pink',
    accentColor: '#f48fb1',
    bgPrimary: '#1f1418',
    bgSecondary: '#2d1f24',
    textPrimary: '#fce4ec',
    textSecondary: '#f8bbd9',
    glassBg: '#ffffff',
    glassBorder: '#f48fb1',
  },
  ocean: {
    name: 'Ocean Teal',
    accentColor: '#26c6da',
    bgPrimary: '#0d1f22',
    bgSecondary: '#1a2f33',
    textPrimary: '#e0f7fa',
    textSecondary: '#80deea',
    glassBg: '#ffffff',
    glassBorder: '#26c6da',
  },
};

const THEME_COLOR_FIELDS: ReadonlyArray<readonly [string, keyof CustomTheme]> = [
  ['theme-accent-color', 'accentColor'],
  ['theme-bg-primary', 'bgPrimary'],
  ['theme-bg-secondary', 'bgSecondary'],
  ['theme-text-primary', 'textPrimary'],
  ['theme-text-secondary', 'textSecondary'],
  ['theme-glass-bg', 'glassBg'],
  ['theme-glass-border', 'glassBorder'],
];
const THEME_COLOR_KEY_BY_INPUT_ID = new Map<string, keyof CustomTheme>(THEME_COLOR_FIELDS);

export function createThemeEditorController(deps: ThemeEditorDeps) {
  let tempCustomTheme: CustomTheme = {
    name: 'My Custom Theme',
    accentColor: '#0078d4',
    bgPrimary: '#1a1a1a',
    bgSecondary: '#252525',
    textPrimary: '#ffffff',
    textSecondary: '#b0b0b0',
    glassBg: '#ffffff',
    glassBorder: '#ffffff',
  };

  let themeEditorHasUnsavedChanges = false;
  let savedThemeSnapshot: CustomTheme | null = null;
  let savedThemeWasCustom = false;

  function applyCustomThemeColors(theme: CustomTheme) {
    setThemeCustomProperties(document.documentElement, theme);
    document.body.style.backgroundColor = theme.bgPrimary;
  }

  function clearCustomThemeColors() {
    const root = document.documentElement;
    CUSTOM_THEME_PROPERTIES.forEach((prop) => root.style.removeProperty(prop));
    document.body.style.backgroundColor = '';
  }

  function updateThemePreview() {
    const preview = document.getElementById('theme-preview');
    if (!preview) return;
    setThemeCustomProperties(preview, tempCustomTheme);
    preview.style.backgroundColor = tempCustomTheme.bgPrimary;
  }

  function normalizeHexColorValue(value: string): string {
    const trimmed = value.trim();
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  }

  function parseHexColorValue(value: string): string | null {
    const normalized = normalizeHexColorValue(value);
    if (/^#[0-9A-Fa-f]{6}$/.test(normalized)) return normalized;
    if (/^#[0-9A-Fa-f]{3}$/.test(normalized)) {
      return (
        '#' +
        normalized[1] +
        normalized[1] +
        normalized[2] +
        normalized[2] +
        normalized[3] +
        normalized[3]
      );
    }
    return null;
  }

  function syncColorInputs(colorId: string, value: string) {
    const colorInput = document.getElementById(colorId) as HTMLInputElement | null;
    const textInput = document.getElementById(`${colorId}-text`) as HTMLInputElement | null;

    if (colorInput) colorInput.value = value;
    if (textInput) textInput.value = value.toUpperCase();

    const key = THEME_COLOR_KEY_BY_INPUT_ID.get(colorId);
    if (key) {
      tempCustomTheme[key] = value;
      themeEditorHasUnsavedChanges = true;
    }

    updateThemePreview();
    applyCustomThemeColors(tempCustomTheme);
  }

  function applyThemePreset(presetName: string) {
    const preset = themePresets[presetName];
    if (!preset) return;

    tempCustomTheme = { ...preset };

    const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
    if (nameInput) nameInput.value = preset.name;

    THEME_COLOR_FIELDS.forEach(([inputId, key]) => {
      syncColorInputs(inputId, preset[key]);
    });
  }

  function showThemeEditor() {
    const modal = document.getElementById('theme-editor-modal');
    if (!modal) return;

    themeEditorHasUnsavedChanges = false;

    const settings = deps.getCurrentSettings();
    savedThemeWasCustom = settings.theme === 'custom';
    savedThemeSnapshot = settings.customTheme ? { ...settings.customTheme } : null;

    if (settings.customTheme) {
      tempCustomTheme = { ...settings.customTheme };
    }

    for (const [inputId, key] of THEME_COLOR_FIELDS) {
      const colorInput = document.getElementById(inputId) as HTMLInputElement | null;
      const textInput = document.getElementById(`${inputId}-text`) as HTMLInputElement | null;
      const value = tempCustomTheme[key];
      if (colorInput) colorInput.value = value;
      if (textInput) textInput.value = value;
    }

    const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
    if (nameInput) nameInput.value = tempCustomTheme.name;

    updateThemePreview();
    modal.style.display = 'flex';
    deps.activateModal(modal);
  }

  async function hideThemeEditor(skipConfirmation = false) {
    if (!skipConfirmation && themeEditorHasUnsavedChanges) {
      const confirmed = await deps.showConfirm(
        'You have unsaved changes. Are you sure you want to close the theme editor?',
        'Unsaved Changes',
        'warning'
      );
      if (!confirmed) return;
    }
    const modal = document.getElementById('theme-editor-modal');
    if (modal) {
      modal.style.display = 'none';
      deps.deactivateModal(modal);
    }

    if (themeEditorHasUnsavedChanges) {
      if (savedThemeWasCustom && savedThemeSnapshot) {
        applyCustomThemeColors(savedThemeSnapshot);
      } else {
        clearCustomThemeColors();
        deps.applySettings(deps.getCurrentSettings());
      }
    }

    themeEditorHasUnsavedChanges = false;
    savedThemeSnapshot = null;
  }

  async function saveCustomTheme() {
    const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
    if (nameInput && nameInput.value.trim()) {
      tempCustomTheme.name = nameInput.value.trim();
    }

    const settings = deps.getCurrentSettings();
    deps.setCurrentSettingsTheme('custom', { ...tempCustomTheme });

    deps.applySettings(settings);

    const result = await deps.saveSettingsWithTimestamp(settings);
    if (result.success) {
      themeEditorHasUnsavedChanges = false;
      hideThemeEditor(true);
      updateCustomThemeUI();
      deps.showToast('Custom theme saved!', 'Theme', 'success');
    } else {
      deps.showToast('Failed to save theme: ' + result.error, 'Error', 'error');
    }
  }

  function updateCustomThemeUI(options?: { syncSelect?: boolean; selectedTheme?: string }) {
    const customThemeDescription = document.getElementById('custom-theme-description');
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
    const settings = deps.getCurrentSettings();
    const selectedTheme = options?.selectedTheme ?? settings.theme ?? 'default';

    if (settings.customTheme) {
      if (customThemeDescription) {
        const themeName = settings.customTheme.name || 'Custom Theme';
        if (selectedTheme === 'custom') {
          customThemeDescription.textContent = `Currently using: ${themeName}`;
        } else {
          customThemeDescription.textContent = `Custom theme ready: ${themeName}`;
        }
      }
    } else {
      if (customThemeDescription) {
        customThemeDescription.textContent = 'Create your own color scheme';
      }
    }

    if (themeSelect && options?.syncSelect !== false) {
      themeSelect.value = settings.theme || 'default';
    }
  }

  function setupThemeEditorListeners() {
    ['theme-editor-close', 'theme-editor-cancel'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => hideThemeEditor());
    });
    document.getElementById('theme-editor-save')?.addEventListener('click', saveCustomTheme);

    THEME_COLOR_FIELDS.forEach(([id]) => {
      const colorInput = document.getElementById(id) as HTMLInputElement | null;
      const textInput = document.getElementById(`${id}-text`) as HTMLInputElement | null;

      colorInput?.addEventListener('input', (e) => {
        const value = (e.target as HTMLInputElement).value;
        syncColorInputs(id, value);
      });

      textInput?.addEventListener('input', (e) => {
        const rawValue = (e.target as HTMLInputElement).value;
        const parsed = parseHexColorValue(rawValue);
        if (parsed) {
          syncColorInputs(id, parsed);
          textInput.classList.remove('invalid');
        } else if (normalizeHexColorValue(rawValue).length > 1) {
          textInput.classList.add('invalid');
        }
      });

      textInput?.addEventListener('blur', (e) => {
        if (parseHexColorValue((e.target as HTMLInputElement).value)) {
          textInput.classList.remove('invalid');
          return;
        }
        if (colorInput) {
          textInput.value = colorInput.value.toUpperCase();
        }
        textInput.classList.remove('invalid');
      });
    });

    document.getElementById('theme-name-input')?.addEventListener('input', (e) => {
      tempCustomTheme.name = (e.target as HTMLInputElement).value || 'My Custom Theme';
      themeEditorHasUnsavedChanges = true;
    });

    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = (btn as HTMLElement).dataset.preset;
        if (preset) applyThemePreset(preset);
      });
    });

    document.getElementById('open-theme-editor-btn')?.addEventListener('click', showThemeEditor);

    document.getElementById('theme-editor-modal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
        hideThemeEditor();
      }
    });
  }

  return {
    applyCustomThemeColors,
    clearCustomThemeColors,
    showThemeEditor,
    hideThemeEditor,
    setupThemeEditorListeners,
    updateCustomThemeUI,
  };
}
