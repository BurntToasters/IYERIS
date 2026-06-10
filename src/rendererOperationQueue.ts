import type { OperationKind, OperationQueueItem, OperationStatus } from './types';
import { clearHtml, getById } from './rendererDom.js';
import { devLog, escapeHtml } from './shared.js';
import { renderIcon } from './rendererUtils.js';

type QueueUpdate = {
  status?: OperationStatus;
  current?: number;
  total?: number;
  currentFile?: string;
  error?: string;
};

type QueueDeps = {
  cancelArchiveOperation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  cancelChecksumCalculation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  cancelFileOperation?: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  getOperationPanelCollapsed: () => boolean;
  setOperationPanelCollapsed: (collapsed: boolean) => void;
};

const COMPLETE_REMOVE_DELAY_MS = 4000;

function iconForKind(kind: OperationKind): string {
  return (
    {
      copy: 'file',
      move: 'upload',
      delete: 'trash-2',
      duplicate: 'copy',
      compress: 'folder-archive',
      extract: 'package',
      checksum: 'hash',
    } satisfies Record<OperationKind, string>
  )[kind];
}

function titleForKind(kind: OperationKind): string {
  return (
    {
      copy: 'Copying',
      move: 'Moving',
      delete: 'Deleting',
      duplicate: 'Duplicating',
      compress: 'Compressing',
      extract: 'Extracting',
      checksum: 'Calculating checksum',
    } satisfies Record<OperationKind, string>
  )[kind];
}

