import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSupportUiController } from './rendererSupportUi.js';

type Deps = Parameters<typeof createSupportUiController>[0];
type ElectronApiMock = Pick<Window['electronAPI'], 'getLicenses'>;

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    activateModal: vi.fn(),
    deactivateModal: vi.fn(),
    escapeHtml: (v: string) => v,
    getErrorMessage: (e: unknown) => String(e),
    getCurrentSettings: () => ({}) as any,
    saveSettingsWithTimestamp: vi.fn(async () => ({ success: true })),
    openExternal: vi.fn(),
    ...overrides,
  };
}

describe('rendererSupportUi', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    const electronApiMock: ElectronApiMock = {
      getLicenses: vi.fn(async () => ({
        success: true,
        licenses: {
          'some-pkg': {
            licenses: 'MIT',
            repository: 'https://github.com/test/pkg',
            publisher: 'Test Author',
            licenseFile: 'LICENSE',
            licenseText: 'MIT License text here',
          },
        },
      })),
    };

    Object.defineProperty(window, 'electronAPI', {
      value: electronApiMock as Window['electronAPI'],
      configurable: true,
      writable: true,
    });
  });

  describe('getRepositoryText / normalizeRepositoryUrl / sanitizeExternalUrl', () => {
    it('handles string repository URLs', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'test-pkg': {
            licenses: 'MIT',
            repository: 'https://github.com/user/repo',
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
          <span id="total-deps"></span>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      const content = document.getElementById('licenses-content')!;
      expect(content.innerHTML).toContain('https://github.com/user/repo');
      expect(content.innerHTML).toContain('license-link');
    });

    it('handles object repository { url: string }', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'test-pkg': {
            licenses: 'ISC',
            repository: { url: 'git+https://github.com/user/repo2.git' },
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
          <span id="total-deps"></span>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      const content = document.getElementById('licenses-content')!;
      expect(content.innerHTML).toContain('https://github.com/user/repo2');
    });

    it('handles git@ SSH-style repository', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'ssh-pkg': {
            licenses: 'MIT',
            repository: 'git@github.com:user/repo3.git',
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
          <span id="total-deps"></span>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      const content = document.getElementById('licenses-content')!;
      expect(content.innerHTML).toContain('https://github.com/user/repo3');
    });

    it('handles ssh:// repository', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'ssh2-pkg': {
            licenses: 'MIT',
            repository: 'ssh://git@github.com/user/repo4',
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(document.getElementById('licenses-content')!.innerHTML).toContain(
        'https://github.com/user/repo4'
      );
    });

    it('handles git:// repository', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'git-pkg': {
            licenses: 'MIT',
            repository: 'git://github.com/user/repo5',
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(document.getElementById('licenses-content')!.innerHTML).toContain(
        'https://github.com/user/repo5'
      );
    });

    it('shows plain text for invalid/non-standard URLs', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'weird-pkg': {
            licenses: 'MIT',
            repository: 'ftp://weird-repo.example.com',
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      const content = document.getElementById('licenses-content')!;

      expect(content.innerHTML).not.toContain('license-link');
    });

    it('handles null/empty repository', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'no-repo': { licenses: 'MIT', repository: null },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      const content = document.getElementById('licenses-content')!;
      expect(content.innerHTML).not.toContain('Repository');
    });

    it('handles array licenses field', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'multi-lic': { licenses: ['MIT', 'Apache-2.0'] },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(document.getElementById('licenses-content')!.innerHTML).toContain('MIT, Apache-2.0');
    });
  });

  describe('showLicensesModal', () => {
    it('shows the modal and populates content', async () => {
      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
          <span id="total-deps"></span>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(document.getElementById('licenses-modal')!.style.display).toBe('flex');
      expect(deps.activateModal).toHaveBeenCalled();
      expect(document.getElementById('total-deps')!.textContent).toBe('1');
      expect(document.getElementById('licenses-content')!.innerHTML).toContain('some-pkg');
    });

    it('displays error on getLicenses failure', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: false,
        error: 'Could not read',
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(document.getElementById('licenses-content')!.innerHTML).toContain('Could not read');
    });

    it('displays error on exception', async () => {
      window.electronAPI.getLicenses = vi.fn(async () => {
        throw new Error('Network down');
      });

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(document.getElementById('licenses-content')!.innerHTML).toContain('Network down');
    });

    it('does nothing without modal element', async () => {
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();
      expect(deps.activateModal).not.toHaveBeenCalled();
    });

    it('does nothing without content element', async () => {
      document.body.innerHTML = `<div id="licenses-modal" style="display:none"></div>`;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      expect(deps.activateModal).toHaveBeenCalled();
    });

    it('truncates long license text', async () => {
      const longText = 'A'.repeat(1500);
      window.electronAPI.getLicenses = vi.fn(async () => ({
        success: true,
        licenses: {
          'long-pkg': {
            licenses: 'MIT',
            licenseFile: 'LICENSE',
            licenseText: longText,
          },
        },
      }));

      document.body.innerHTML = `
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      await ctrl.showLicensesModal();

      const content = document.getElementById('licenses-content')!.innerHTML;
      expect(content).toContain('...');
    });
  });

  describe('hideLicensesModal', () => {
    it('hides the modal', () => {
      document.body.innerHTML = '<div id="licenses-modal" style="display:flex"></div>';
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.hideLicensesModal();

      expect(document.getElementById('licenses-modal')!.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalled();
    });

    it('does nothing without modal element', () => {
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.hideLicensesModal();
    });
  });

  describe('copyLicensesText', () => {
    it('copies licenses content to clipboard', async () => {
      document.body.innerHTML = `
        <div id="licenses-content">License text here</div>
        <button id="copy-licenses-btn">Copy</button>
      `;

      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(async () => {}) },
        configurable: true,
        writable: true,
      });

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.copyLicensesText();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled();
      });
    });

    it('does nothing without content element', () => {
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.copyLicensesText();
    });
  });

  describe('initLicensesUi', () => {
    it('registers click listeners on buttons', () => {
      document.body.innerHTML = `
        <button id="licenses-btn"></button>
        <button id="licenses-close"></button>
        <button id="close-licenses-btn"></button>
        <button id="copy-licenses-btn"></button>
        <div id="licenses-content"></div>
        <div id="licenses-modal" style="display:none">
          <div id="licenses-content"></div>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.initLicensesUi();
    });

    it('handles link clicks with sanitization', () => {
      document.body.innerHTML = `
        <div id="licenses-content">
          <a class="license-link" href="https://example.com" data-url="https://example.com">Link</a>
        </div>
        <div id="licenses-modal" style="display:none"></div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.initLicensesUi();

      const link = document.querySelector('.license-link') as HTMLAnchorElement;
      link.click();

      expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/');
    });

    it('ignores links with unsafe protocols', () => {
      document.body.innerHTML = `
        <div id="licenses-content">
          <a class="license-link" href="javascript:alert(1)" data-url="javascript:alert(1)">Bad</a>
        </div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.initLicensesUi();

      const link = document.querySelector('.license-link') as HTMLAnchorElement;
      link.click();

      expect(deps.openExternal).not.toHaveBeenCalled();
    });

    it('closes modal on overlay click', () => {
      document.body.innerHTML = `
        <div id="licenses-modal" style="display:flex"></div>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.initLicensesUi();

      const modal = document.getElementById('licenses-modal')!;
      modal.click();

      expect(modal.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalled();
    });
  });

  describe('showSupportPopup / hideSupportPopup', () => {
    it('shows the support popup modal', () => {
      document.body.innerHTML = '<div id="support-popup-modal" style="display:none"></div>';
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.showSupportPopup();

      expect(document.getElementById('support-popup-modal')!.style.display).toBe('flex');
      expect(deps.activateModal).toHaveBeenCalled();
    });

    it('hides the support popup modal', () => {
      document.body.innerHTML = '<div id="support-popup-modal" style="display:flex"></div>';
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.hideSupportPopup();

      expect(document.getElementById('support-popup-modal')!.style.display).toBe('none');
      expect(deps.deactivateModal).toHaveBeenCalled();
    });

    it('does nothing without popup element', () => {
      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.showSupportPopup();
      ctrl.hideSupportPopup();
    });
  });

  describe('initSupportPopup', () => {
    it('registers dismiss button that saves settings', async () => {
      document.body.innerHTML = `
        <div id="support-popup-modal" style="display:flex"></div>
        <button id="support-popup-dismiss"></button>
        <button id="support-popup-yes"></button>
      `;

      const settings = {} as any;
      const deps = makeDeps({ getCurrentSettings: () => settings });
      const ctrl = createSupportUiController(deps);
      ctrl.initSupportPopup();

      document.getElementById('support-popup-dismiss')!.click();

      await vi.waitFor(() => {
        expect(settings.supportPopupDismissed).toBe(true);
        expect(deps.saveSettingsWithTimestamp).toHaveBeenCalled();
      });
    });

    it('registers yes button that opens external link', () => {
      document.body.innerHTML = `
        <div id="support-popup-modal" style="display:flex"></div>
        <button id="support-popup-dismiss"></button>
        <button id="support-popup-yes"></button>
      `;

      const deps = makeDeps();
      const ctrl = createSupportUiController(deps);
      ctrl.initSupportPopup();

      document.getElementById('support-popup-yes')!.click();

      expect(deps.openExternal).toHaveBeenCalledWith('https://rosie.run/support');
    });
  });
});
