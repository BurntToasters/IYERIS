// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());
const mockMessage = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: mockMessage,
}));

describe('tauriAPI conflict handling', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockListen.mockReset();
    mockMessage.mockReset();
    mockListen.mockResolvedValue(() => {});
  });

  it('prompts for each copy conflict instead of reusing the first decision implicitly', async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error('CONFLICT: first.txt'))
      .mockRejectedValueOnce(new Error('CONFLICT: second.txt'))
      .mockResolvedValueOnce(undefined);
    mockMessage.mockResolvedValueOnce('Replace').mockResolvedValueOnce('Skip');

    await import('../tauri-api');

    const result = await window.tauriAPI.copyItems(['/tmp/a', '/tmp/b'], '/dest', 'ask');
    const copyCalls = mockInvoke.mock.calls.filter(([command]) => command === 'copy_items');

    expect(result).toEqual({ success: true });
    expect(copyCalls).toHaveLength(3);
    expect(mockMessage).toHaveBeenCalledTimes(2);
    expect(mockMessage).toHaveBeenNthCalledWith(
      1,
      '"first.txt" already exists in this location.',
      expect.objectContaining({ title: 'Copy Conflict' })
    );
    expect(mockMessage).toHaveBeenNthCalledWith(
      2,
      '"second.txt" already exists in this location.',
      expect.objectContaining({ title: 'Copy Conflict' })
    );
    expect(copyCalls[2]?.[1]).toEqual(
      expect.objectContaining({
        conflictResolutions: {
          'first.txt': 'overwrite',
          'second.txt': 'skip',
        },
      })
    );
  });
});
