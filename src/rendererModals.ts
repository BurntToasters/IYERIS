import { twemojiImg } from './rendererUtils.js';

export type DialogType = 'info' | 'warning' | 'error' | 'success' | 'question';

const MODAL_FOCUS_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';
let activeModal: HTMLElement | null = null;
let modalFocusTrapInstalled = false;

type ModalStackEntry = {
  modal: HTMLElement;
  restoreFocusEl: HTMLElement | null;
};

const modalStack: ModalStackEntry[] = [];

type DialogRequest = {
  title: string;
  message: string;
  type: DialogType;
  showCancel: boolean;
  resolve: (value: boolean) => void;
};

const dialogQueue: DialogRequest[] = [];
let dialogRequestActive = false;

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
  if (!first || !last) return;
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
  const existingIndex = modalStack.findIndex((entry) => entry.modal === modal);
  const existingEntry = existingIndex >= 0 ? modalStack[existingIndex] : undefined;
  if (existingIndex >= 0) {
    // A controller may re-open the same modal while an async operation is in
    // flight. Keep one stack entry so a later close cannot pop an older opener.
    modalStack.splice(existingIndex, 1);
  }

  const restoreFocusEl =
    existingEntry !== undefined
      ? existingEntry.restoreFocusEl
      : options?.restoreFocus === false || !(document.activeElement instanceof HTMLElement)
        ? null
        : (document.activeElement as HTMLElement);
  modalStack.push({ modal, restoreFocusEl });
  activeModal = modal;
  if (!modal.hasAttribute('tabindex')) {
    modal.tabIndex = -1;
  }
  if (!modalFocusTrapInstalled) {
    document.addEventListener('keydown', trapModalFocus, true);
    modalFocusTrapInstalled = true;
  }
  const focusable = getFocusableElements(modal);
  if (focusable.length > 0) {
    focusable[0]!.focus({ preventScroll: true });
  } else {
    modal.focus({ preventScroll: true });
  }
}

export function deactivateModal(modal?: HTMLElement, options?: { restoreFocus?: boolean }) {
  const top = modalStack.at(-1);
  if (!top || (modal && top.modal !== modal)) return;
  modalStack.pop();
  const shouldRestore = options?.restoreFocus !== false;
  if (shouldRestore && top.restoreFocusEl && document.contains(top.restoreFocusEl)) {
    top.restoreFocusEl.focus({ preventScroll: true });
  }
  activeModal = modalStack.at(-1)?.modal ?? null;
  if (!activeModal && modalFocusTrapInstalled) {
    document.removeEventListener('keydown', trapModalFocus, true);
    modalFocusTrapInstalled = false;
  }
}

function showNextDialog(): void {
  if (dialogRequestActive) return;
  const request = dialogQueue.shift();
  if (!request) return;
  dialogRequestActive = true;

  const dialogModal = document.getElementById('dialog-modal') as HTMLElement | null;
  const dialogTitle = document.getElementById('dialog-title') as HTMLElement | null;
  const dialogContent = document.getElementById('dialog-content') as HTMLElement | null;
  const dialogIcon = document.getElementById('dialog-icon') as HTMLElement | null;
  const dialogOk = document.getElementById('dialog-ok') as HTMLButtonElement | null;
  const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement | null;

  if (!dialogModal || !dialogTitle || !dialogContent || !dialogIcon || !dialogOk || !dialogCancel) {
    dialogRequestActive = false;
    request.resolve(false);
    showNextDialog();
    return;
  }

  const icons: Record<DialogType, string> = {
    info: 'info',
    warning: 'alert-triangle',
    error: 'x',
    success: 'check-circle',
    question: 'help-circle',
  };

  dialogIcon.innerHTML = twemojiImg(icons[request.type] || icons.info, 'twemoji');
  dialogTitle.textContent = request.title;
  dialogContent.textContent = request.message;
  dialogCancel.style.display = request.showCancel ? 'block' : 'none';

  dialogModal.style.display = 'flex';
  activateModal(dialogModal);
  dialogOk.focus();

  let resolved = false;

  const settle = (value: boolean): void => {
    if (resolved) return;
    resolved = true;
    dialogModal.style.display = 'none';
    deactivateModal(dialogModal);
    cleanup();
    dialogRequestActive = false;
    request.resolve(value);
    showNextDialog();
  };

  const handleEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !resolved) {
      settle(false);
    }
  };

  const cleanup = (): void => {
    dialogOk.onclick = null;
    dialogCancel.onclick = null;
    document.removeEventListener('keydown', handleEscape);
  };

  dialogOk.onclick = () => {
    settle(true);
  };

  dialogCancel.onclick = () => {
    settle(false);
  };

  document.addEventListener('keydown', handleEscape);
}

export function showDialog(
  title: string,
  message: string,
  type: DialogType = 'info',
  showCancel: boolean = false
): Promise<boolean> {
  return new Promise((resolve) => {
    dialogQueue.push({ title, message, type, showCancel, resolve });
    showNextDialog();
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
