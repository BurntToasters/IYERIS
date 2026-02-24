interface ExternalLinksDeps {
  openExternal: (url: string) => void;
  showLicensesModal: () => void;
  showShortcutsModal: () => void;
}

export function createExternalLinksController(deps: ExternalLinksDeps) {
  function initExternalLinks(): void {
    document.getElementById('github-btn')?.addEventListener('click', () => {
      deps.openExternal('https://github.com/BurntToasters/IYERIS');
    });
    document.getElementById('rosie-link')?.addEventListener('click', () => {
      deps.openExternal('https://rosie.run/support');
    });
    document.getElementById('twemoji-cc-link')?.addEventListener('click', () => {
      deps.openExternal('https://github.com/jdecked/twemoji');
    });
    document.getElementById('help-link')?.addEventListener('click', () => {
      deps.openExternal('https://help.rosie.run/iyeris/en-us/faq');
    });
    document.getElementById('heart-button')?.addEventListener('click', () => {
      deps.openExternal('https://rosie.run/support');
    });
    document.getElementById('status-version')?.addEventListener('click', () => {
      const version = (document.getElementById('status-version')?.textContent || 'v0.1.0').trim();
      deps.openExternal(`https://github.com/BurntToasters/IYERIS/releases/tag/${version}`);
    });

    document.getElementById('about-github-btn')?.addEventListener('click', () => {
      deps.openExternal('https://github.com/BurntToasters/IYERIS');
    });
    document.getElementById('about-support-btn')?.addEventListener('click', () => {
      deps.openExternal('https://rosie.run/support');
    });
    document.getElementById('about-help-btn')?.addEventListener('click', () => {
      deps.openExternal('https://help.rosie.run/iyeris/en-us/faq');
    });
    document.getElementById('about-licenses-btn')?.addEventListener('click', () => {
      deps.showLicensesModal();
    });
    document.getElementById('about-shortcuts-btn')?.addEventListener('click', () => {
      deps.showShortcutsModal();
    });
    document.getElementById('about-rosie-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      deps.openExternal('https://rosie.run');
    });
    document.getElementById('about-twemoji-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      deps.openExternal('https://github.com/jdecked/twemoji');
    });
    document.getElementById('about-7zip-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      deps.openExternal('https://www.7-zip.org');
    });
  }

  return { initExternalLinks };
}
