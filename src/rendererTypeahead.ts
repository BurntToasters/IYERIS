import { getById } from './rendererDom.js';
import { TYPEAHEAD_RESET_MS } from './rendererLocalConstants.js';

type TypeaheadDeps = {
  getFileItems: () => HTMLElement[];
  clearSelection: () => void;
  getSelectedItems: () => Set<string>;
  updateStatusBar: () => void;
  selectSingleItem?: (item: HTMLElement) => void;
};

export function createTypeaheadController(deps: TypeaheadDeps) {
  let typeaheadBuffer = '';
  let typeaheadTimeout: NodeJS.Timeout | null = null;
  let typeaheadIndicator: HTMLElement | null = null;

  const ensureIndicator = () => {
    if (!typeaheadIndicator) typeaheadIndicator = getById('typeahead-indicator');
  };

  const showIndicator = (text: string) => {
    ensureIndicator();
    if (!typeaheadIndicator) return;
    typeaheadIndicator.textContent = text;
    typeaheadIndicator.style.display = 'block';
  };

  const hideIndicator = () => {
    ensureIndicator();
    if (!typeaheadIndicator) return;
    typeaheadIndicator.style.display = 'none';
    typeaheadIndicator.textContent = '';
  };

  function reset(): void {
    if (typeaheadTimeout) {
      clearTimeout(typeaheadTimeout);
      typeaheadTimeout = null;
    }
    typeaheadBuffer = '';
    hideIndicator();
  }

  function handleInput(char: string): void {
    const loweredChar = char.toLowerCase();
    const cycleSingleLetter =
      typeaheadBuffer.length === 1 && typeaheadBuffer.toLowerCase() === loweredChar;
    if (!cycleSingleLetter) {
      typeaheadBuffer += char;
    }
    showIndicator(typeaheadBuffer);

    if (typeaheadTimeout) {
      clearTimeout(typeaheadTimeout);
    }
    typeaheadTimeout = setTimeout(() => {
      typeaheadBuffer = '';
      hideIndicator();
      typeaheadTimeout = null;
    }, TYPEAHEAD_RESET_MS);

    const needle = typeaheadBuffer.toLowerCase();
    const items = deps.getFileItems();
    const startsWithNeedle = (item: HTMLElement) => {
      const nameEl = item.querySelector('.file-name');
      const text = nameEl?.textContent?.toLowerCase() || '';
      return text.startsWith(needle);
    };
    const candidates = items.filter(startsWithNeedle);
    if (candidates.length === 0) return;

    let match = candidates[0]!;
    if (cycleSingleLetter && candidates.length > 1) {
      const selectedPath = Array.from(deps.getSelectedItems())[0];
      const currentIndex = candidates.findIndex(
        (item) => item.getAttribute('data-path') === selectedPath
      );
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % candidates.length : 0;
      match = candidates[nextIndex]!;
    }

    if (match) {
      if (deps.selectSingleItem) {
        deps.selectSingleItem(match);
      } else {
        deps.clearSelection();
        match.classList.add('selected');
        match.setAttribute('aria-selected', 'true');
        const itemPath = match.getAttribute('data-path');
        if (itemPath) {
          deps.getSelectedItems().add(itemPath);
        }
        const active = document.querySelector<HTMLElement>('.file-item[tabindex="0"]');
        if (active && active !== match) {
          active.tabIndex = -1;
        }
        match.tabIndex = 0;
        match.focus({ preventScroll: true });
        match.scrollIntoView({ block: 'nearest' });
        deps.updateStatusBar();
      }
    }
  }

  return { handleInput, reset };
}
