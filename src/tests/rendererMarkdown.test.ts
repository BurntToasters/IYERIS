import { describe, it, expect, vi, afterEach } from 'vitest';

// F4 (isolation): the failure-path test below mocks the `marked` import. Undoing
// that inline after the assertion means a failed assertion leaks the mock into
// every later test in this file, so the teardown lives in afterEach instead.
afterEach(() => {
  vi.doUnmock('marked');
  vi.resetModules();
});

describe('rendererMarkdown.loadMarked', () => {
  it('loads marked and caches the instance', async () => {
    const mod = await import('../rendererMarkdown');
    const first = await mod.loadMarked();
    const second = await mod.loadMarked();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('returns null when marked import fails', async () => {
    vi.doMock('marked', () => {
      throw new Error('mocked import failure');
    });

    const mod = await import('../rendererMarkdown');
    await expect(mod.loadMarked()).resolves.toBeNull();
  });

  it('recovers a real marked instance after a failed import in a previous test', async () => {
    const mod = await import('../rendererMarkdown');
    await expect(mod.loadMarked()).resolves.toBeTruthy();
  });
});
