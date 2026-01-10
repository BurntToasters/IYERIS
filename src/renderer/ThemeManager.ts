import { CustomTheme, Settings } from '../types';
import { hexToRgb, showToast } from './utils.js';

export class ThemeManager {
  public tempCustomTheme: CustomTheme;
  private currentSettings: Settings;
  private applySettingsCallback: (settings: Settings) => void;

  private themePresets: Record<string, CustomTheme> = {
    midnight: {
      name: 'Midnight Blue',
      accentColor: '#4a9eff',
      bgPrimary: '#0d1b2a',
      bgSecondary: '#1b263b',
      textPrimary: '#e0e1dd',
      textSecondary: '#a0a4a8',
      glassBg: '#ffffff',
      glassBorder: '#4a9eff'
    },
    forest: {
      name: 'Forest Green',
      accentColor: '#2ecc71',
      bgPrimary: '#1a2f1a',
      bgSecondary: '#243524',
      textPrimary: '#e8f5e9',
      textSecondary: '#a5d6a7',
      glassBg: '#ffffff',
      glassBorder: '#2ecc71'
    },
    sunset: {
      name: 'Sunset Orange',
      accentColor: '#ff7043',
      bgPrimary: '#1f1410',
      bgSecondary: '#2d1f1a',
      textPrimary: '#fff3e0',
      textSecondary: '#ffab91',
      glassBg: '#ffffff',
      glassBorder: '#ff7043'
    },
    lavender: {
      name: 'Lavender Purple',
      accentColor: '#9c7cf4',
      bgPrimary: '#1a1625',
      bgSecondary: '#251f33',
      textPrimary: '#ede7f6',
      textSecondary: '#b39ddb',
      glassBg: '#ffffff',
      glassBorder: '#9c7cf4'
    },
    rose: {
      name: 'Rose Pink',
      accentColor: '#f48fb1',
      bgPrimary: '#1f1418',
      bgSecondary: '#2d1f24',
      textPrimary: '#fce4ec',
      textSecondary: '#f8bbd9',
      glassBg: '#ffffff',
      glassBorder: '#f48fb1'
    },
    ocean: {
      name: 'Ocean Teal',
      accentColor: '#26c6da',
      bgPrimary: '#0d1f22',
      bgSecondary: '#1a2f33',
      textPrimary: '#e0f7fa',
      textSecondary: '#80deea',
      glassBg: '#ffffff',
      glassBorder: '#26c6da'
    }
  };

  constructor(settings: Settings, applySettingsCallback: (settings: Settings) => void) {
    this.currentSettings = settings;
    this.applySettingsCallback = applySettingsCallback;
    this.tempCustomTheme = { ...this.defaultTheme() };
    
    // Initialize temp theme if exists
    if (this.currentSettings.customTheme) {
      this.tempCustomTheme = { ...this.currentSettings.customTheme };
    }
  }
  
  public updateSettings(settings: Settings) {
    this.currentSettings = settings;
    if (this.currentSettings.customTheme) {
      this.tempCustomTheme = { ...this.currentSettings.customTheme };
    }
  }

  private defaultTheme(): CustomTheme {
    return {
      name: 'My Custom Theme',
      accentColor: '#0078d4',
      bgPrimary: '#1a1a1a',
      bgSecondary: '#252525',
      textPrimary: '#ffffff',
      textSecondary: '#b0b0b0',
      glassBg: '#ffffff',
      glassBorder: '#ffffff'
    };
  }

  public applyCustomThemeColors(theme: CustomTheme | undefined) {
    if (!theme) return;
    const root = document.documentElement;
    root.style.setProperty('--custom-accent-color', theme.accentColor);
    root.style.setProperty('--custom-accent-rgb', hexToRgb(theme.accentColor));
    root.style.setProperty('--custom-bg-primary', theme.bgPrimary);
    root.style.setProperty('--custom-bg-primary-rgb', hexToRgb(theme.bgPrimary));
    root.style.setProperty('--custom-bg-secondary', theme.bgSecondary);
    root.style.setProperty('--custom-text-primary', theme.textPrimary);
    root.style.setProperty('--custom-text-secondary', theme.textSecondary);
    root.style.setProperty('--custom-glass-bg', `${theme.glassBg}08`);
    root.style.setProperty('--custom-glass-border', `${theme.glassBorder}14`);
    document.body.style.backgroundColor = theme.bgPrimary;
  }

  public clearCustomThemeColors() {
    const root = document.documentElement;
    const props = [
      '--custom-accent-color', '--custom-accent-rgb',
      '--custom-bg-primary', '--custom-bg-primary-rgb', '--custom-bg-secondary',
      '--custom-text-primary', '--custom-text-secondary',
      '--custom-glass-bg', '--custom-glass-border'
    ];
    props.forEach(prop => root.style.removeProperty(prop));
    document.body.style.backgroundColor = '';
  }

