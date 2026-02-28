import { escapeHtml } from './shared.js';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

type ToastOptions = {
  durationMs: number;
  maxVisible: number;
  getContainer: () => HTMLElement | null;
  twemojiImg: (emoji: string, className?: string) => string;
};

export function createToastManager(options: ToastOptions) {
  const toastQueue: Array<{
    message: string;
    title: string;
    type: ToastType;
    actions?: ToastAction[];
  }> = [];
  let visibleToastCount = 0;

  const processToastQueue = () => {
    if (toastQueue.length > 0 && visibleToastCount < options.maxVisible) {
      const next = toastQueue.shift();
      if (next) {
        showToastQueued(next.message, next.title, next.type, next.actions);
      }
    }
  };

  const showToastQueued = (
    message: string,
    title: string = '',
    type: ToastType = 'info',
    actions?: ToastAction[]
  ): void => {
    if (visibleToastCount >= options.maxVisible) {
      toastQueue.push({ message, title, type, actions });
      return;
    }

    visibleToastCount++;
    const container = options.getContainer();
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.cursor = 'pointer';
    toast.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');

    const icons: Record<string, string> = {
      success: '2705',
      error: '274c',
      info: '2139',
      warning: '26a0',
    };

    toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${options.twemojiImg(String.fromCodePoint(parseInt(icons[type], 16)), 'twemoji')}</span>
    <div class="toast-content">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
  `;

    if (actions && actions.length > 0) {
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'toast-actions';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.className = 'toast-action-btn';
        btn.textContent = action.label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          action.onClick();
          removeToast();
        });
        actionsContainer.appendChild(btn);
      }
      toast.appendChild(actionsContainer);
    }

    container.appendChild(toast);

    let removed = false;
    const removeToast = () => {
      if (removed) return;
      removed = true;
      toast.classList.add('removing');
      setTimeout(() => {
        if (container.contains(toast)) {
          container.removeChild(toast);
        }
        visibleToastCount--;
        processToastQueue();
      }, 300);
    };

    toast.addEventListener('click', removeToast);
    const duration = actions && actions.length > 0 ? options.durationMs * 2 : options.durationMs;
    setTimeout(removeToast, duration);
  };

  const showToast = (
    message: string,
    title: string = '',
    type: ToastType = 'info',
    actions?: ToastAction[]
  ): void => {
    showToastQueued(message, title, type, actions);
  };

  return { showToast };
}
