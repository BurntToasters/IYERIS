import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

vi.mock('../main/appState', () => ({
  getMainWindow: vi.fn(() => null),
  getFileTasks: vi.fn(() => ({ on: vi.fn() })),
}));

vi.mock('../main/security', () => ({
  isTrustedIpcSender: vi.fn(() => false),
}));

vi.mock('../shared', () => ({
  isRecord: vi.fn((v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)),
}));

import {
  safeSendToWindow,
  safeSendToContents,
  registerDirectoryOperationTarget,
  unregisterDirectoryOperationTarget,
  isTrustedIpcEvent,
  withTrustedIpcEvent,
  withTrustedApiHandler,
} from '../main/ipcUtils';
import { isTrustedIpcSender } from '../main/security';
import type { IpcMainInvokeEvent } from 'electron';

function makeMockWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => destroyed,
      send: vi.fn(),
    },
  } as unknown as import('electron').BrowserWindow;
}

function makeMockContents(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(),
  } as unknown as import('electron').WebContents;
}

function makeMockEvent(trusted = false) {
  const event = {
    senderFrame: { url: trusted ? 'file:///app/index.html' : 'http://evil.com' },
    sender: { getURL: () => (trusted ? 'file:///app/index.html' : 'http://evil.com') },
  } as unknown as IpcMainInvokeEvent;
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('safeSendToWindow', () => {
  it('sends message to a valid window', () => {
    const win = makeMockWindow();
    const result = safeSendToWindow(win, 'test-channel', 'arg1', 'arg2');
    expect(result).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('test-channel', 'arg1', 'arg2');
  });

  it('returns false for null window', () => {
    expect(safeSendToWindow(null, 'test-channel')).toBe(false);
  });

  it('returns false for destroyed window', () => {
    const win = makeMockWindow(true);
    expect(safeSendToWindow(win, 'test-channel')).toBe(false);
  });

  it('returns false and logs error on throw', () => {
    const win = makeMockWindow();
    (win.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('send failed');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = safeSendToWindow(win, 'fail-channel');
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('safeSendToContents', () => {
  it('sends message to valid WebContents', () => {
    const contents = makeMockContents();
    const result = safeSendToContents(contents, 'ch', 'data');
    expect(result).toBe(true);
    expect(contents.send).toHaveBeenCalledWith('ch', 'data');
  });

  it('returns false for null contents', () => {
    expect(safeSendToContents(null, 'ch')).toBe(false);
  });

  it('returns false for destroyed contents', () => {
    const contents = makeMockContents(true);
    expect(safeSendToContents(contents, 'ch')).toBe(false);
  });
});

describe('registerDirectoryOperationTarget / unregisterDirectoryOperationTarget', () => {
  it('registers and unregisters without error', () => {
    const contents = makeMockContents();
    expect(() => registerDirectoryOperationTarget('op-1', contents)).not.toThrow();
    expect(() => unregisterDirectoryOperationTarget('op-1')).not.toThrow();
  });
});

describe('isTrustedIpcEvent', () => {
  it('returns true when isTrustedIpcSender returns true', () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(true);
    const event = makeMockEvent();
    expect(isTrustedIpcEvent(event)).toBe(true);
  });

  it('returns false when isTrustedIpcSender returns false', () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(false);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeMockEvent();
    expect(isTrustedIpcEvent(event)).toBe(false);
    consoleSpy.mockRestore();
  });

  it('logs channel name when provided and untrusted', () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(false);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeMockEvent();
    isTrustedIpcEvent(event, 'my-channel');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('my-channel'),
      expect.anything()
    );
    consoleSpy.mockRestore();
  });
});

describe('withTrustedIpcEvent', () => {
  it('calls handler when event is trusted', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(true);
    const handler = vi.fn().mockReturnValue('result');
    const wrapped = withTrustedIpcEvent('ch', 'default', handler);
    const event = makeMockEvent(true);
    const result = await wrapped(event);
    expect(result).toBe('result');
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('returns untrustedResponse when event is not trusted', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    const wrapped = withTrustedIpcEvent('ch', 'blocked', handler);
    const event = makeMockEvent(false);
    const result = await wrapped(event);
    expect(result).toBe('blocked');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('withTrustedApiHandler', () => {
  it('calls handler when event is trusted', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(true);
    const handler = vi.fn().mockResolvedValue({ success: true });
    const wrapped = withTrustedApiHandler('ch', handler);
    const event = makeMockEvent(true);
    const result = await wrapped(event);
    expect(result).toEqual({ success: true });
  });

  it('returns untrusted response when not trusted', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    const wrapped = withTrustedApiHandler('ch', handler);
    const event = makeMockEvent(false);
    const result = await wrapped(event);
    expect(result).toEqual({ success: false, error: 'Untrusted IPC sender' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('catches handler errors and returns error result', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(true);
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = withTrustedApiHandler('ch', handler);
    const event = makeMockEvent(true);
    const result = await wrapped(event);
    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('handles non-Error throws', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(true);
    const handler = vi.fn().mockRejectedValue('string error');
    const wrapped = withTrustedApiHandler('ch', handler);
    const event = makeMockEvent(true);
    const result = await wrapped(event);
    expect(result).toEqual({ success: false, error: 'string error' });
  });

  it('accepts custom untrusted response', async () => {
    vi.mocked(isTrustedIpcSender).mockReturnValueOnce(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    const wrapped = withTrustedApiHandler('ch', handler, {
      success: false,
      error: 'custom',
    });
    const event = makeMockEvent(false);
    const result = await wrapped(event);
    expect(result).toEqual({ success: false, error: 'custom' });
  });
});
