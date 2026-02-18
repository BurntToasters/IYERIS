import { clearHtml } from './rendererDom.js';
import { escapeHtml } from './shared.js';
import type { ShortcutBinding } from './shortcuts.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';

type CommandPaletteMode = 'grid' | 'list' | 'column';

interface Command {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  keywords?: string[];
  shortcut?: ShortcutBinding;
  action: () => void;
  category?: string;
}

interface CommandPaletteActions {
  createNewFolder: () => void;
  createNewFile: () => void;
  refresh: () => void;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  showSettingsModal: () => void;
  showShortcutsModal: () => void;
  selectAll: () => void;
  copyToClipboard: () => void;
  cutToClipboard: () => void;
  pasteFromClipboard: () => void;
  deleteSelected: () => void;
  renameSelected: () => void;
  setViewMode: (mode: CommandPaletteMode) => void;
  addNewTab: () => void;
}

interface CommandPaletteDeps {
  activateModal: (modal: HTMLElement, options?: { restoreFocus?: boolean }) => void;
  deactivateModal: (modal: HTMLElement, options?: { restoreFocus?: boolean }) => void;
  showToast: (message: string, title?: string, type?: ToastType) => void;
  getShortcutBinding: (id: string) => ShortcutBinding | undefined;
  fixedShortcuts: Record<string, ShortcutBinding>;
  remappableCommandIds: Set<string>;
  formatShortcutKeyLabel: (key: string) => string;
  getTabsEnabled: () => boolean;
  twemojiImg: (emoji: string, className?: string) => string;
  actions: CommandPaletteActions;
}

