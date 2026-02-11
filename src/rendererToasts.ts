import { escapeHtml } from './shared.js';

type ToastType = 'success' | 'error' | 'info' | 'warning';

type ToastOptions = {
  durationMs: number;
  maxVisible: number;
  getContainer: () => HTMLElement | null;
  twemojiImg: (emoji: string, className?: string) => string;
};

export function createToastManager(options: ToastOptions) {
  const toastQueue: Array<{ message: string; title: string; type: ToastType }> = [];
  let visibleToastCount = 0;

  const processToastQueue = () => {
    if (toastQueue.length > 0 && visibleToastCount < options.maxVisible) {
      const next = toastQueue.shift();
      if (next) {
        showToastQueued(next.message, next.title, next.type);
      }
    }
  };

  const showToastQueued = (message: string, title: string = '', type: ToastType = 'info'): void => {
    if (visibleToastCount >= options.maxVisible) {
      toastQueue.push({ message, title, type });
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
    setTimeout(removeToast, options.durationMs);
  };

  const showToast = (message: string, title: string = '', type: ToastType = 'info'): void => {
    showToastQueued(message, title, type);
  };

  return { showToast };
}
