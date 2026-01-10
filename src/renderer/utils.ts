import { escapeHtml } from '../shared.js';
import { DialogType } from '../types';

export function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
  }
  return '0, 120, 212';
}

export function emojiToCodepoint(emoji: string): string {
  const codePoints: number[] = [];
  let i = 0;
  while (i < emoji.length) {
    const code = emoji.codePointAt(i);
    if (code !== undefined) {
      if (code !== 0xFE0F) {
        codePoints.push(code);
      }
      i += code > 0xFFFF ? 2 : 1;
    } else {
      i++;
    }
  }
  return codePoints.map(cp => cp.toString(16)).join('-');
}

export function twemojiImg(emoji: string, className: string = 'twemoji', alt?: string): string {
  const codepoint = emojiToCodepoint(emoji);
  const src = `assets/twemoji/${codepoint}.svg`;
  const altText = escapeHtml(alt || emoji);
  return `<img src="${src}" class="${className}" alt="${altText}" draggable="false" />`;
}

export function showDialog(title: string, message: string, type: DialogType = 'info', showCancel: boolean = false): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    const dialogModal = document.getElementById('dialog-modal') as HTMLElement;
    const dialogTitle = document.getElementById('dialog-title') as HTMLElement;
    const dialogContent = document.getElementById('dialog-content') as HTMLElement;
    const dialogIcon = document.getElementById('dialog-icon') as HTMLElement;
    const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement;
    const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;

    if (!dialogModal || !dialogTitle || !dialogContent || !dialogIcon || !dialogOk || !dialogCancel) {
      console.error('Dialog elements not found');
      resolve(false);
      return;
    }

    const icons: Record<DialogType, string> = {
      info: '2139',
      warning: '26a0',
      error: '274c',
      success: '2705',
      question: '2753'
    };

    dialogIcon.innerHTML = twemojiImg(String.fromCodePoint(parseInt(icons[type] || icons.info, 16)), 'twemoji');
    dialogTitle.textContent = title;
    dialogContent.textContent = message;
    
    if (showCancel) {
      dialogCancel.style.display = 'block';
    } else {
      dialogCancel.style.display = 'none';
    }

    dialogModal.style.display = 'flex';

    // Store handlers to remove them later
    const handleOk = (): void => {
      dialogModal.style.display = 'none';
      cleanup();
      resolve(true);
    };

    const handleCancel = (): void => {
      dialogModal.style.display = 'none';
      cleanup();
      resolve(false);
    };

    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (showCancel) handleCancel();
        else handleOk();
      } else if (e.key === 'Enter') {
        handleOk();
      }
    };

    const cleanup = (): void => {
      dialogOk.removeEventListener('click', handleOk);
      dialogCancel.removeEventListener('click', handleCancel);
      window.removeEventListener('keydown', handleKey);
    };

    dialogOk.addEventListener('click', handleOk);
    dialogCancel.addEventListener('click', handleCancel);
    window.addEventListener('keydown', handleKey);
    
    dialogOk.focus();
  });
}

export async function showToast(message: string, title: string = '', type: 'success' | 'error' | 'info' | 'warning' = 'info'): Promise<void> {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.style.cursor = 'pointer';
  
  const icons: Record<string, string> = {
    success: '2705',
    error: '274c',
    info: '2139',
    warning: '26a0'
  };

  toast.innerHTML = `
    <div class="toast-icon">${twemojiImg(String.fromCodePoint(parseInt(icons[type] || icons.info, 16)), 'twemoji')}</div>
    <div class="toast-content">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <div class="toast-close">✕</div>
  `;

  const removeToast = () => {
    toast.style.animation = 'slideOut 0.3s ease forwards';
    setTimeout(() => {
      if (container.contains(toast)) {
        container.removeChild(toast);
      }
    }, 300);
  };

  const timeout = setTimeout(removeToast, 3000);

  toast.addEventListener('click', () => {
    clearTimeout(timeout);
    removeToast();
  });

  container.appendChild(toast);
}
