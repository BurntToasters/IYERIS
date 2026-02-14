// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createExternalLinksController } from '../rendererExternalLinks';

function makeDeps() {
  return {
    openExternal: vi.fn(),
    showLicensesModal: vi.fn(),
    showShortcutsModal: vi.fn(),
  };
}

const BUTTON_IDS = [
  'github-btn',
  'rosie-link',
  'twemoji-cc-link',
  'help-link',
  'heart-button',
  'status-version',
  'about-github-btn',
  'about-support-btn',
  'about-help-btn',
  'about-licenses-btn',
  'about-shortcuts-btn',
  'about-rosie-link',
  'about-twemoji-link',
];

describe('rendererExternalLinks', () => {
  beforeEach(() => {
    document.body.innerHTML = BUTTON_IDS.map((id) => {
      const tag = id.includes('link') ? 'a' : 'button';
      return `<${tag} id="${id}"></${tag}>`;
    }).join('');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('github-btn opens GitHub URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('github-btn')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/BurntToasters/IYERIS');
  });

  it('rosie-link opens support URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('rosie-link')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://rosie.run/support');
  });

  it('twemoji-cc-link opens twemoji repo', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('twemoji-cc-link')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/jdecked/twemoji');
  });

  it('help-link opens FAQ URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('help-link')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://help.rosie.run/iyeris/en-us/faq');
  });

  it('heart-button opens support URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('heart-button')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://rosie.run/support');
  });

  it('status-version opens release URL using textContent', () => {
    const deps = makeDeps();
    const el = document.getElementById('status-version')!;
    el.textContent = 'v1.2.3';
    createExternalLinksController(deps).initExternalLinks();
    el.click();
    expect(deps.openExternal).toHaveBeenCalledWith(
      'https://github.com/BurntToasters/IYERIS/releases/tag/v1.2.3'
    );
  });

  it('status-version uses fallback when empty', () => {
    const deps = makeDeps();
    const el = document.getElementById('status-version')!;
    el.textContent = '';
    createExternalLinksController(deps).initExternalLinks();
    el.click();
    expect(deps.openExternal).toHaveBeenCalledWith(
      'https://github.com/BurntToasters/IYERIS/releases/tag/v0.1.0'
    );
  });

  it('about-github-btn opens GitHub URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('about-github-btn')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/BurntToasters/IYERIS');
  });

  it('about-support-btn opens support URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('about-support-btn')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://rosie.run/support');
  });

  it('about-help-btn opens FAQ URL', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('about-help-btn')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://help.rosie.run/iyeris/en-us/faq');
  });

  it('about-licenses-btn calls showLicensesModal', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('about-licenses-btn')!.click();
    expect(deps.showLicensesModal).toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('about-shortcuts-btn calls showShortcutsModal', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('about-shortcuts-btn')!.click();
    expect(deps.showShortcutsModal).toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('about-rosie-link prevents default and opens rosie.run', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    const el = document.getElementById('about-rosie-link')! as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const spy = vi.spyOn(event, 'preventDefault');
    el.dispatchEvent(event);
    expect(spy).toHaveBeenCalled();
    expect(deps.openExternal).toHaveBeenCalledWith('https://rosie.run');
  });

  it('about-twemoji-link prevents default and opens twemoji repo', () => {
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    const el = document.getElementById('about-twemoji-link')! as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const spy = vi.spyOn(event, 'preventDefault');
    el.dispatchEvent(event);
    expect(spy).toHaveBeenCalled();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/jdecked/twemoji');
  });

  it('works when some elements are missing', () => {
    document.body.innerHTML = '<button id="github-btn"></button>';
    const deps = makeDeps();
    createExternalLinksController(deps).initExternalLinks();
    document.getElementById('github-btn')!.click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/BurntToasters/IYERIS');
  });
});
