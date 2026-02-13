// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../rendererUtils.js', () => ({
  twemojiImg: (emoji: string, cls: string) => `<img class="${cls}" alt="${emoji}">`,
}));

import {
  activateModal,
  deactivateModal,
  showDialog,
  showAlert,
  showConfirm,
} from '../rendererModals.js';

function makeFocusable(el: HTMLElement) {
  Object.defineProperty(el, 'offsetParent', { get: () => document.body, configurable: true });
  return el;
}

describe('rendererModals', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    deactivateModal();
  });

  describe('activateModal', () => {
    it('sets tabindex and focuses first focusable element', () => {
      const modal = document.createElement('div');
      const btn = makeFocusable(document.createElement('button'));
      btn.textContent = 'OK';
      modal.appendChild(btn);
      document.body.appendChild(modal);

      activateModal(modal);
      expect(modal.tabIndex).toBe(-1);
      expect(document.activeElement).toBe(btn);
    });

    it('focuses the modal itself when no focusable children', () => {
      const modal = document.createElement('div');
      document.body.appendChild(modal);
      activateModal(modal);
      expect(document.activeElement).toBe(modal);
    });

    it('deactivates previous modal before activating new one', () => {
      const modal1 = document.createElement('div');
      const modal2 = document.createElement('div');
      const btn2 = makeFocusable(document.createElement('button'));
      modal2.appendChild(btn2);
      document.body.appendChild(modal1);
      document.body.appendChild(modal2);

      activateModal(modal1);
      activateModal(modal2);
      expect(document.activeElement).toBe(btn2);
    });

    it('restores focus on deactivate when restoreFocus not disabled', () => {
      const outer = makeFocusable(document.createElement('button'));
      outer.textContent = 'outer';
      document.body.appendChild(outer);
      outer.focus();

      const modal = document.createElement('div');
      const btn = makeFocusable(document.createElement('button'));
      modal.appendChild(btn);
      document.body.appendChild(modal);

      activateModal(modal);
      expect(document.activeElement).toBe(btn);

      deactivateModal(modal);
      expect(document.activeElement).toBe(outer);
    });

    it('does not restore focus when restoreFocus is false', () => {
      const outer = document.createElement('button');
      outer.textContent = 'outer';
      document.body.appendChild(outer);
      outer.focus();

      const modal = document.createElement('div');
      document.body.appendChild(modal);
      activateModal(modal, { restoreFocus: false });

      deactivateModal(modal, { restoreFocus: false });
    });
  });

  describe('deactivateModal', () => {
    it('does nothing if passed a different modal', () => {
      const modal1 = document.createElement('div');
      const modal2 = document.createElement('div');
      document.body.appendChild(modal1);
      document.body.appendChild(modal2);

      activateModal(modal1);
      deactivateModal(modal2);
    });

    it('works with no argument', () => {
      deactivateModal();
    });
  });

  describe('trapModalFocus', () => {
    it('wraps focus from last to first on Tab', () => {
      const modal = document.createElement('div');
      const btn1 = makeFocusable(document.createElement('button'));
      btn1.textContent = 'first';
      const btn2 = makeFocusable(document.createElement('button'));
      btn2.textContent = 'last';
      modal.appendChild(btn1);
      modal.appendChild(btn2);
      document.body.appendChild(modal);

      activateModal(modal);
      btn2.focus();

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tabEvent);

      expect(document.activeElement).toBe(btn1);
    });

    it('wraps focus from first to last on Shift+Tab', () => {
      const modal = document.createElement('div');
      const btn1 = makeFocusable(document.createElement('button'));
      btn1.textContent = 'first';
      const btn2 = makeFocusable(document.createElement('button'));
      btn2.textContent = 'last';
      modal.appendChild(btn1);
      modal.appendChild(btn2);
      document.body.appendChild(modal);

      activateModal(modal);
      btn1.focus();

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tabEvent);

      expect(document.activeElement).toBe(btn2);
    });

    it('focuses modal when no focusable elements on Tab', () => {
      const modal = document.createElement('div');
      document.body.appendChild(modal);
      activateModal(modal);

      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tabEvent);

      expect(document.activeElement).toBe(modal);
    });

    it('ignores non-Tab keys', () => {
      const modal = document.createElement('div');
      const btn = makeFocusable(document.createElement('button'));
      modal.appendChild(btn);
      document.body.appendChild(modal);
      activateModal(modal);
      btn.focus();

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(enterEvent);
      expect(document.activeElement).toBe(btn);
    });
  });

  describe('showDialog', () => {
    function setupDialogDom() {
      document.body.innerHTML = `
        <div id="dialog-modal" style="display:none">
          <span id="dialog-icon"></span>
          <span id="dialog-title"></span>
          <span id="dialog-content"></span>
          <button id="dialog-ok">OK</button>
          <button id="dialog-cancel" style="display:none">Cancel</button>
        </div>
      `;

      makeFocusable(document.getElementById('dialog-ok') as HTMLElement);
      makeFocusable(document.getElementById('dialog-cancel') as HTMLElement);
    }

    it('shows dialog and resolves true on OK click', async () => {
      setupDialogDom();
      const promise = showDialog('Title', 'Message', 'info', false);
      const ok = document.getElementById('dialog-ok') as HTMLButtonElement;
      ok.click();
      const result = await promise;
      expect(result).toBe(true);
      expect((document.getElementById('dialog-modal') as HTMLElement).style.display).toBe('none');
    });

    it('resolves false on Cancel click', async () => {
      setupDialogDom();
      const promise = showDialog('Title', 'Are you sure?', 'question', true);
      const cancel = document.getElementById('dialog-cancel') as HTMLButtonElement;
      expect(cancel.style.display).toBe('block');
      cancel.click();
      const result = await promise;
      expect(result).toBe(false);
    });

    it('resolves false on Escape', async () => {
      setupDialogDom();
      const promise = showDialog('Title', 'Message', 'warning');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const result = await promise;
      expect(result).toBe(false);
    });

    it('sets title, content, and icon', async () => {
      setupDialogDom();
      const promise = showDialog('MyTitle', 'MyMessage', 'error');
      expect(document.getElementById('dialog-title')!.textContent).toBe('MyTitle');
      expect(document.getElementById('dialog-content')!.textContent).toBe('MyMessage');
      expect(document.getElementById('dialog-icon')!.innerHTML).toContain('<img');
      const ok = document.getElementById('dialog-ok') as HTMLButtonElement;
      ok.click();
      await promise;
    });

    it('only resolves once even if OK clicked multiple times', async () => {
      setupDialogDom();
      const promise = showDialog('Title', 'Msg');
      const ok = document.getElementById('dialog-ok') as HTMLButtonElement;
      ok.click();
      ok.click();
      const result = await promise;
      expect(result).toBe(true);
    });

    it('uses all dialog types', async () => {
      for (const type of ['info', 'warning', 'error', 'success', 'question'] as const) {
        setupDialogDom();
        const promise = showDialog('T', 'M', type);
        document.getElementById('dialog-ok')!.click();
        await promise;
      }
    });

    it('hides cancel button when showCancel is false', async () => {
      setupDialogDom();
      const promise = showDialog('Title', 'Msg', 'info', false);
      expect(document.getElementById('dialog-cancel')!.style.display).toBe('none');
      document.getElementById('dialog-ok')!.click();
      await promise;
    });
  });

  describe('showAlert', () => {
    it('wraps showDialog with defaults', async () => {
      document.body.innerHTML = `
        <div id="dialog-modal" style="display:none">
          <span id="dialog-icon"></span>
          <span id="dialog-title"></span>
          <span id="dialog-content"></span>
          <button id="dialog-ok">OK</button>
          <button id="dialog-cancel" style="display:none">Cancel</button>
        </div>
      `;
      makeFocusable(document.getElementById('dialog-ok') as HTMLElement);
      makeFocusable(document.getElementById('dialog-cancel') as HTMLElement);
      const promise = showAlert('Hello');
      expect(document.getElementById('dialog-title')!.textContent).toBe('IYERIS');
      document.getElementById('dialog-ok')!.click();
      await promise;
    });
  });

  describe('showConfirm', () => {
    it('wraps showDialog with cancel visible', async () => {
      document.body.innerHTML = `
        <div id="dialog-modal" style="display:none">
          <span id="dialog-icon"></span>
          <span id="dialog-title"></span>
          <span id="dialog-content"></span>
          <button id="dialog-ok">OK</button>
          <button id="dialog-cancel" style="display:none">Cancel</button>
        </div>
      `;
      makeFocusable(document.getElementById('dialog-ok') as HTMLElement);
      makeFocusable(document.getElementById('dialog-cancel') as HTMLElement);
      const promise = showConfirm('Really?');
      expect(document.getElementById('dialog-cancel')!.style.display).toBe('block');
      document.getElementById('dialog-cancel')!.click();
      const result = await promise;
      expect(result).toBe(false);
    });

    it('returns true when OK clicked', async () => {
      document.body.innerHTML = `
        <div id="dialog-modal" style="display:none">
          <span id="dialog-icon"></span>
          <span id="dialog-title"></span>
          <span id="dialog-content"></span>
          <button id="dialog-ok">OK</button>
          <button id="dialog-cancel" style="display:none">Cancel</button>
        </div>
      `;
      makeFocusable(document.getElementById('dialog-ok') as HTMLElement);
      makeFocusable(document.getElementById('dialog-cancel') as HTMLElement);
      const promise = showConfirm('Sure?', 'Title', 'warning');
      document.getElementById('dialog-ok')!.click();
      expect(await promise).toBe(true);
    });
  });
});
