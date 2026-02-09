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

    commands.push(
      {
        id: 'new-folder',
        title: 'New Folder',
        description: 'Create a new folder',
        icon: '📁',
        shortcut: deps.getShortcutBinding('new-folder'),
        action: () => {
          hideCommandPalette();
          createNewFolder();
        },
      },
      {
        id: 'new-file',
        title: 'New File',
        description: 'Create a new file',
        icon: '📄',
        shortcut: deps.getShortcutBinding('new-file'),
        action: () => {
          hideCommandPalette();
          createNewFile();
        },
      },
      {
        id: 'search',
        title: 'Search',
        description: 'Search files in current folder',
        icon: '🔍',
        shortcut: deps.getShortcutBinding('search'),
        action: () => {
          hideCommandPalette();
          document.getElementById('search-btn')?.click();
        },
      },
      {
        id: 'refresh',
        title: 'Refresh',
        description: 'Reload current folder',
        icon: '🔄',
        shortcut: deps.fixedShortcuts.refresh,
        action: () => {
          hideCommandPalette();
          refresh();
        },
      },
      {
        id: 'go-back',
        title: 'Go Back',
        description: 'Navigate to previous folder',
        icon: '⬅️',
        shortcut: deps.getShortcutBinding('go-back'),
        action: () => {
          hideCommandPalette();
          goBack();
        },
      },
      {
        id: 'go-forward',
        title: 'Go Forward',
        description: 'Navigate to next folder',
        icon: '➡️',
        shortcut: deps.getShortcutBinding('go-forward'),
        action: () => {
          hideCommandPalette();
          goForward();
        },
      },
      {
        id: 'go-up',
        title: 'Go Up',
        description: 'Navigate to parent folder',
        icon: '⬆️',
        shortcut: deps.getShortcutBinding('go-up'),
        action: () => {
          hideCommandPalette();
          goUp();
        },
      },
      {
        id: 'settings',
        title: 'Settings',
        description: 'Open settings',
        icon: '⚙️',
        shortcut: deps.getShortcutBinding('settings'),
        action: () => {
          hideCommandPalette();
          showSettingsModal();
        },
      },
      {
        id: 'shortcuts',
        title: 'Keyboard Shortcuts',
        description: 'View all keyboard shortcuts',
        icon: '⌨️',
        shortcut: deps.getShortcutBinding('shortcuts'),
        action: () => {
          hideCommandPalette();
          showShortcutsModal();
        },
      },
      {
        id: 'select-all',
        title: 'Select All',
        description: 'Select all items',
        icon: '☑️',
        shortcut: deps.getShortcutBinding('select-all'),
        action: () => {
          hideCommandPalette();
          selectAll();
        },
      },
      {
        id: 'copy',
        title: 'Copy',
        description: 'Copy selected items',
        icon: '📋',
        shortcut: deps.getShortcutBinding('copy'),
        action: () => {
          hideCommandPalette();
          copyToClipboard();
        },
      },
      {
        id: 'cut',
        title: 'Cut',
        description: 'Cut selected items',
        icon: '✂️',
        shortcut: deps.getShortcutBinding('cut'),
        action: () => {
          hideCommandPalette();
          cutToClipboard();
        },
      },
      {
        id: 'paste',
        title: 'Paste',
        description: 'Paste items',
        icon: '📎',
        shortcut: deps.getShortcutBinding('paste'),
        action: () => {
          hideCommandPalette();
          pasteFromClipboard();
        },
      },
      {
        id: 'delete',
        title: 'Delete',
        description: 'Delete selected items',
        icon: '🗑️',
        shortcut: deps.fixedShortcuts.delete,
        action: () => {
          hideCommandPalette();
          deleteSelected();
        },
      },
      {
        id: 'rename',
        title: 'Rename',
        description: 'Rename selected item',
        icon: '✍️',
        shortcut: deps.fixedShortcuts.rename,
        action: () => {
          hideCommandPalette();
          renameSelected();
        },
      },
      {
        id: 'grid-view',
        title: 'Grid View',
        description: 'Switch to grid view',
        icon: '▦',
        action: () => {
          hideCommandPalette();
          setViewMode('grid');
        },
      },
      {
        id: 'list-view',
        title: 'List View',
        description: 'Switch to list view',
        icon: '☰',
        action: () => {
          hideCommandPalette();
          setViewMode('list');
        },
      },
      {
        id: 'column-view',
        title: 'Column View',
        description: 'Switch to column view',
        icon: '|||',
        action: () => {
          hideCommandPalette();
          setViewMode('column');
        },
      },
      {
        id: 'toggle-preview',
        title: 'Toggle Preview Panel',
        description: 'Show or hide preview panel',
        icon: '👁️',
        action: () => {
          hideCommandPalette();
          document.getElementById('preview-toggle-btn')?.click();
        },
      },
      {
        id: 'toggle-sidebar',
        title: 'Toggle Sidebar',
        description: 'Show or hide sidebar',
        icon: '📂',
        shortcut: deps.getShortcutBinding('toggle-sidebar'),
        action: () => {
          hideCommandPalette();
          document.getElementById('sidebar-toggle')?.click();
        },
      },
      {
        id: 'new-tab',
        title: 'New Tab',
        description: 'Open new tab',
        icon: '➕',
        shortcut: deps.getShortcutBinding('new-tab'),
        action: () => {
          hideCommandPalette();
          if (deps.getTabsEnabled()) addNewTab();
        },
      }
    );
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

    const filtered = commands.filter(
      (cmd) =>
        cmd.title.toLowerCase().includes(query) ||
        cmd.description?.toLowerCase().includes(query) ||
        cmd.id.toLowerCase().includes(query)
    );

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
        ${cmd.icon ? `<span class="command-palette-item-icon">${cmd.icon}</span>` : ''}
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
