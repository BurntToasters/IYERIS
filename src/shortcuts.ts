export type ShortcutBinding = string[];

export interface ShortcutDefinition {
  id: string;
  title: string;
  category: string;
  description?: string;
  defaultBinding: ShortcutBinding;
  defaultBindingMac?: ShortcutBinding;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: 'command-palette',
    title: 'Command Palette',
    category: 'General',
    defaultBinding: ['Ctrl', 'K'],
    defaultBindingMac: ['Meta', 'K'],
  },
  {
    id: 'settings',
    title: 'Open Settings',
    category: 'General',
    defaultBinding: ['Ctrl', ','],
    defaultBindingMac: ['Meta', ','],
  },
  {
    id: 'shortcuts',
    title: 'Show Shortcuts',
    category: 'General',
    defaultBinding: ['Ctrl', '/'],
    defaultBindingMac: ['Meta', '/'],
  },
  {
    id: 'search',
    title: 'Search',
    category: 'General',
    defaultBinding: ['Ctrl', 'F'],
    defaultBindingMac: ['Meta', 'F'],
  },
  {
    id: 'global-search',
    title: 'Global Search',
    category: 'General',
    defaultBinding: ['Ctrl', 'Shift', 'F'],
    defaultBindingMac: ['Meta', 'Shift', 'F'],
  },
  {
    id: 'toggle-sidebar',
    title: 'Toggle Sidebar',
    category: 'General',
    defaultBinding: ['Ctrl', 'B'],
    defaultBindingMac: ['Meta', 'B'],
  },
  {
    id: 'go-back',
    title: 'Go Back',
    category: 'Navigation',
    defaultBinding: ['Alt', 'ArrowLeft'],
  },
  {
    id: 'go-forward',
    title: 'Go Forward',
    category: 'Navigation',
    defaultBinding: ['Alt', 'ArrowRight'],
  },
  {
    id: 'go-up',
    title: 'Go to Parent',
    category: 'Navigation',
    defaultBinding: ['Alt', 'ArrowUp'],
  },
  {
    id: 'new-tab',
    title: 'New Tab',
    category: 'Navigation',
    defaultBinding: ['Ctrl', 'T'],
    defaultBindingMac: ['Meta', 'T'],
  },
  {
    id: 'close-tab',
    title: 'Close Current Tab',
    category: 'Navigation',
    defaultBinding: ['Ctrl', 'W'],
    defaultBindingMac: ['Meta', 'W'],
  },
  {
    id: 'next-tab',
    title: 'Next Tab',
    category: 'Navigation',
    defaultBinding: ['Ctrl', 'Tab'],
  },
  {
    id: 'prev-tab',
    title: 'Previous Tab',
    category: 'Navigation',
    defaultBinding: ['Ctrl', 'Shift', 'Tab'],
  },
  {
    id: 'new-window',
    title: 'New Window',
    category: 'File Operations',
    defaultBinding: ['Ctrl', 'N'],
    defaultBindingMac: ['Meta', 'N'],
  },
  {
    id: 'new-folder',
    title: 'New Folder',
    category: 'File Operations',
    defaultBinding: ['Ctrl', 'Shift', 'N'],
    defaultBindingMac: ['Meta', 'Shift', 'N'],
  },
  {
    id: 'new-file',
    title: 'New File',
    category: 'File Operations',
    defaultBinding: [],
    defaultBindingMac: [],
  },
  {
    id: 'copy',
    title: 'Copy',
    category: 'File Operations',
    defaultBinding: ['Ctrl', 'C'],
    defaultBindingMac: ['Meta', 'C'],
  },
  {
    id: 'cut',
    title: 'Cut',
    category: 'File Operations',
    defaultBinding: ['Ctrl', 'X'],
    defaultBindingMac: ['Meta', 'X'],
  },
  {
    id: 'paste',
    title: 'Paste',
    category: 'File Operations',
    defaultBinding: ['Ctrl', 'V'],
    defaultBindingMac: ['Meta', 'V'],
  },
  {
    id: 'select-all',
    title: 'Select All',
    category: 'Selection',
    defaultBinding: ['Ctrl', 'A'],
    defaultBindingMac: ['Meta', 'A'],
  },
  {
    id: 'undo',
    title: 'Undo',
    category: 'Undo/Redo',
    defaultBinding: ['Ctrl', 'Z'],
    defaultBindingMac: ['Meta', 'Z'],
  },
  {
    id: 'redo',
    title: 'Redo',
    category: 'Undo/Redo',
    defaultBinding: ['Ctrl', 'Y'],
    defaultBindingMac: ['Meta', 'Shift', 'Z'],
  },
  {
    id: 'zoom-in',
    title: 'Zoom In',
    category: 'View',
    defaultBinding: ['Ctrl', '='],
    defaultBindingMac: ['Meta', '='],
  },
  {
    id: 'zoom-out',
    title: 'Zoom Out',
    category: 'View',
    defaultBinding: ['Ctrl', '-'],
    defaultBindingMac: ['Meta', '-'],
  },
  {
    id: 'zoom-reset',
    title: 'Reset Zoom',
    category: 'View',
    defaultBinding: ['Ctrl', '0'],
    defaultBindingMac: ['Meta', '0'],
  },
];

export function getDefaultShortcuts(platform?: NodeJS.Platform): Record<string, ShortcutBinding> {
  const resolvedPlatform =
    platform ?? (typeof process !== 'undefined' ? process.platform : 'win32');
  const isMac = resolvedPlatform === 'darwin';
  const map: Record<string, ShortcutBinding> = {};
  for (const def of SHORTCUT_DEFINITIONS) {
    map[def.id] = isMac && def.defaultBindingMac ? def.defaultBindingMac : def.defaultBinding;
  }
  return map;
}
