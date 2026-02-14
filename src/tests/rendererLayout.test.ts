// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLayoutController } from '../rendererLayout.js';

function makeConfig(overrides: Partial<ReturnType<typeof defaultConfig>> = {}) {
  return { ...defaultConfig(), ...overrides };
}

function defaultConfig() {
  const settings: Record<string, unknown> = {};
  return {
    getCurrentSettings: () => settings as any,
    debouncedSaveSettings: vi.fn(),
    getSidebarResizeHandle: () => null as HTMLElement | null,
    getPreviewResizeHandle: () => null as HTMLElement | null,
    getListHeader: () => null as HTMLElement | null,
    consumeEvent: vi.fn(),
    changeSortMode: vi.fn(),
  };
}

describe('rendererLayout', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.style.cssText = '';
  });

  describe('setListColumnWidth / applyListColumnWidths', () => {
    it('sets CSS custom property for name column as minmax', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);

      cfg.getCurrentSettings().listColumnWidths = { name: 300 };
      ctrl.applyListColumnWidths();
      const v = document.documentElement.style.getPropertyValue('--list-col-name');
      expect(v).toBe('minmax(300px, 1fr)');
    });

    it('sets CSS custom property for size column as px', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { size: 120 };
      ctrl.applyListColumnWidths();
      const v = document.documentElement.style.getPropertyValue('--list-col-size');
      expect(v).toBe('120px');
    });

    it('sets CSS custom property for type column', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { type: 200 };
      ctrl.applyListColumnWidths();
      const v = document.documentElement.style.getPropertyValue('--list-col-type');
      expect(v).toBe('200px');
    });

    it('sets CSS custom property for modified column', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { modified: 200 };
      ctrl.applyListColumnWidths();
      const v = document.documentElement.style.getPropertyValue('--list-col-modified');
      expect(v).toBe('200px');
    });

    it('clamps below minimum', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { size: 10 };
      ctrl.applyListColumnWidths();
      const v = document.documentElement.style.getPropertyValue('--list-col-size');
      expect(v).toBe('80px');
    });

    it('clamps above maximum', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { name: 9999 };
      ctrl.applyListColumnWidths();
      const v = document.documentElement.style.getPropertyValue('--list-col-name');
      expect(v).toBe('minmax(640px, 1fr)');
    });

    it('skips non-number / zero widths', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { name: 0, size: -5 };
      ctrl.applyListColumnWidths();

      expect(document.documentElement.style.getPropertyValue('--list-col-name')).toBe('');
    });

    it('does nothing when no listColumnWidths', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.applyListColumnWidths();
    });

    it('persists width to settings by default', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().listColumnWidths = { type: 200 };
      ctrl.applyListColumnWidths();

      expect(cfg.debouncedSaveSettings).not.toHaveBeenCalled();
    });
  });

  describe('setSidebarWidth / applySidebarWidth', () => {
    it('sets sidebar width CSS var and persists', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().sidebarWidth = 250;
      ctrl.applySidebarWidth();
      const v = document.documentElement.style.getPropertyValue('--sidebar-width-current');
      expect(v).toBe('250px');
    });

    it('clamps sidebar width to min/max', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().sidebarWidth = 50;
      ctrl.applySidebarWidth();
      expect(document.documentElement.style.getPropertyValue('--sidebar-width-current')).toBe(
        '140px'
      );
    });

    it('clamps sidebar width to max', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().sidebarWidth = 999;
      ctrl.applySidebarWidth();
      expect(document.documentElement.style.getPropertyValue('--sidebar-width-current')).toBe(
        '360px'
      );
    });

    it('does nothing when sidebarWidth is not a number', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.applySidebarWidth();
      expect(document.documentElement.style.getPropertyValue('--sidebar-width-current')).toBe('');
    });
  });

  describe('setPreviewPanelWidth / applyPreviewPanelWidth', () => {
    it('sets preview panel width CSS var', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().previewPanelWidth = 350;
      ctrl.applyPreviewPanelWidth();
      expect(document.documentElement.style.getPropertyValue('--preview-panel-width')).toBe(
        '350px'
      );
    });

    it('clamps to min', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().previewPanelWidth = 50;
      ctrl.applyPreviewPanelWidth();
      expect(document.documentElement.style.getPropertyValue('--preview-panel-width')).toBe(
        '200px'
      );
    });

    it('clamps to max', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      cfg.getCurrentSettings().previewPanelWidth = 999;
      ctrl.applyPreviewPanelWidth();
      expect(document.documentElement.style.getPropertyValue('--preview-panel-width')).toBe(
        '520px'
      );
    });

    it('does nothing when not a number', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.applyPreviewPanelWidth();
      expect(document.documentElement.style.getPropertyValue('--preview-panel-width')).toBe('');
    });
  });

  describe('setSidebarCollapsed', () => {
    it('adds collapsed class', () => {
      document.body.innerHTML = '<div class="sidebar"></div><button id="sidebar-toggle"></button>';
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setSidebarCollapsed(true);
      expect(document.querySelector('.sidebar')!.classList.contains('collapsed')).toBe(true);
      expect(document.getElementById('sidebar-toggle')!.getAttribute('aria-expanded')).toBe(
        'false'
      );
    });

    it('removes collapsed class', () => {
      document.body.innerHTML =
        '<div class="sidebar collapsed"></div><button id="sidebar-toggle"></button>';
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setSidebarCollapsed(false);
      expect(document.querySelector('.sidebar')!.classList.contains('collapsed')).toBe(false);
      expect(document.getElementById('sidebar-toggle')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('toggles when no argument', () => {
      document.body.innerHTML = '<div class="sidebar"></div>';
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setSidebarCollapsed();
      expect(document.querySelector('.sidebar')!.classList.contains('collapsed')).toBe(true);
      ctrl.setSidebarCollapsed();
      expect(document.querySelector('.sidebar')!.classList.contains('collapsed')).toBe(false);
    });

    it('does nothing without sidebar element', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setSidebarCollapsed(true);
    });
  });

  describe('syncSidebarToggleState', () => {
    it('syncs aria-expanded based on collapsed state', () => {
      document.body.innerHTML =
        '<div class="sidebar collapsed"></div><button id="sidebar-toggle"></button>';
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.syncSidebarToggleState();
      expect(document.getElementById('sidebar-toggle')!.getAttribute('aria-expanded')).toBe(
        'false'
      );
    });

    it('sets aria-expanded true when not collapsed', () => {
      document.body.innerHTML = '<div class="sidebar"></div><button id="sidebar-toggle"></button>';
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.syncSidebarToggleState();
      expect(document.getElementById('sidebar-toggle')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('does nothing without sidebar or toggle', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.syncSidebarToggleState();
    });
  });

  describe('setupSidebarResize', () => {
    it('does nothing with null handle', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setupSidebarResize();
    });

    it('does nothing without sidebar element', () => {
      const handle = document.createElement('div');
      document.body.appendChild(handle);
      const cfg = makeConfig({ getSidebarResizeHandle: () => handle });
      const ctrl = createLayoutController(cfg);
      ctrl.setupSidebarResize();
    });

    it('registers mousedown on handle', () => {
      const handle = document.createElement('div');
      const sidebar = document.createElement('div');
      sidebar.className = 'sidebar';
      document.body.appendChild(sidebar);
      document.body.appendChild(handle);
      const cfg = makeConfig({ getSidebarResizeHandle: () => handle });
      const ctrl = createLayoutController(cfg);
      ctrl.setupSidebarResize();

      sidebar.classList.add('collapsed');
      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, bubbles: true }));
      expect(handle.classList.contains('resizing')).toBe(false);

      sidebar.classList.remove('collapsed');
      handle.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 200, bubbles: true, cancelable: true })
      );
      expect(handle.classList.contains('resizing')).toBe(true);

      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(handle.classList.contains('resizing')).toBe(false);
    });
  });

  describe('setupSidebarSections', () => {
    it('toggles collapsed class on section toggle click', () => {
      document.body.innerHTML = `
        <div class="sidebar-section" data-collapsible="true">
          <button class="section-toggle"></button>
          <div>content</div>
        </div>
      `;
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setupSidebarSections();

      const toggle = document.querySelector('.section-toggle') as HTMLButtonElement;
      const section = document.querySelector('.sidebar-section') as HTMLElement;

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      toggle.click();
      expect(section.classList.contains('collapsed')).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.click();
      expect(section.classList.contains('collapsed')).toBe(false);
    });
  });

  describe('setupPreviewResize', () => {
    it('does nothing with null handle', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setupPreviewResize();
    });

    it('registers mousedown on handle', () => {
      const handle = document.createElement('div');
      document.body.innerHTML = '<div id="preview-panel"></div>';
      document.body.appendChild(handle);
      const cfg = makeConfig({ getPreviewResizeHandle: () => handle });
      const ctrl = createLayoutController(cfg);
      ctrl.setupPreviewResize();

      handle.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 400, bubbles: true, cancelable: true })
      );
      expect(handle.classList.contains('resizing')).toBe(true);
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(handle.classList.contains('resizing')).toBe(false);
    });
  });

  describe('setupListHeader', () => {
    it('does nothing with null header', () => {
      const cfg = makeConfig();
      const ctrl = createLayoutController(cfg);
      ctrl.setupListHeader();
    });

    it('calls changeSortMode on cell click', () => {
      document.body.innerHTML = `
        <div id="list-header">
          <div class="list-header-cell" data-sort="name">Name</div>
          <div class="list-header-cell" data-sort="size">Size</div>
        </div>
      `;
      const cfg = makeConfig({ getListHeader: () => document.getElementById('list-header') });
      const ctrl = createLayoutController(cfg);
      ctrl.setupListHeader();

      (document.querySelector('[data-sort="name"]') as HTMLElement).click();
      expect(cfg.changeSortMode).toHaveBeenCalledWith('name');
    });

    it('calls changeSortMode on Enter keydown', () => {
      document.body.innerHTML = `
        <div id="list-header">
          <div class="list-header-cell" data-sort="size">Size</div>
        </div>
      `;
      const cfg = makeConfig({ getListHeader: () => document.getElementById('list-header') });
      const ctrl = createLayoutController(cfg);
      ctrl.setupListHeader();

      const cell = document.querySelector('.list-header-cell') as HTMLElement;
      cell.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      expect(cfg.changeSortMode).toHaveBeenCalledWith('size');
    });

    it('calls changeSortMode on Space keydown', () => {
      document.body.innerHTML = `
        <div id="list-header">
          <div class="list-header-cell" data-sort="type">Type</div>
        </div>
      `;
      const cfg = makeConfig({ getListHeader: () => document.getElementById('list-header') });
      const ctrl = createLayoutController(cfg);
      ctrl.setupListHeader();

      const cell = document.querySelector('.list-header-cell') as HTMLElement;
      cell.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      );
      expect(cfg.changeSortMode).toHaveBeenCalledWith('type');
    });

    it('ignores click on resize handle', () => {
      document.body.innerHTML = `
        <div id="list-header">
          <div class="list-header-cell" data-sort="name">
            <span class="list-header-resize" data-resize="name"></span>
          </div>
        </div>
      `;
      const cfg = makeConfig({ getListHeader: () => document.getElementById('list-header') });
      const ctrl = createLayoutController(cfg);
      ctrl.setupListHeader();

      (document.querySelector('.list-header-resize') as HTMLElement).click();
      expect(cfg.changeSortMode).not.toHaveBeenCalled();
    });

    it('handles column resize mousedown/mousemove/mouseup', () => {
      document.body.innerHTML = `
        <div id="list-header">
          <div class="list-header-cell" data-sort="type" style="width:200px">
            <span class="list-header-resize" data-resize="type"></span>
          </div>
        </div>
      `;
      const cfg = makeConfig({ getListHeader: () => document.getElementById('list-header') });
      const ctrl = createLayoutController(cfg);
      ctrl.setupListHeader();

      const handle = document.querySelector('.list-header-resize') as HTMLElement;
      handle.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 200, bubbles: true, cancelable: true })
      );
      expect(cfg.consumeEvent).toHaveBeenCalled();

      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 250 }));

      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(cfg.debouncedSaveSettings).toHaveBeenCalled();
    });
  });
});
