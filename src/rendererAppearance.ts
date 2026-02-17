import type { Settings } from './types';

const THEME_CLASSES = [
  'theme-dark',
  'theme-light',
  'theme-default',
  'theme-custom',
  'theme-nord',
  'theme-catppuccin',
  'theme-dracula',
  'theme-solarized',
  'theme-github',
];

const DENSITY_CLASSES = ['compact-ui', 'large-ui'];
const PREVIEW_POSITION_CLASSES = ['preview-right', 'preview-bottom'];

const CLASS_TOGGLES: Array<[className: string, enabled: (settings: Settings) => boolean]> = [
  ['reduce-motion', (settings) => settings.reduceMotion === true],
  ['high-contrast', (settings) => settings.highContrast === true],
  ['large-text', (settings) => settings.largeText === true],
  ['bold-text', (settings) => settings.boldText === true],
  ['visible-focus', (settings) => settings.visibleFocus === true],
  ['reduce-transparency', (settings) => settings.reduceTransparency === true],
  ['liquid-glass', (settings) => settings.liquidGlassMode === true],
  ['themed-icons', (settings) => settings.themedIcons === true],
  ['show-file-checkboxes', (settings) => settings.showFileCheckboxes === true],
  ['compact-file-info', (settings) => settings.compactFileInfo === true],
  ['hide-file-extensions', (settings) => settings.showFileExtensions === false],
];

type AppearanceDeps = {
  applyCustomThemeColors: (theme: NonNullable<Settings['customTheme']>) => void;
  clearCustomThemeColors: () => void;
};

function applyTheme(settings: Settings, deps: AppearanceDeps): void {
  document.body.classList.remove(...THEME_CLASSES);
  if (settings.theme && settings.theme !== 'default') {
    document.body.classList.add(`theme-${settings.theme}`);
  }

  if (settings.theme === 'custom' && settings.customTheme) {
    deps.applyCustomThemeColors(settings.customTheme);
  } else {
    deps.clearCustomThemeColors();
  }
}

function applyDensity(settings: Settings): void {
  document.body.classList.remove(...DENSITY_CLASSES);
  if (settings.uiDensity === 'compact') {
    document.body.classList.add('compact-ui');
  } else if (settings.uiDensity === 'larger') {
    document.body.classList.add('large-ui');
  }
}

function applyPreviewPanelPosition(settings: Settings): void {
  document.body.classList.remove(...PREVIEW_POSITION_CLASSES);
  if (settings.previewPanelPosition === 'bottom') {
    document.body.classList.add('preview-bottom');
  } else {
    document.body.classList.add('preview-right');
  }
}

function applyCssVariables(settings: Settings): void {
  if (settings.gridColumns && settings.gridColumns !== 'auto') {
    document.documentElement.style.setProperty('--grid-columns', settings.gridColumns);
  } else {
    document.documentElement.style.removeProperty('--grid-columns');
  }

  if (settings.iconSize && settings.iconSize > 0) {
    document.documentElement.style.setProperty('--icon-size-grid', `${settings.iconSize}px`);
  } else {
    document.documentElement.style.removeProperty('--icon-size-grid');
  }
}

function applyClassToggles(settings: Settings): void {
  for (const [className, enabled] of CLASS_TOGGLES) {
    document.body.classList.toggle(className, enabled(settings));
  }
}

export function applyAppearance(settings: Settings, deps: AppearanceDeps): void {
  applyTheme(settings, deps);
  applyClassToggles(settings);
  applyDensity(settings);
  applyCssVariables(settings);
  applyPreviewPanelPosition(settings);
}
