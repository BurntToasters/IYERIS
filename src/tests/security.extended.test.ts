import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { isPathSafe, isTrustedIpcSender } from '../main/security';

const allowedSrcHtml = path.resolve(__dirname, '..', 'index.html');
const allowedDistHtml = path.resolve(__dirname, '..', '..', 'dist', 'index.html');
const allowedSrcUrl = pathToFileURL(allowedSrcHtml).toString();
const allowedDistUrl = pathToFileURL(allowedDistHtml).toString();

describe('isPathSafe – uncovered win32 branches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects UNC path with fewer than 2 parts (line 87)', () => {
    vi.spyOn(path.win32, 'normalize').mockReturnValueOnce('\\\\server\\');
    expect(isPathSafe('\\\\server\\share', 'win32')).toBe(false);
  });

  it('rejects path segment consisting entirely of dots (line 95)', () => {
    expect(isPathSafe('C:\\Users\\...\\file.txt', 'win32')).toBe(false);
  });

  it('rejects path segment consisting entirely of spaces', () => {
    expect(isPathSafe('C:\\Users\\   \\file.txt', 'win32')).toBe(false);
  });

  it('rejects path segment consisting of mixed spaces and dots', () => {
    expect(isPathSafe('C:\\Users\\. .\\file.txt', 'win32')).toBe(false);
  });
});

describe('isTrustedIpcSender', () => {
  it('returns false when event has no senderFrame and no sender', () => {
    expect(isTrustedIpcSender({})).toBe(false);
  });

  it('returns false when senderFrame is null and sender is null', () => {
    expect(isTrustedIpcSender({ senderFrame: null, sender: null })).toBe(false);
  });

  it('returns false when senderFrame.url is empty and sender has no getURL', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: '' }, sender: {} as any })).toBe(false);
  });

  it('returns false when senderFrame.url is undefined', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: undefined } })).toBe(false);
  });

  it('returns true when senderFrame.url matches allowed src renderer URL', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: allowedSrcUrl } })).toBe(true);
  });

  it('returns true when senderFrame.url matches allowed dist renderer URL', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: allowedDistUrl } })).toBe(true);
  });

  it('returns true when sender.getURL() matches allowed renderer URL', () => {
    const event = {
      senderFrame: null,
      sender: { getURL: () => allowedSrcUrl },
    };
    expect(isTrustedIpcSender(event)).toBe(true);
  });

  it('returns false for a file: URL pointing to a non-allowed path', () => {
    const fakeFileUrl = pathToFileURL('/tmp/evil/index.html').toString();
    expect(isTrustedIpcSender({ senderFrame: { url: fakeFileUrl } })).toBe(false);
  });

  it('returns false for a non-file URL scheme (https)', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: 'https://malicious.example.com' } })).toBe(
      false
    );
  });

  it('returns false for a non-file URL scheme (http)', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: 'http://localhost:3000' } })).toBe(false);
  });

  it('returns false and ignores error for an invalid URL string', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: 'not-a-valid-url' } })).toBe(false);
  });

  it('uses sender.getURL() when senderFrame is missing', () => {
    const event = {
      sender: { getURL: () => allowedDistUrl },
    };
    expect(isTrustedIpcSender(event)).toBe(true);
  });

  it('uses sender.getURL() when senderFrame.url is falsy', () => {
    const event = {
      senderFrame: { url: '' },
      sender: { getURL: () => allowedSrcUrl },
    };
    expect(isTrustedIpcSender(event)).toBe(true);
  });

  it('returns false when sender.getURL returns a non-allowed URL', () => {
    const event = {
      sender: { getURL: () => 'https://attacker.example.com' },
    };
    expect(isTrustedIpcSender(event)).toBe(false);
  });

  it('prefers senderFrame.url over sender.getURL()', () => {
    const event = {
      senderFrame: { url: allowedSrcUrl },
      sender: { getURL: () => 'https://attacker.example.com' },
    };
    expect(isTrustedIpcSender(event)).toBe(true);
  });
});
