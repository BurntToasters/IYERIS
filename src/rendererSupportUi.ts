import type { Settings } from './types';

interface SupportUiDeps {
  activateModal: (modal: HTMLElement) => void;
  deactivateModal: (modal: HTMLElement) => void;
  escapeHtml: (value: string) => string;
  getErrorMessage: (error: unknown) => string;
  getCurrentSettings: () => Settings;
  saveSettingsWithTimestamp: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
  openExternal: (url: string) => void;
}

export function createSupportUiController(deps: SupportUiDeps) {
  function getRepositoryText(repository: unknown): string | null {
    if (typeof repository === 'string') {
      const trimmed = repository.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (repository && typeof repository === 'object' && 'url' in repository) {
      const repoUrl = (repository as { url?: unknown }).url;
      if (typeof repoUrl === 'string') {
        const trimmed = repoUrl.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    }

    return null;
  }

  function normalizeRepositoryUrl(repository: unknown): string | null {
    const raw = getRepositoryText(repository);
    if (!raw) return null;

    let normalized = raw;

    if (normalized.startsWith('git+')) {
      normalized = normalized.slice(4);
    }

    if (normalized.startsWith('git@')) {
      const match = normalized.match(/^git@([^:]+):(.+)$/);
      if (match) {
        normalized = `https://${match[1]}/${match[2]}`;
      }
    }

    if (normalized.startsWith('ssh://git@')) {
      normalized = normalized.replace(/^ssh:\/\/git@/, 'https://');
    }

    if (normalized.startsWith('git://')) {
      normalized = normalized.replace(/^git:\/\//, 'https://');
    }

    if (normalized.endsWith('.git')) {
      normalized = normalized.slice(0, -4);
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return null;
    }

    return null;
  }

  function sanitizeExternalUrl(url: string | null): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'mailto:'
      ) {
        return parsed.toString();
      }
    } catch {
      return null;
    }
    return null;
  }

  async function showLicensesModal() {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const licensesModal = document.getElementById('licenses-modal');
    if (!licensesModal) return;

    licensesModal.style.display = 'flex';
    deps.activateModal(licensesModal);

    const licensesContent = document.getElementById('licenses-content');
    const totalDeps = document.getElementById('total-deps');

    if (!licensesContent) return;

    licensesContent.innerHTML =
      '<p style="text-align: center; color: var(--text-secondary);">Loading licenses...</p>';

    try {
      const result = await window.electronAPI.getLicenses();

      if (result.success && result.licenses) {
        const licenses = result.licenses;
        const packageCount = Object.keys(licenses).length;

        if (totalDeps) {
          totalDeps.textContent = packageCount.toString();
        }

        let html = '';

        for (const [packageName, packageInfo] of Object.entries(licenses)) {
          const info = packageInfo;
          html += '<div class="license-package">';
          html += `<div class="license-package-name">${deps.escapeHtml(packageName)}</div>`;
          html += '<div class="license-package-info">';
          const licenseLabel = Array.isArray(info.licenses)
            ? info.licenses.join(', ')
            : info.licenses || 'Unknown';
          html += `<span class="license-package-license">${deps.escapeHtml(licenseLabel)}</span>`;
          const repositoryUrl = sanitizeExternalUrl(normalizeRepositoryUrl(info.repository));
          const repositoryText = getRepositoryText(info.repository);
          if (repositoryUrl) {
            html += `<span>Repository: <a class="license-link" href="${deps.escapeHtml(
              repositoryUrl
            )}" data-url="${deps.escapeHtml(
              repositoryUrl
            )}" rel="noopener noreferrer">${deps.escapeHtml(repositoryUrl)}</a></span>`;
          } else if (repositoryText) {
            html += `<span>Repository: ${deps.escapeHtml(repositoryText)}</span>`;
          }
          if (info.publisher) {
            html += `<span>Publisher: ${deps.escapeHtml(info.publisher)}</span>`;
          }
          html += '</div>';

          if (info.licenseFile && info.licenseText) {
            html += `<div class="license-package-text">${deps.escapeHtml(
              info.licenseText.substring(0, 1000)
            )}${info.licenseText.length > 1000 ? '...' : ''}</div>`;
          }

          html += '</div>';
        }

        licensesContent.innerHTML = html;
      } else {
        licensesContent.innerHTML = `<p style="color: var(--error-color); text-align: center;">Error loading licenses: ${deps.escapeHtml(
          result.error || 'Unknown error'
        )}</p>`;
      }
    } catch (error) {
      licensesContent.innerHTML = `<p style="color: var(--error-color); text-align: center;">Error: ${deps.escapeHtml(
        deps.getErrorMessage(error)
      )}</p>`;
    }
  }

  function hideLicensesModal() {
    const licensesModal = document.getElementById('licenses-modal');
    if (licensesModal) {
      licensesModal.style.display = 'none';
      deps.deactivateModal(licensesModal);
    }
  }

  function copyLicensesText() {
    const licensesContent = document.getElementById('licenses-content');
    if (!licensesContent) return;

    const text = licensesContent.innerText;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const btn = document.getElementById('copy-licenses-btn');
        if (btn) {
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 2000);
        }
      })
      .catch((err) => {
        console.error('Failed to copy:', err);
      });
  }

  function initLicensesUi(): void {
    document.getElementById('licenses-btn')?.addEventListener('click', showLicensesModal);
    document.getElementById('licenses-close')?.addEventListener('click', hideLicensesModal);
    document.getElementById('close-licenses-btn')?.addEventListener('click', hideLicensesModal);
    document.getElementById('copy-licenses-btn')?.addEventListener('click', copyLicensesText);
    const licensesContent = document.getElementById('licenses-content');
    if (licensesContent) {
      licensesContent.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        const link = target?.closest('a.license-link') as HTMLAnchorElement | null;
        if (!link) return;

        const url = link.dataset.url || link.getAttribute('href');
        const safeUrl = sanitizeExternalUrl(url);
        if (!safeUrl) return;

        event.preventDefault();
        deps.openExternal(safeUrl);
      });
    }

    const licensesModal = document.getElementById('licenses-modal');
    if (licensesModal) {
      licensesModal.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'licenses-modal') {
          hideLicensesModal();
        }
      });
    }
  }

  function showSupportPopup() {
    const modal = document.getElementById('support-popup-modal');
    if (modal) {
      modal.style.display = 'flex';
      deps.activateModal(modal);
    }
  }

  function hideSupportPopup() {
    const modal = document.getElementById('support-popup-modal');
    if (modal) {
      modal.style.display = 'none';
      deps.deactivateModal(modal);
    }
  }

  function initSupportPopup(): void {
    document.getElementById('support-popup-dismiss')?.addEventListener('click', async () => {
      const settings = deps.getCurrentSettings();
      settings.supportPopupDismissed = true;
      await deps.saveSettingsWithTimestamp(settings);
      hideSupportPopup();
    });

    document.getElementById('support-popup-yes')?.addEventListener('click', () => {
      deps.openExternal('https://rosie.run/support');
      hideSupportPopup();
    });
  }

  return {
    showLicensesModal,
    hideLicensesModal,
    copyLicensesText,
    initLicensesUi,
    showSupportPopup,
    hideSupportPopup,
    initSupportPopup,
  };
}