  public showThemeEditor() {
    const modal = document.getElementById('theme-editor-modal');
    if (!modal) return;

    if (this.currentSettings.customTheme) {
      this.tempCustomTheme = { ...this.currentSettings.customTheme };
    }

    const inputs: Record<string, { color: string; text: string }> = {
      'theme-accent-color': { color: this.tempCustomTheme.accentColor, text: this.tempCustomTheme.accentColor },
      'theme-bg-primary': { color: this.tempCustomTheme.bgPrimary, text: this.tempCustomTheme.bgPrimary },
      'theme-bg-secondary': { color: this.tempCustomTheme.bgSecondary, text: this.tempCustomTheme.bgSecondary },
      'theme-text-primary': { color: this.tempCustomTheme.textPrimary, text: this.tempCustomTheme.textPrimary },
      'theme-text-secondary': { color: this.tempCustomTheme.textSecondary, text: this.tempCustomTheme.textSecondary },
      'theme-glass-bg': { color: this.tempCustomTheme.glassBg, text: this.tempCustomTheme.glassBg }
    };
    
    for (const [id, values] of Object.entries(inputs)) {
      const colorInput = document.getElementById(id) as HTMLInputElement;
      const textInput = document.getElementById(`${id}-text`) as HTMLInputElement;
      if (colorInput) colorInput.value = values.color;
      if (textInput) textInput.value = values.text;
    }
    
    const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
    if (nameInput) nameInput.value = this.tempCustomTheme.name;
    
    this.updateThemePreview();
    modal.style.display = 'flex';
  }

  public hideThemeEditor() {
    const modal = document.getElementById('theme-editor-modal');
    if (modal) modal.style.display = 'none';
  }

  private updateThemePreview() {
    const preview = document.getElementById('theme-preview');
    if (!preview) return;
    
    preview.style.setProperty('--custom-accent-color', this.tempCustomTheme.accentColor);
    preview.style.setProperty('--custom-accent-rgb', hexToRgb(this.tempCustomTheme.accentColor));
    preview.style.setProperty('--custom-bg-primary', this.tempCustomTheme.bgPrimary);
    preview.style.setProperty('--custom-bg-secondary', this.tempCustomTheme.bgSecondary);
    preview.style.setProperty('--custom-text-primary', this.tempCustomTheme.textPrimary);
    preview.style.setProperty('--custom-text-secondary', this.tempCustomTheme.textSecondary);
    preview.style.setProperty('--custom-glass-bg', `${this.tempCustomTheme.glassBg}08`);
    preview.style.setProperty('--custom-glass-border', `${this.tempCustomTheme.glassBorder}20`);
    preview.style.backgroundColor = this.tempCustomTheme.bgPrimary;
  }

  private syncColorInputs(colorId: string, value: string) {
    const colorInput = document.getElementById(colorId) as HTMLInputElement;
    const textInput = document.getElementById(`${colorId}-text`) as HTMLInputElement;
    
    if (colorInput) colorInput.value = value;
    if (textInput) textInput.value = value.toUpperCase();

    const mapping: Record<string, keyof CustomTheme> = {
      'theme-accent-color': 'accentColor',
      'theme-bg-primary': 'bgPrimary',
      'theme-bg-secondary': 'bgSecondary',
      'theme-text-primary': 'textPrimary',
      'theme-text-secondary': 'textSecondary',
      'theme-glass-bg': 'glassBg'
    };
    
    const key = mapping[colorId];
    if (key) {
      (this.tempCustomTheme as any)[key] = value;
      if (key === 'glassBg') {
        this.tempCustomTheme.glassBorder = value;
      }
    }
    
    this.updateThemePreview();
  }

  public applyThemePreset(presetName: string) {
    const preset = this.themePresets[presetName];
    if (!preset) return;
    
    this.tempCustomTheme = { ...preset };

    const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
    if (nameInput) nameInput.value = preset.name;
    
    this.syncColorInputs('theme-accent-color', preset.accentColor);
    this.syncColorInputs('theme-bg-primary', preset.bgPrimary);
    this.syncColorInputs('theme-bg-secondary', preset.bgSecondary);
    this.syncColorInputs('theme-text-primary', preset.textPrimary);
    this.syncColorInputs('theme-text-secondary', preset.textSecondary);
    this.syncColorInputs('theme-glass-bg', preset.glassBg);
  }