export function createOperationQueueController(deps: QueueDeps) {
  const operations = new Map<string, OperationQueueItem>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let listenerInitialized = false;
  let renderQueued = false;

  function generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  function ensureListener(): void {
    if (listenerInitialized) return;
    listenerInitialized = true;
    document.getElementById('progress-panel-close')?.addEventListener('click', () => {
      deps.setOperationPanelCollapsed(true);
      render();
    });
    document.getElementById('progress-panel-content')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const cancelButton = target.closest<HTMLButtonElement>('.operation-queue-cancel');
      const retryButton = target.closest<HTMLButtonElement>('.operation-queue-retry');
      if (cancelButton) {
        const id = cancelButton.dataset.id;
        if (id) cancelOperation(id);
        return;
      }
      if (retryButton) {
        const id = retryButton.dataset.id;
        if (id) retryOperation(id);
      }
    });
  }

  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function showPanel(): void {
    deps.setOperationPanelCollapsed(false);
    const panel = document.getElementById('progress-panel');
    if (panel) panel.style.display = 'flex';
  }

  function hidePanelIfEmpty(): void {
    const panel = document.getElementById('progress-panel');
    if (panel && operations.size === 0) panel.style.display = 'none';
  }

  function addOperation(
    id: string,
    kind: OperationKind,
    name: string,
    options: { cancellable?: boolean; total?: number; retry?: () => void } = {}
  ): void {
    if (timers.has(id)) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
    operations.set(id, {
      id,
      kind,
      name,
      status: 'active',
      current: 0,
      total: options.total ?? 0,
      currentFile: 'Preparing...',
      cancellable: options.cancellable ?? false,
      retry: options.retry,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    showPanel();
    scheduleRender();
  }

  function updateOperation(id: string, update: QueueUpdate): void {
    const operation = operations.get(id);
    if (!operation) return;
    Object.assign(operation, update, { updatedAt: Date.now() });
    scheduleRender();
  }

  function completeOperation(
    id: string,
    status: Extract<OperationStatus, 'done' | 'failed'>,
    error?: string
  ): void {
    const operation = operations.get(id);
    if (!operation) return;
    operation.status = status;
    operation.current = operation.total > 0 ? operation.total : operation.current;
    operation.error = error;
    operation.updatedAt = Date.now();
    const elapsedMs = operation.updatedAt - operation.createdAt;
    if (status === 'failed') {
      devLog('OperationQueue', `${operation.kind} failed`, {
        id,
        name: operation.name,
        elapsedMs,
        error: error || 'unknown',
      });
    } else if (elapsedMs >= 5000) {
      devLog('OperationQueue', `${operation.kind} completed`, {
        id,
        name: operation.name,
        elapsedMs,
      });
    }
    if (timers.has(id)) clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        operations.delete(id);
        timers.delete(id);
        render();
        hidePanelIfEmpty();
      }, COMPLETE_REMOVE_DELAY_MS)
    );
    scheduleRender();
  }

  function removeOperation(id: string): void {
    if (timers.has(id)) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
    operations.delete(id);
    scheduleRender();
    hidePanelIfEmpty();
  }

  function getOperation(id: string): OperationQueueItem | undefined {
    return operations.get(id);
  }

  function cancelOperation(id: string): void {
    const operation = operations.get(id);
    if (!operation || !operation.cancellable || operation.status === 'cancelling') return;
    operation.status = 'cancelling';
    operation.currentFile = 'Cancelling...';
    operation.updatedAt = Date.now();
    scheduleRender();
    if (operation.kind === 'delete') return;
    const cancel =
      operation.kind === 'checksum'
        ? deps.cancelChecksumCalculation(id)
        : operation.kind === 'compress' || operation.kind === 'extract'
          ? deps.cancelArchiveOperation(id)
          : (deps.cancelFileOperation?.(id) ??
            Promise.resolve({
              success: false,
              error: 'Cancel is not available for this operation',
            }));
    cancel
      .then((result) => {
        if (!result.success) {
          completeOperation(id, 'failed', result.error || 'Cancel failed');
          return;
        }
        completeOperation(id, 'failed', 'Cancelled');
      })
      .catch((error) => {
        completeOperation(id, 'failed', String(error));
      });
  }

  function retryOperation(id: string): void {
    const operation = operations.get(id);
    if (!operation || operation.status !== 'failed' || !operation.retry) return;
    const retry = operation.retry;
    removeOperation(id);
    retry();
  }

  function isOperationCancelling(id: string): boolean {
    return operations.get(id)?.status === 'cancelling';
  }

  function formatEta(operation: OperationQueueItem): string {
    if (operation.status !== 'active' || operation.current <= 0 || operation.total <= 0) return '';
    if (operation.current >= operation.total) return '';
    const elapsedMs = Date.now() - operation.createdAt;
    if (elapsedMs < 1000) return '';
    const remaining = operation.total - operation.current;
    const msPerItem = elapsedMs / operation.current;
    const etaSeconds = Math.max(1, Math.round((remaining * msPerItem) / 1000));
    if (etaSeconds < 60) return `ETA ${etaSeconds}s`;
    const minutes = Math.floor(etaSeconds / 60);
    const seconds = etaSeconds % 60;
    return `ETA ${minutes}m ${seconds}s`;
  }

  function bindFileOperationProgress(): () => void {
    return window.tauriAPI.onFileOperationProgress((progress) => {
      const id = progress.operationId || `file-${progress.operation}`;
      if (!operations.has(id)) {
        addOperation(
          id,
          progress.operation,
          progress.operation === 'copy' ? 'Copy items' : 'Move items',
          {
            total: progress.total,
          }
        );
      }
      updateOperation(id, {
        status: 'active',
        current: progress.current,
        total: progress.total,
        currentFile: progress.name,
      });
      if (progress.total > 0 && progress.current >= progress.total) {
        completeOperation(id, 'done');
      }
    });
  }

  function render(): void {
    ensureListener();
    const panel = document.getElementById('progress-panel');
    const content = getById('progress-panel-content');
    if (!panel || !content) return;

    const collapsed = deps.getOperationPanelCollapsed();
    panel.classList.toggle('is-collapsed', collapsed);
    if (operations.size === 0) {
      panel.style.display = 'none';
      clearHtml(content);
      return;
    }
    panel.style.display = 'flex';
    if (collapsed) {
      content.innerHTML = '';
      return;
    }

    const items = Array.from(operations.values()).sort((a, b) => a.createdAt - b.createdAt);
    clearHtml(content);
    for (const operation of items) {
      const percent =
        operation.total > 0
          ? Math.min(100, Math.round((operation.current / operation.total) * 100))
          : 0;
      const statusLabel =
        operation.status === 'done'
          ? 'Done'
          : operation.status === 'failed'
            ? 'Failed'
            : operation.status === 'cancelling'
              ? 'Cancelling'
              : [
                  operation.total > 0 ? `${operation.current} / ${operation.total}` : 'Working',
                  formatEta(operation),
                ]
                  .filter(Boolean)
                  .join(' • ');
      const card = document.createElement('div');
      card.className = `operation-queue-item is-${operation.status}`;
      // eslint-disable-next-line no-restricted-syntax -- user data via escapeHtml(); icons/numerics are safe
      card.innerHTML = `
        <div class="operation-queue-header">
          <div class="operation-queue-title">
            ${renderIcon(iconForKind(operation.kind), 'twemoji')}
            <span>${escapeHtml(titleForKind(operation.kind))}</span>
          </div>
          <span class="operation-queue-status">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="operation-queue-name" title="${escapeHtml(operation.name)}">${escapeHtml(operation.name)}</div>
        <div class="operation-queue-file">${escapeHtml(operation.error || operation.currentFile || '')}</div>
        <div class="operation-queue-progress" aria-hidden="true">
          <div class="operation-queue-progress-fill" style="width:${percent}%"></div>
        </div>
        ${
          operation.cancellable && operation.status === 'active'
            ? `<button class="operation-queue-cancel" data-id="${escapeHtml(operation.id)}" type="button">Cancel</button>`
            : ''
        }
        ${
          operation.retry && operation.status === 'failed'
            ? `<button class="operation-queue-retry" data-id="${escapeHtml(operation.id)}" type="button">Retry</button>`
            : ''
        }
      `;
      content.appendChild(card);
    }
  }

  function cleanup(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    generateOperationId,
    addOperation,
    updateOperation,
    completeOperation,
    removeOperation,
    getOperation,
    isOperationCancelling,
    bindFileOperationProgress,
    cleanup,
  };
}
