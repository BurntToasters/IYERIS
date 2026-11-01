import { t } from './i18n.js';

type ToolbarControllerConfig = {
  updateUndoRedoState: () => Promise<void>;
  performUndo: () => void;
  performRedo: () => void;
  hideSortMenu: () => void;
  hideContextMenu: () => void;
  hideEmptySpaceContextMenu: () => void;
};

type ToolbarNodeRecord = {
  element: HTMLElement;
  marker: Comment;
  priority: number;
  order: number;
  radioItems: Array<{
    element: HTMLElement;
    hadContextMenuClass: boolean;
    hadMoreMenuClass: boolean;
  }>;
  originalRole: string | null;
  originalTabIndex: string | null;
  hadContextMenuClass: boolean;
  hadMoreMenuClass: boolean;
};

export function createToolbarController(config: ToolbarControllerConfig) {
  let initialized = false;
  let reflowFrame = 0;
  let observer: ResizeObserver | null = null;
  let bodyClassObserver: MutationObserver | null = null;
  let toolbarStateObserver: MutationObserver | null = null;
  const responsiveItems: ToolbarNodeRecord[] = [];
  const openedMenuTabIndexes = new Map<HTMLElement, string | null>();

  function getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  function setActionLabel(element: HTMLElement, translationKey: Parameters<typeof t>[0]): void {
    let label = element.querySelector<HTMLElement>(':scope > .toolbar-action-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'toolbar-action-label';
      element.appendChild(label);
    }
    label.textContent = t(translationKey);
  }

  function moveNodeToMenu(
    element: HTMLElement | null,
    parent: HTMLElement,
    priority: number,
    order: number
  ): ToolbarNodeRecord | null {
    if (!element?.parentElement || responsiveItems.some((item) => item.element === element)) {
      return null;
    }
    const origin = element.parentElement;
    const marker = document.createComment(`toolbar-home:${element.id}`);
    origin.insertBefore(marker, element);
    const record: ToolbarNodeRecord = {
      element,
      marker,
      priority,
      order,
      radioItems:
        element.getAttribute('role') === 'radiogroup'
          ? Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]')).map((radio) => ({
              element: radio,
              hadContextMenuClass: radio.classList.contains('context-menu-item'),
              hadMoreMenuClass: radio.classList.contains('more-menu-action'),
            }))
          : [],
      originalRole: element.getAttribute('role'),
      originalTabIndex: element.getAttribute('tabindex'),
      hadContextMenuClass: element.classList.contains('context-menu-item'),
      hadMoreMenuClass: element.classList.contains('more-menu-action'),
    };
    responsiveItems.push(record);
    insertInMenuOrder(element, parent, order);
    if (element.getAttribute('role') === 'radiogroup') {
      record.radioItems.forEach(({ element: radio }) => {
        radio.classList.add('context-menu-item', 'more-menu-action');
      });
    } else {
      element.classList.add('context-menu-item', 'more-menu-action');
      if (element instanceof HTMLButtonElement) element.setAttribute('role', 'menuitem');
    }
    return record;
  }

  function insertInMenuOrder(element: HTMLElement, parent: HTMLElement, order: number): void {
    const next = responsiveItems
      .filter((item) => item.element !== element && item.element.parentElement === parent)
      .filter((item) => item.order > order)
      .sort((left, right) => left.order - right.order)[0];
    if (next) parent.insertBefore(element, next.element);
    else parent.appendChild(element);
  }

  function restoreNode(record: ToolbarNodeRecord): void {
    if (!record.marker.parentNode) return;
    record.marker.parentNode.insertBefore(record.element, record.marker);
    if (!record.hadContextMenuClass) record.element.classList.remove('context-menu-item');
    if (!record.hadMoreMenuClass) record.element.classList.remove('more-menu-action');
    record.radioItems.forEach(({ element, hadContextMenuClass, hadMoreMenuClass }) => {
      if (!hadContextMenuClass) element.classList.remove('context-menu-item');
      if (!hadMoreMenuClass) element.classList.remove('more-menu-action');
    });
    if (record.originalRole === null) record.element.removeAttribute('role');
    else record.element.setAttribute('role', record.originalRole);
    if (record.originalTabIndex === null) record.element.removeAttribute('tabindex');
    else record.element.setAttribute('tabindex', record.originalTabIndex);
  }

  function moveResponsiveNode(record: ToolbarNodeRecord, parent: HTMLElement): void {
    insertInMenuOrder(record.element, parent, record.order);
    if (record.element.getAttribute('role') === 'radiogroup') {
      record.radioItems.forEach(({ element }) => {
        element.classList.add('context-menu-item', 'more-menu-action');
      });
    } else {
      record.element.classList.add('context-menu-item', 'more-menu-action');
      if (record.element instanceof HTMLButtonElement)
        record.element.setAttribute('role', 'menuitem');
    }
  }

  function isStyleShown(element: HTMLElement): boolean {
    if (element.hidden) return false;
    const style = window.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    );
  }

  function isShown(element: HTMLElement): boolean {
    let ancestor: HTMLElement | null = element;
    while (ancestor) {
      if (!isStyleShown(ancestor)) return false;
      ancestor = ancestor.parentElement;
    }
    return element.getClientRects().length > 0;
  }

  function updateMenuSections(): void {
    const overflowItems = getElement('more-overflow-items');
    const selectionActions = getElement('more-selection-actions');
    const selectionSummary = getElement('selection-indicator');
    const primarySeparator = getElement('more-primary-separator');
    const selectionSeparator = getElement('more-selection-separator');
    const historySeparator = getElement('more-history-separator');

    if (overflowItems) overflowItems.hidden = overflowItems.childElementCount === 0;
    const hasSelection = !!selectionSummary && isStyleShown(selectionSummary);
    if (selectionActions) selectionActions.hidden = !hasSelection;
    if (selectionSeparator) selectionSeparator.hidden = !hasSelection;
    if (primarySeparator)
      primarySeparator.hidden = !hasSelection && !overflowItems?.childElementCount;
    if (historySeparator)
      historySeparator.hidden = !hasSelection && !overflowItems?.childElementCount;
  }

  function getMenuItems(menu: HTMLElement): HTMLElement[] {
    return Array.from(
      menu.querySelectorAll<HTMLElement>('.context-menu-item, [role="menuitem"], [role="radio"]')
    ).filter((item) => {
      if (item.closest('#selection-overflow-menu')) return false;
      if (item.getAttribute('role') === 'radiogroup') return false;
      if (!isShown(item)) return false;
      return !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true';
    });
  }

  function resetMenuTabIndexes(menu: HTMLElement): void {
    openedMenuTabIndexes.forEach((tabIndex, item) => {
      if (!item.isConnected) return;
      if (item.getAttribute('role') === 'radio') return;
      if (tabIndex === null) item.removeAttribute('tabindex');
      else item.setAttribute('tabindex', tabIndex);
    });
    openedMenuTabIndexes.clear();
    menu.querySelectorAll<HTMLElement>('.focused').forEach((item) => {
      item.classList.remove('focused');
    });
  }

  function focusMenuItem(menu: HTMLElement, item: HTMLElement): void {
    const items = getMenuItems(menu);
    items.forEach((candidate) => {
      candidate.classList.toggle('focused', candidate === item);
      if (candidate.getAttribute('role') !== 'radio') {
        candidate.tabIndex = candidate === item ? 0 : -1;
      }
    });
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  }

  function positionMenu(button: HTMLElement, menu: HTMLElement): void {
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gutter = 8;
    const left = Math.max(
      gutter,
      Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - gutter)
    );
    let top = rect.bottom + 5;
    if (top + menuRect.height > window.innerHeight - gutter) {
      top = rect.top - menuRect.height - 5;
    }
    top = Math.max(gutter, Math.min(top, window.innerHeight - menuRect.height - gutter));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function setupMoreActionsMenu(): void {
    const button = getElement<HTMLButtonElement>('more-actions-btn');
    const menu = getElement('more-actions-menu');
    const primaryActions = getElement('more-primary-actions');
    const overflowItems = getElement('more-overflow-items');
    const selectionActions = getElement('more-selection-actions');
    const toolbar = document.querySelector<HTMLElement>('.toolbar');
    if (!button || !menu || !primaryActions || !overflowItems || !selectionActions || !toolbar) {
      return;
    }

    const refreshButton = getElement('refresh-btn');
    const newFileButton = getElement('new-file-btn');
    const sortButton = getElement('sort-btn');
    const selectionIndicator = getElement('selection-indicator');

    if (refreshButton) primaryActions.appendChild(refreshButton);
    if (newFileButton) primaryActions.appendChild(newFileButton);
    if (sortButton) primaryActions.appendChild(sortButton);
    if (selectionIndicator) selectionActions.appendChild(selectionIndicator);

    [refreshButton, newFileButton, sortButton].forEach((item) => {
      item?.classList.add('context-menu-item', 'more-menu-action');
      item?.setAttribute('role', 'menuitem');
    });

    if (refreshButton) {
      setActionLabel(refreshButton, 'toolbar.menu.refresh');
      refreshButton.setAttribute('aria-label', t('toolbar.menu.refresh'));
      refreshButton.title = `${t('toolbar.menu.refresh')} (F5)`;
    }
    if (newFileButton) {
      setActionLabel(newFileButton, 'toolbar.menu.newFile');
      newFileButton.setAttribute('aria-label', t('toolbar.menu.newFile'));
      newFileButton.title = t('toolbar.menu.newFile');
    }
    if (sortButton) {
      setActionLabel(sortButton, 'toolbar.menu.sort');
      sortButton.setAttribute('aria-label', t('toolbar.menu.sort'));
      sortButton.setAttribute('aria-haspopup', 'menu');
      sortButton.setAttribute('aria-controls', 'sort-menu');
      sortButton.title = t('toolbar.menu.sort');
      if (!sortButton.querySelector(':scope > .more-submenu-indicator')) {
        const arrow = document.createElement('span');
        arrow.className = 'more-submenu-indicator';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        sortButton.appendChild(arrow);
      }
    }
    if (selectionIndicator) {
      selectionIndicator.setAttribute('role', 'group');
      selectionIndicator.setAttribute('aria-label', t('toolbar.menu.moreSelection'));
      const selectAll = getElement('select-all-btn');
      const deselectAll = getElement('deselect-all-btn');
      const selectionOverflow = getElement('selection-overflow-btn');
      const selectionMenu = getElement('selection-overflow-menu');
      const labels: Array<[HTMLElement | null, string]> = [
        [selectAll, 'toolbar.menu.selectAll'],
        [deselectAll, 'toolbar.menu.deselectAll'],
        [selectionOverflow, 'toolbar.menu.moreSelection'],
        [getElement('selection-copy-btn'), 'toolbar.menu.copy'],
        [getElement('selection-cut-btn'), 'toolbar.menu.cut'],
        [getElement('selection-move-btn'), 'toolbar.menu.moveTo'],
        [getElement('selection-rename-btn'), 'toolbar.menu.rename'],
        [getElement('selection-delete-btn'), 'toolbar.menu.delete'],
      ];
      labels.forEach(([element, key]) => {
        if (element) element.textContent = t(key as Parameters<typeof t>[0]);
      });
      [selectAll, deselectAll, selectionOverflow].forEach((item) => {
        if (!item) return;
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
      });
      selectionOverflow?.setAttribute('aria-haspopup', 'menu');
      selectionOverflow?.setAttribute('aria-controls', 'selection-overflow-menu');
      selectionMenu?.querySelectorAll<HTMLElement>('.selection-overflow-item').forEach((item) => {
        item.classList.add('context-menu-item');
        item.tabIndex = -1;
      });
    }

    const historyActionLabels: Array<[string, Parameters<typeof t>[0]]> = [
      ['more-undo-btn', 'toolbar.menu.undo'],
      ['more-redo-btn', 'toolbar.menu.redo'],
    ];
    historyActionLabels.forEach(([id, key]) => {
      const label = getElement(id)?.querySelector<HTMLElement>(':scope > span:first-child');
      if (label) label.textContent = t(key);
    });

    // Lower priority controls overflow first. Restore the reverse order as room returns.
    const candidateDefinitions: Array<[string, Parameters<typeof t>[0], number, number]> = [
      ['settings-btn', 'toolbar.menu.settings', 0, 4],
      ['preview-toggle-btn', 'toolbar.menu.preview', 1, 3],
      ['copy-to-other-pane-btn', 'toolbar.menu.copyToPane', 2, 5],
      ['move-to-other-pane-btn', 'toolbar.menu.moveToPane', 3, 6],
      ['view-options', 'toolbar.menu.viewMode', 4, 2],
      ['new-folder-btn', 'toolbar.menu.newFolder', 5, 1],
      ['up-btn', 'toolbar.menu.up', 6, 0],
    ];
    candidateDefinitions.forEach(([id, key, priority, order]) => {
      const element = getElement(id);
      if (!element) return;
      if (id === 'view-options') {
        element.setAttribute('aria-label', t(key));
        element.querySelectorAll<HTMLElement>('.view-option-label').forEach((label) => {
          const view = label.closest<HTMLElement>('.view-option')?.dataset.view;
          if (view === 'grid') label.textContent = t('toolbar.view.grid');
          else if (view === 'list') label.textContent = t('toolbar.view.list');
          else if (view === 'column') label.textContent = t('toolbar.view.column');
        });
        moveNodeToMenu(element, overflowItems, priority, order);
        return;
      }
      setActionLabel(element, key);
      element.setAttribute('aria-label', t(key));
      element.title = t(key);
      moveNodeToMenu(element, overflowItems, priority, order);
    });

    const moreLabel = t('toolbar.moreActions');
    button.setAttribute('aria-label', moreLabel);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', 'more-actions-menu');
    button.title = moreLabel;
    menu.tabIndex = -1;

    const updateSections = () => updateMenuSections();

    const closeMenu = (restoreFocus = false) => {
      const activeElement = document.activeElement;
      const hadMenuFocus =
        menu.contains(activeElement) || !!getElement('sort-menu')?.contains(activeElement);
      config.hideSortMenu();
      menu.style.display = 'none';
      button.setAttribute('aria-expanded', 'false');
      resetMenuTabIndexes(menu);
      const selectionMenu = getElement('selection-overflow-menu');
      const selectionButton = getElement('selection-overflow-btn');
      if (selectionMenu) selectionMenu.style.display = 'none';
      selectionButton?.setAttribute('aria-expanded', 'false');
      if (restoreFocus || hadMenuFocus) button.focus({ preventScroll: true });
      scheduleReflow();
    };

    const openMenu = () => {
      if (menu.style.display === 'block') {
        closeMenu();
        return;
      }
      config.hideSortMenu();
      config.hideContextMenu();
      config.hideEmptySpaceContextMenu();
      menu.style.display = 'block';
      updateSections();
      void config.updateUndoRedoState();
      const items = getMenuItems(menu);
      openedMenuTabIndexes.clear();
      items.forEach((item) => {
        if (item.getAttribute('role') === 'radio') return;
        openedMenuTabIndexes.set(item, item.getAttribute('tabindex'));
        item.tabIndex = -1;
      });
      positionMenu(button, menu);
      const first = items[0];
      if (first) focusMenuItem(menu, first);
      else menu.focus({ preventScroll: true });
      button.setAttribute('aria-expanded', 'true');
    };

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu();
    });

    menu.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const item = target?.closest<HTMLElement>('.context-menu-item, [role="menuitem"]');
      if (!item || item.closest('#selection-overflow-menu') || item.id === 'sort-btn') return;
      event.stopPropagation();
      if (item.id === 'more-undo-btn') void config.performUndo();
      else if (item.id === 'more-redo-btn') void config.performRedo();
      closeMenu();
    });

    menu.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (event.key === 'Tab') {
        closeMenu();
        return;
      }
      const items = getMenuItems(menu);
      if (items.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      const currentIndex = current ? items.indexOf(current) : -1;
      if (event.key === 'ArrowRight' && current?.id === 'sort-btn') {
        event.preventDefault();
        event.stopPropagation();
        current.click();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + step + items.length) % items.length;
        const next = items[nextIndex];
        if (next) focusMenuItem(menu, next);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        const item = event.key === 'Home' ? items[0] : items[items.length - 1];
        if (item) focusMenuItem(menu, item);
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
        event.preventDefault();
        event.stopPropagation();
        items[currentIndex]?.click();
      }
    });

    document.addEventListener('click', (event) => {
      if (menu.style.display !== 'block') return;
      const target = event.target as Node;
      const sortMenu = getElement('sort-menu');
      if (!button.contains(target) && !menu.contains(target) && !sortMenu?.contains(target)) {
        closeMenu();
      }
    });

    const selectionButton = getElement<HTMLButtonElement>('selection-overflow-btn');
    const selectionMenu = getElement('selection-overflow-menu');
    if (selectionButton && selectionMenu) {
      selectionMenu.addEventListener('click', () => closeMenu());
      selectionMenu.addEventListener('keydown', (event: KeyboardEvent) => {
        const items = Array.from(selectionMenu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .filter(isShown)
          .filter(
            (item) =>
              !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true'
          );
        if (items.length === 0) return;
        const activeIndex = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          selectionMenu.style.display = 'none';
          selectionButton.setAttribute('aria-expanded', 'false');
          selectionButton.focus({ preventScroll: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const next = items[(activeIndex + step + items.length) % items.length];
          next?.focus({ preventScroll: true });
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          event.stopPropagation();
          const target = event.key === 'Home' ? items[0] : items[items.length - 1];
          target?.focus({ preventScroll: true });
        }
      });
      selectionButton.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          selectionButton.click();
          selectionMenu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({
            preventScroll: true,
          });
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    }

    const movePriority = [...responsiveItems].sort((left, right) => left.priority - right.priority);

    const runReflow = () => {
      reflowFrame = 0;
      if (menu.style.display === 'block') {
        positionMenu(button, menu);
        return;
      }
      const toolbarWidth = toolbar.clientWidth;
      if (toolbarWidth <= 0) return;

      if (toolbar.scrollWidth > toolbar.clientWidth + 1) {
        for (const item of movePriority) {
          if (item.element.parentElement === overflowItems || !isShown(item.element)) continue;
          moveResponsiveNode(item, overflowItems);
          if (toolbar.scrollWidth <= toolbar.clientWidth + 1) break;
        }
      } else {
        const restorePriority = [...movePriority].reverse();
        for (const item of restorePriority) {
          if (item.element.parentElement !== overflowItems) continue;
          restoreNode(item);
          if (toolbar.scrollWidth > toolbar.clientWidth + 1) {
            moveResponsiveNode(item, overflowItems);
          }
        }
      }
      updateSections();
    };

    function scheduleReflow(): void {
      if (reflowFrame) cancelAnimationFrame(reflowFrame);
      reflowFrame = requestAnimationFrame(runReflow);
    }

    window.addEventListener('resize', scheduleReflow, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(scheduleReflow);
      observer.observe(toolbar);
    }
    if (typeof MutationObserver !== 'undefined') {
      bodyClassObserver = new MutationObserver(scheduleReflow);
      bodyClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      toolbarStateObserver = new MutationObserver(scheduleReflow);
      toolbarStateObserver.observe(toolbar, {
        attributes: true,
        attributeFilter: ['style'],
        subtree: true,
      });
    }
    updateSections();
    scheduleReflow();
  }

  function setup(): void {
    if (initialized) return;
    initialized = true;
    setupMoreActionsMenu();
  }

  function dispose(): void {
    observer?.disconnect();
    bodyClassObserver?.disconnect();
    toolbarStateObserver?.disconnect();
    if (reflowFrame) cancelAnimationFrame(reflowFrame);
  }

  return { setup, dispose };
}