  public async saveCustomTheme() {
    const nameInput = document.getElementById('theme-name-input') as HTMLInputElement;
    if (nameInput && nameInput.value.trim()) {
      this.tempCustomTheme.name = nameInput.value.trim();
    }

    this.currentSettings.customTheme = { ...this.tempCustomTheme };
    this.currentSettings.theme = 'custom';

    this.applySettingsCallback(this.currentSettings);

    const result = await window.electronAPI.saveSettings(this.currentSettings);
    if (result.success) {
      this.hideThemeEditor();
      this.updateCustomThemeUI();
      showToast('Custom theme saved!', 'Theme', 'success');
    } else {
      showToast('Failed to save theme: ' + result.error, 'Error', 'error');
    }
  }

  public setupThemeEditorListeners() {
    document.getElementById('theme-editor-close')?.addEventListener('click', () => this.hideThemeEditor());
    document.getElementById('theme-editor-cancel')?.addEventListener('click', () => this.hideThemeEditor());
    document.getElementById('theme-editor-save')?.addEventListener('click', () => this.saveCustomTheme());
    
    // Color inputs
    const colorIds = [
      'theme-accent-color',
      'theme-bg-primary',
      'theme-bg-secondary',
      'theme-text-primary',
      'theme-text-secondary',
      'theme-glass-bg'
    ];
    
    colorIds.forEach(id => {
      const colorInput = document.getElementById(id) as HTMLInputElement;
      const textInput = document.getElementById(`${id}-text`) as HTMLInputElement;
      
      colorInput?.addEventListener('input', (e) => {
        const value = (e.target as HTMLInputElement).value;
        this.syncColorInputs(id, value);
      });
      
      textInput?.addEventListener('input', (e) => {
        let value = (e.target as HTMLInputElement).value.trim();
        if (!value.startsWith('#')) value = '#' + value;
        if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
          this.syncColorInputs(id, value);
          textInput.classList.remove('invalid');
        } else if (/^#[0-9A-Fa-f]{3}$/.test(value)) {
          const expanded = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
          this.syncColorInputs(id, expanded);
          textInput.classList.remove('invalid');
        } else if (value.length > 1) {
          textInput.classList.add('invalid');
        }
      });
      
      textInput?.addEventListener('blur', (e) => {
        let value = (e.target as HTMLInputElement).value.trim();
        if (!value.startsWith('#')) value = '#' + value;
        // Validate and reset
        if (!/^#[0-9A-Fa-f]{3}$/.test(value) && !/^#[0-9A-Fa-f]{6}$/.test(value)) {
          // Reset to current color picker value
          const colorInput = document.getElementById(id) as HTMLInputElement;
          if (colorInput && textInput) {
            textInput.value = colorInput.value.toUpperCase();
            textInput.classList.remove('invalid');
          }
        } else {
          textInput.classList.remove('invalid');
        }
      });
    });

    document.getElementById('theme-name-input')?.addEventListener('input', (e) => {
      this.tempCustomTheme.name = (e.target as HTMLInputElement).value || 'My Custom Theme';
    });
    
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = (btn as HTMLElement).dataset.preset;
        if (preset) this.applyThemePreset(preset);
      });
    });
    
    const openThemeEditorBtn = document.getElementById('open-theme-editor-btn');
    if (openThemeEditorBtn) {
      openThemeEditorBtn.addEventListener('click', () => {
        this.showThemeEditor();
      });
    }

    const useCustomThemeBtn = document.getElementById('use-custom-theme-btn');
    if (useCustomThemeBtn) {
      useCustomThemeBtn.addEventListener('click', async () => {
        if (this.currentSettings.customTheme) {
          this.currentSettings.theme = 'custom';
          this.applySettingsCallback(this.currentSettings);
          await window.electronAPI.saveSettings(this.currentSettings);
          this.updateCustomThemeUI();
        }
      });
    }

    document.getElementById('theme-editor-modal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
        this.hideThemeEditor();
      }
    });
  }

  public updateCustomThemeUI() {
    const useCustomThemeBtn = document.getElementById('use-custom-theme-btn');
    const customThemeDescription = document.getElementById('custom-theme-description');
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;

    if (this.currentSettings.customTheme) {
      if (useCustomThemeBtn) {
        useCustomThemeBtn.style.display = 'block';
      }
      if (customThemeDescription) {
        const themeName = this.currentSettings.customTheme.name || 'Custom Theme';
        if (this.currentSettings.theme === 'custom') {
          customThemeDescription.textContent = `Currently using: ${themeName}`;
        } else {
          customThemeDescription.textContent = `Edit or use your custom theme: ${themeName}`;
        }
      }
      if (themeSelect && this.currentSettings.theme === 'custom') {
        themeSelect.value = 'default';
      }
    } else {
      if (useCustomThemeBtn) {
        useCustomThemeBtn.style.display = 'none';
      }
      if (customThemeDescription) {
        customThemeDescription.textContent = 'Create your own color scheme';
      }
    }
  }
}