export function createCommandPaletteController(deps: CommandPaletteDeps) {
  const commands: Command[] = [];
  let commandPaletteModal: HTMLElement | null = null;
  let commandPaletteInput: HTMLInputElement | null = null;
  let commandPaletteResults: HTMLElement | null = null;
  let commandPaletteEmpty: HTMLElement | null = null;
  let commandPaletteFocusedIndex = -1;
  let commandPalettePreviousFocus: HTMLElement | null = null;
  let commandsRegistered = false;

  function hasSubsequenceMatch(haystack: string, needle: string): boolean {
    if (!needle) return true;
    let i = 0;
    for (let j = 0; j < haystack.length && i < needle.length; j++) {
      if (haystack[j] === needle[i]) i++;
    }
    return i === needle.length;
  }

  function scoreCommandMatch(cmd: Command, query: string): number {
    if (!query) return 0;
    const tokens = query.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 0;

    const title = cmd.title.toLowerCase();
    const description = cmd.description?.toLowerCase() || '';
    const id = cmd.id.toLowerCase();
    const keywords = (cmd.keywords || []).map((word) => word.toLowerCase());

    let score = 0;
    for (const token of tokens) {
      let tokenScore = -1;
      if (title === token || id === token || keywords.includes(token)) {
        tokenScore = 120;
      } else if (
        title.startsWith(token) ||
        id.startsWith(token) ||
        keywords.some((word) => word.startsWith(token))
      ) {
        tokenScore = 90;
      } else if (title.includes(token)) {
        tokenScore = 70;
      } else if (id.includes(token) || keywords.some((word) => word.includes(token))) {
        tokenScore = 56;
      } else if (description.includes(token)) {
        tokenScore = 44;
      } else if (hasSubsequenceMatch(title, token) || hasSubsequenceMatch(id, token)) {
        tokenScore = 28;
      }

      if (tokenScore < 0) return -1;
      score += tokenScore;
    }

    if (tokens.length > 1 && (title.includes(query) || description.includes(query))) {
      score += 24;
    }
    return score;
  }

  function syncCommandShortcuts(): void {
    for (const cmd of commands) {
      if (deps.remappableCommandIds.has(cmd.id)) {
        cmd.shortcut = deps.getShortcutBinding(cmd.id);
      } else if (deps.fixedShortcuts[cmd.id]) {
        cmd.shortcut = deps.fixedShortcuts[cmd.id];
      } else {
        delete cmd.shortcut;
      }
    }

    if (commandPaletteModal && commandPaletteModal.style.display === 'flex') {
      renderCommandPaletteResults(commands);
    }
  }

  function initCommandPalette(): void {
    commandPaletteModal = document.getElementById('command-palette-modal');
    commandPaletteInput = document.getElementById('command-palette-input') as HTMLInputElement;
    commandPaletteResults = document.getElementById('command-palette-results');
    commandPaletteEmpty = document.getElementById('command-palette-empty');

    if (!commandPaletteModal || !commandPaletteInput || !commandPaletteResults) return;

    registerCommands();
    syncCommandShortcuts();

    commandPaletteInput.addEventListener('input', handleCommandPaletteSearch);
    commandPaletteInput.addEventListener('keydown', handleCommandPaletteKeydown);

    commandPaletteModal.addEventListener('click', (e) => {
      if (e.target === commandPaletteModal) {
        hideCommandPalette();
      }
    });
  }

  function registerCommands(): void {
    if (commandsRegistered) return;
    commandsRegistered = true;

    const {
      createNewFolder,
      createNewFile,
      refresh,
      goBack,
      goForward,
      goUp,
      showSettingsModal,
      showShortcutsModal,
      selectAll,
      copyToClipboard,
      cutToClipboard,
      pasteFromClipboard,
      deleteSelected,
      renameSelected,
      setViewMode,
      addNewTab,
    } = deps.actions;

    const clickBtn = (id: string) => () => document.getElementById(id)?.click();

    // [id, title, description, icon, action, shortcutSource]
    // shortcutSource: 'r' = remappable (getShortcutBinding), 'f' = fixed, undefined = none
    const defs: [
      string,
      string,
      string,
      string,
      () => void,
      'r' | 'f' | undefined,
      string[] | undefined,
    ][] = [
      ['new-folder', 'New Folder', 'Create a new folder', '📁', createNewFolder, 'r', ['mkdir']],
      ['new-file', 'New File', 'Create a new file', '📄', createNewFile, 'r', ['touch']],
      [
        'search',
        'Search',
        'Search files in current folder',
        '🔍',
        clickBtn('search-btn'),
        'r',
        ['find', 'lookup'],
      ],
      ['refresh', 'Refresh', 'Reload current folder', '🔄', refresh, 'f', ['reload', 'rescan']],
      ['go-back', 'Go Back', 'Navigate to previous folder', '⬅️', goBack, 'r', ['back']],
      ['go-forward', 'Go Forward', 'Navigate to next folder', '➡️', goForward, 'r', ['forward']],
      ['go-up', 'Go Up', 'Navigate to parent folder', '⬆️', goUp, 'r', ['parent']],
      ['settings', 'Settings', 'Open settings', '⚙️', showSettingsModal, 'r', ['preferences']],
      [
        'shortcuts',
        'Keyboard Shortcuts',
        'View all keyboard shortcuts',
        '⌨️',
        showShortcutsModal,
        'r',
        ['hotkeys', 'keys'],
      ],
      ['select-all', 'Select All', 'Select all items', '☑️', selectAll, 'r', ['highlight']],
      ['copy', 'Copy', 'Copy selected items', '📋', copyToClipboard, 'r', ['duplicate']],
      ['cut', 'Cut', 'Cut selected items', '✂️', cutToClipboard, 'r', ['move']],
      ['paste', 'Paste', 'Paste items', '📎', pasteFromClipboard, 'r', ['insert']],
      ['delete', 'Delete', 'Delete selected items', '🗑️', deleteSelected, 'f', ['remove']],
      ['rename', 'Rename', 'Rename selected item', '✍️', renameSelected, 'f', ['edit name']],
      [
        'grid-view',
        'Grid View',
        'Switch to grid view',
        '▦',
        () => setViewMode('grid'),
        undefined,
        ['tiles'],
      ],
      [
        'list-view',
        'List View',
        'Switch to list view',
        '☰',
        () => setViewMode('list'),
        undefined,
        ['rows', 'details'],
      ],
      [
        'column-view',
        'Column View',
        'Switch to column view',
        '|||',
        () => setViewMode('column'),
        undefined,
        ['finder', 'columns'],
      ],
      [
        'toggle-preview',
        'Toggle Preview Panel',
        'Show or hide preview panel',
        '👁️',
        clickBtn('preview-toggle-btn'),
        undefined,
        ['preview', 'inspector'],
      ],
      [
        'toggle-sidebar',
        'Toggle Sidebar',
        'Show or hide sidebar',
        '📂',
        clickBtn('sidebar-toggle'),
        'r',
        ['navigation'],
      ],
      [
        'new-tab',
        'New Tab',
        'Open new tab',
        '➕',
        () => {
          if (deps.getTabsEnabled()) addNewTab();
        },
        'r',
        ['tab'],
      ],
    ];

    for (const [id, title, description, icon, fn, src, keywords] of defs) {
      const shortcut =
        src === 'r'
          ? deps.getShortcutBinding(id)
          : src === 'f'
            ? deps.fixedShortcuts[id]
            : undefined;
      commands.push({
        id,
        title,
        description,
        icon,
        keywords,
        shortcut,
        action: () => {
          hideCommandPalette();
          fn();
        },
      });
    }
  }

  function showCommandPalette(): void {
    if (!commandPaletteModal || !commandPaletteInput || !commandPaletteResults) return;

    commandPalettePreviousFocus = document.activeElement as HTMLElement;

    commandPaletteModal.style.display = 'flex';
    deps.activateModal(commandPaletteModal, { restoreFocus: false });
    commandPaletteInput.value = '';
    commandPaletteFocusedIndex = -1;
    renderCommandPaletteResults(commands);

    setTimeout(() => {
      commandPaletteInput?.focus();
    }, 50);
  }

  function hideCommandPalette(): void {
    if (commandPaletteModal) {
      commandPaletteModal.style.display = 'none';
      deps.deactivateModal(commandPaletteModal, { restoreFocus: false });
    }

    if (commandPalettePreviousFocus && typeof commandPalettePreviousFocus.focus === 'function') {
      commandPalettePreviousFocus.focus();
      commandPalettePreviousFocus = null;
    }
  }

  function handleCommandPaletteSearch(): void {
    if (!commandPaletteInput) return;

    const query = commandPaletteInput.value.toLowerCase().trim();

    if (!query) {
      renderCommandPaletteResults(commands);
      return;
    }

    const filtered = commands
      .map((cmd, index) => ({
        cmd,
        index,
        score: scoreCommandMatch(cmd, query),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.cmd);

    renderCommandPaletteResults(filtered);
  }

  function renderCommandPaletteResults(cmds: Command[]): void {
    if (!commandPaletteResults || !commandPaletteEmpty) return;

    const resultsContainer = commandPaletteResults;
    const emptyContainer = commandPaletteEmpty;

    clearHtml(resultsContainer);
    commandPaletteFocusedIndex = -1;

    if (cmds.length === 0) {
      resultsContainer.style.display = 'none';
      emptyContainer.style.display = 'flex';
      return;
    }

    resultsContainer.style.display = 'flex';
    emptyContainer.style.display = 'none';

    cmds.forEach((cmd, index) => {
      const item = document.createElement('div');
      item.className = 'command-palette-item';
      item.dataset.index = String(index);

      let shortcutHtml = '';
      if (cmd.shortcut) {
        shortcutHtml = `
        <div class="command-palette-item-shortcut">
          ${cmd.shortcut
            .map(
              (key) =>
                `<kbd class="command-palette-key">${escapeHtml(deps.formatShortcutKeyLabel(key))}</kbd>`
            )
            .join('')}
        </div>
      `;
      }

      item.innerHTML = `
      <div class="command-palette-item-left">
        ${cmd.icon ? `<span class="command-palette-item-icon">${deps.twemojiImg(cmd.icon, 'twemoji command-palette-emoji')}</span>` : ''}
        <div class="command-palette-item-text">
          <div class="command-palette-item-title">${escapeHtml(cmd.title)}</div>
          ${cmd.description ? `<div class="command-palette-item-description">${escapeHtml(cmd.description)}</div>` : ''}
        </div>
      </div>
      ${shortcutHtml}
    `;

      item.addEventListener('click', () => {
        try {
          cmd.action();
        } catch (error) {
          console.error(`Command palette error executing "${cmd.id}":`, error);
          deps.showToast(`Failed to execute command: ${cmd.title}`, 'Command Error', 'error');
        }
      });

      item.addEventListener('mouseenter', () => {
        setCommandPaletteFocus(index);
      });

      resultsContainer.appendChild(item);
    });
  }

  function setCommandPaletteFocus(index: number): void {
    if (!commandPaletteResults) return;

    const items = commandPaletteResults.querySelectorAll('.command-palette-item');
    items.forEach((item, i) => {
      if (i === index) {
        item.classList.add('focused');
        commandPaletteFocusedIndex = index;
      } else {
        item.classList.remove('focused');
      }
    });
  }

  function handleCommandPaletteKeydown(e: KeyboardEvent): void {
    if (!commandPaletteResults) return;

    const items = commandPaletteResults.querySelectorAll('.command-palette-item');

    if (e.key === 'Escape') {
      e.preventDefault();
      hideCommandPalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = commandPaletteFocusedIndex + 1;
      if (nextIndex < items.length) {
        setCommandPaletteFocus(nextIndex);
        if (commandPaletteResults) {
          items[nextIndex].scrollIntoView({ block: 'nearest' });
        }
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = commandPaletteFocusedIndex - 1;
      if (prevIndex >= 0) {
        setCommandPaletteFocus(prevIndex);
        if (commandPaletteResults) {
          items[prevIndex].scrollIntoView({ block: 'nearest' });
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (commandPaletteFocusedIndex >= 0 && commandPaletteFocusedIndex < items.length) {
        (items[commandPaletteFocusedIndex] as HTMLElement).click();
      } else if (items.length > 0) {
        (items[0] as HTMLElement).click();
      }
    }
  }

  return {
    initCommandPalette,
    showCommandPalette,
    hideCommandPalette,
    syncCommandShortcuts,
  };
}
