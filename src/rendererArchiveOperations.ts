import { clearHtml, getById } from './rendererDom.js';
import { escapeHtml } from './shared.js';

type ArchiveOperationType = 'compress' | 'extract';

interface ArchiveOperation {
  id: string;
  type: ArchiveOperationType;
  name: string;
  current: number;
  total: number;
  currentFile: string;
  aborted: boolean;
}

interface ArchiveOperationsDeps {
  cancelArchiveOperation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
}

export function createArchiveOperationsController(deps: ArchiveOperationsDeps) {
  const activeOperations = new Map<string, ArchiveOperation>();
  let renderOperationsTimeout: ReturnType<typeof setTimeout> | null = null;
  let archiveOperationsPanelListenerInitialized = false;

  function initArchiveOperationsPanelListener(): void {
    if (archiveOperationsPanelListenerInitialized) return;

    const list = document.getElementById('archive-operations-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('archive-operation-cancel')) {
          const operationId = target.getAttribute('data-id');
          if (operationId) {
            abortOperation(operationId);
          }
        }
      });
      archiveOperationsPanelListenerInitialized = true;
    }
  }

  function generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  function showOperationsPanel() {
    const panel = document.getElementById('archive-operations-panel');
    if (panel && activeOperations.size > 0) {
      panel.style.display = 'block';
    }
  }

  function hideOperationsPanel() {
    const panel = document.getElementById('archive-operations-panel');
    if (panel && activeOperations.size === 0) {
      panel.style.display = 'none';
    }
  }

  function addOperation(id: string, type: ArchiveOperationType, name: string) {
    const operation: ArchiveOperation = {
      id,
      type,
      name,
      current: 0,
      total: 0,
      currentFile: 'Preparing...',
      aborted: false,
    };

    activeOperations.set(id, operation);
    renderOperations();
    showOperationsPanel();
  }

  function updateOperation(id: string, current: number, total: number, currentFile: string) {
    const operation = activeOperations.get(id);
    if (operation && !operation.aborted) {
      operation.current = current;
      operation.total = total;
      operation.currentFile = currentFile;
      if (renderOperationsTimeout) clearTimeout(renderOperationsTimeout);
      renderOperationsTimeout = setTimeout(renderOperations, 50);
    }
  }

  function removeOperation(id: string) {
    activeOperations.delete(id);
    renderOperations();
    hideOperationsPanel();
  }

  function getOperation(id: string) {
    return activeOperations.get(id);
  }

  function abortOperation(id: string) {
    const operation = activeOperations.get(id);
    if (operation) {
      operation.aborted = true;
      operation.currentFile = 'Cancelling...';
      renderOperations();

      deps
        .cancelArchiveOperation(id)
        .then((result) => {
          if (!result.success) {
            console.error('[Archive] Failed to cancel:', result.error);
          }
        })
        .catch((err) => {
          console.error('[Archive] Error cancelling operation:', err);
        });

      setTimeout(() => {
        removeOperation(id);
      }, 1500);
    }
  }

  function renderOperations() {
    const list = getById('archive-operations-list');
    if (!list) return;

    initArchiveOperationsPanelListener();

    clearHtml(list);

    for (const [id, operation] of activeOperations) {
      const item = document.createElement('div');
      item.className = 'archive-operation-item';

      const icon = operation.type === 'compress' ? '1f5dc' : '1f4e6';
      const iconEmoji = operation.type === 'compress' ? '🗜️' : '📦';
      const title = operation.type === 'compress' ? 'Compressing' : 'Extracting';

      const percent =
        operation.total > 0 ? Math.round((operation.current / operation.total) * 100) : 0;

      item.innerHTML = `
      <div class="archive-operation-header">
        <div class="archive-operation-title">
          <img src="../assets/twemoji/${icon}.svg" class="twemoji" alt="${iconEmoji}" draggable="false" />
          <span class="archive-operation-name" title="${escapeHtml(operation.name)}">${title}: ${escapeHtml(operation.name)}</span>
        </div>
        ${!operation.aborted ? `<button class="archive-operation-cancel" data-id="${escapeHtml(id)}">Cancel</button>` : ''}
      </div>
      <div class="archive-operation-file">${escapeHtml(operation.currentFile)}</div>
      <div class="archive-operation-stats">${operation.current} / ${operation.total} files</div>
      <div class="archive-progress-bar-container">
        <div class="archive-progress-bar" style="width: ${percent}%"></div>
      </div>
    `;

      list.appendChild(item);
    }
  }

  function cleanup(): void {
    if (renderOperationsTimeout) {
      clearTimeout(renderOperationsTimeout);
      renderOperationsTimeout = null;
    }
  }

  return {
    generateOperationId,
    addOperation,
    updateOperation,
    removeOperation,
    getOperation,
    abortOperation,
    cleanup,
  };
}
