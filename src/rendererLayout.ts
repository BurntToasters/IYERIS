import type { Settings } from './types';

type ListColumnKey = 'name' | 'type' | 'size' | 'modified';

const SIDEBAR_MIN_WIDTH = 140;
const SIDEBAR_MAX_WIDTH = 360;
const PREVIEW_MIN_WIDTH = 200;
const PREVIEW_MAX_WIDTH = 520;

const LIST_COLUMN_MIN_WIDTHS: Record<string, number> = {
  name: 180,
  type: 120,
  size: 80,
  modified: 140,
};
const LIST_COLUMN_MAX_WIDTHS: Record<string, number> = {
  name: 640,
  type: 320,
  size: 200,
  modified: 320,
};

interface LayoutConfig {
  getCurrentSettings: () => Settings;
  debouncedSaveSettings: () => void;
  getSidebarResizeHandle: () => HTMLElement | null;
  getPreviewResizeHandle: () => HTMLElement | null;
  getListHeader: () => HTMLElement | null;
  consumeEvent: (e: Event) => void;
  changeSortMode: (mode: string) => void;
}

export function createLayoutController(config: LayoutConfig) {
  let activeListResizeColumn: string | null = null;
  let listResizeStartX = 0;
  let listResizeStartWidth = 0;
  let listResizeCurrentWidth = 0;

  function setListColumnWidth(key: ListColumnKey, width: number, persist: boolean = true): void {
    const min = LIST_COLUMN_MIN_WIDTHS[key] ?? 120;
    const max = LIST_COLUMN_MAX_WIDTHS[key] ?? 480;
    const clamped = Math.max(min, Math.min(max, Math.round(width)));
    const varName = key === 'modified' ? '--list-col-modified' : `--list-col-${key}`;
    const value = key === 'name' ? `minmax(${clamped}px, 1fr)` : `${clamped}px`;

    document.documentElement.style.setProperty(varName, value);

    if (persist) {
      const settings = config.getCurrentSettings();
      settings.listColumnWidths = {
        ...(settings.listColumnWidths || {}),
        [key]: clamped,
      };
      config.debouncedSaveSettings();
    }
  }

  function applyListColumnWidths(): void {
    const widths = config.getCurrentSettings().listColumnWidths;
    if (!widths) return;
    (['name', 'type', 'size', 'modified'] as ListColumnKey[]).forEach((key) => {
      const value = widths[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        setListColumnWidth(key, value, false);
      }
    });
  }

  function setSidebarWidth(width: number, persist: boolean = true): void {
    const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
    document.documentElement.style.setProperty('--sidebar-width-current', `${clamped}px`);
    if (persist) {
      config.getCurrentSettings().sidebarWidth = clamped;
      config.debouncedSaveSettings();
    }
  }

  function applySidebarWidth(): void {
    const settings = config.getCurrentSettings();
    if (typeof settings.sidebarWidth === 'number') {
      setSidebarWidth(settings.sidebarWidth, false);
    }
  }

  function setPreviewPanelWidth(width: number, persist: boolean = true): void {
    const clamped = Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, Math.round(width)));
    document.documentElement.style.setProperty('--preview-panel-width', `${clamped}px`);
    if (persist) {
      config.getCurrentSettings().previewPanelWidth = clamped;
      config.debouncedSaveSettings();
    }
  }

  function applyPreviewPanelWidth(): void {
    const settings = config.getCurrentSettings();
    if (typeof settings.previewPanelWidth === 'number') {
      setPreviewPanelWidth(settings.previewPanelWidth, false);
    }
  }

  function setSidebarCollapsed(collapsed?: boolean): void {
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    const toggle = document.getElementById('sidebar-toggle');
    if (!sidebar) return;
    const shouldCollapse =
      typeof collapsed === 'boolean' ? collapsed : !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', shouldCollapse);
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!shouldCollapse));
    }
  }

  function syncSidebarToggleState(): void {
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    const toggle = document.getElementById('sidebar-toggle');
    if (!sidebar || !toggle) return;
    toggle.setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed')));
  }

  function setupSidebarResize(): void {
    const sidebarResizeHandle = config.getSidebarResizeHandle();
    if (!sidebarResizeHandle) return;
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    if (!sidebar) return;
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      setSidebarWidth(startWidth + delta, false);
    };

    const onMouseUp = () => {
      sidebarResizeHandle.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const currentWidth = sidebar.getBoundingClientRect().width;
      setSidebarWidth(currentWidth, true);
    };

    sidebarResizeHandle.addEventListener('mousedown', (e) => {
      if (sidebar.classList.contains('collapsed')) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      sidebarResizeHandle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function setupSidebarSections(): void {
    const sections = document.querySelectorAll<HTMLElement>(
      '.sidebar-section[data-collapsible="true"]'
    );
    sections.forEach((section) => {
      const toggle = section.querySelector<HTMLButtonElement>('.section-toggle');
      if (!toggle) return;
      const syncAria = () => {
        const isCollapsed = section.classList.contains('collapsed');
        toggle.setAttribute('aria-expanded', String(!isCollapsed));
      };
      syncAria();
      toggle.addEventListener('click', () => {
        section.classList.toggle('collapsed');
        syncAria();
      });
    });
  }

  function setupPreviewResize(): void {
    const previewResizeHandle = config.getPreviewResizeHandle();
    if (!previewResizeHandle) return;
    const previewPanel = document.getElementById('preview-panel') as HTMLElement | null;
    if (!previewPanel) return;
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      setPreviewPanelWidth(startWidth + delta, false);
    };

    const onMouseUp = () => {
      previewResizeHandle.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const currentWidth = previewPanel.getBoundingClientRect().width;
      setPreviewPanelWidth(currentWidth, true);
    };

    previewResizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = previewPanel.getBoundingClientRect().width;
      previewResizeHandle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function setupListHeader(): void {
    const listHeader = config.getListHeader();
    if (!listHeader) return;

    listHeader.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.list-header-resize')) return;
      const cell = target.closest('.list-header-cell') as HTMLElement | null;
      if (!cell) return;
      const sortType = cell.dataset.sort;
      if (sortType) {
        config.changeSortMode(sortType);
      }
    });

    listHeader.querySelectorAll<HTMLElement>('.list-header-cell').forEach((cell) => {
      cell.tabIndex = 0;
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const sortType = cell.dataset.sort;
          if (sortType) {
            config.changeSortMode(sortType);
          }
        }
      });
    });

    listHeader.querySelectorAll('.list-header-resize').forEach((handle) => {
      const resizeHandle = handle as HTMLElement;
      resizeHandle.addEventListener('mousedown', (e) => {
        const mouseEvent = e as MouseEvent;
        config.consumeEvent(mouseEvent);
        const resizeKey = resizeHandle.dataset.resize as ListColumnKey | undefined;
        if (!resizeKey) return;
        activeListResizeColumn = resizeKey;
        const cell = resizeHandle.closest('.list-header-cell') as HTMLElement | null;
        if (!cell) return;
        listResizeStartX = mouseEvent.clientX;
        listResizeStartWidth = cell.getBoundingClientRect().width;
        listResizeCurrentWidth = listResizeStartWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
    });

    document.addEventListener('mousemove', (e) => {
      if (!activeListResizeColumn) return;
      const delta = e.clientX - listResizeStartX;
      listResizeCurrentWidth = listResizeStartWidth + delta;
      setListColumnWidth(activeListResizeColumn as ListColumnKey, listResizeCurrentWidth, false);
    });

    document.addEventListener('mouseup', () => {
      if (!activeListResizeColumn) return;
      setListColumnWidth(activeListResizeColumn as ListColumnKey, listResizeCurrentWidth, true);
      activeListResizeColumn = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  return {
    applyListColumnWidths,
    applySidebarWidth,
    applyPreviewPanelWidth,
    setSidebarCollapsed,
    syncSidebarToggleState,
    setupSidebarResize,
    setupSidebarSections,
    setupPreviewResize,
    setupListHeader,
  };
}
