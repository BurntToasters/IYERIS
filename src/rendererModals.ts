import { twemojiImg } from './rendererUtils.js';

export type DialogType = 'info' | 'warning' | 'error' | 'success' | 'question';

const MODAL_FOCUS_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let activeModal: HTMLElement | null = null;
let modalRestoreFocusEl: HTMLElement | null = null;

function getFocusableElements(modal: HTMLElement): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>(MODAL_FOCUS_SELECTORS)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
  );
}

function trapModalFocus(e: KeyboardEvent): void {
  if (!activeModal || e.key !== 'Tab') return;
  const focusable = getFocusableElements(activeModal);
  if (focusable.length === 0) {
    e.preventDefault();
    activeModal.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
}

export function activateModal(modal: HTMLElement, options?: { restoreFocus?: boolean }) {
  if (activeModal && activeModal !== modal) {
    deactivateModal(activeModal, { restoreFocus: false });
  }
  activeModal = modal;
  if (options?.restoreFocus !== false) {
    modalRestoreFocusEl = document.activeElement as HTMLElement | null;
  }
  if (!modal.hasAttribute('tabindex')) {
    modal.tabIndex = -1;
  }
  document.addEventListener('keydown', trapModalFocus, true);
  const focusable = getFocusableElements(modal);
  if (focusable.length > 0) {
    focusable[0].focus({ preventScroll: true });
  } else {
    modal.focus({ preventScroll: true });
  }
}

export function deactivateModal(modal?: HTMLElement, options?: { restoreFocus?: boolean }) {
  if (modal && activeModal !== modal) return;
  document.removeEventListener('keydown', trapModalFocus, true);
  activeModal = null;
  const shouldRestore = options?.restoreFocus !== false;
  if (shouldRestore && modalRestoreFocusEl && document.contains(modalRestoreFocusEl)) {
    modalRestoreFocusEl.focus({ preventScroll: true });
  }
  modalRestoreFocusEl = null;
}

export function showDialog(
  title: string,
  message: string,
  type: DialogType = 'info',
  showCancel: boolean = false
): Promise<boolean> {
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

    const icons: Record<DialogType, string> = {
      info: '2139',
      warning: '26a0',
      error: '274c',
      success: '2705',
      question: '2753',
    };

    dialogIcon.innerHTML = twemojiImg(
      String.fromCodePoint(parseInt(icons[type] || icons.info, 16)),
      'twemoji'
    );
    dialogTitle.textContent = title;
    dialogContent.textContent = message;

    if (showCancel) {
      dialogCancel.style.display = 'block';
    } else {
      dialogCancel.style.display = 'none';
    }

    dialogModal.style.display = 'flex';
    activateModal(dialogModal);
    dialogOk.focus();

    let resolved = false;

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !resolved) {
        resolved = true;
        dialogModal.style.display = 'none';
        deactivateModal(dialogModal);
        cleanup();
        resolve(false);
      }
    };

    const cleanup = (): void => {
      dialogOk.onclick = null;
      dialogCancel.onclick = null;
      document.removeEventListener('keydown', handleEscape);
    };

    dialogOk.onclick = () => {
      if (resolved) return;
      resolved = true;
      dialogModal.style.display = 'none';
      deactivateModal(dialogModal);
      cleanup();
      resolve(true);
    };

    dialogCancel.onclick = () => {
      if (resolved) return;
      resolved = true;
      dialogModal.style.display = 'none';
      deactivateModal(dialogModal);
      cleanup();
      resolve(false);
    };

    document.addEventListener('keydown', handleEscape);
  });
}

export async function showAlert(
  message: string,
  title: string = 'IYERIS',
  type: DialogType = 'info'
): Promise<void> {
  await showDialog(title, message, type, false);
}

export async function showConfirm(
  message: string,
  title: string = 'Confirm',
  type: DialogType = 'question'
): Promise<boolean> {
  return await showDialog(title, message, type, true);
}
