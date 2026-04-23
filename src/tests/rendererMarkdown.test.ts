import { describe, it, expect, vi } from 'vitest';

describe('rendererMarkdown.loadMarked', () => {
  it('loads marked and caches the instance', async () => {
    vi.resetModules();
    vi.doUnmock('marked');

    const mod = await import('../rendererMarkdown');
    const first = await mod.loadMarked();
    const second = await mod.loadMarked();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('returns null when marked import fails', async () => {
    vi.resetModules();
    vi.doMock('marked', () => {
      throw new Error('mocked import failure');
    });

    const mod = await import('../rendererMarkdown');
    await expect(mod.loadMarked()).resolves.toBeNull();

    vi.doUnmock('marked');
  });
});
