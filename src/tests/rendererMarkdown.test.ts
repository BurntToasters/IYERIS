import { describe, expect, it, vi } from 'vitest';
import { createRetryableLoader } from '../rendererMarkdown';

describe('createRetryableLoader', () => {
  it('deduplicates concurrent successful loads and caches the result', async () => {
    const load = vi.fn(async () => ({ ready: true }));
    const cachedLoad = createRetryableLoader(load);

    const [first, second] = await Promise.all([cachedLoad(), cachedLoad()]);

    expect(first).toEqual({ ready: true });
    expect(second).toBe(first);
    expect(await cachedLoad()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not permanently cache a transient load failure', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue('loaded');
    const cachedLoad = createRetryableLoader(load);

    expect(await cachedLoad()).toBeNull();
    expect(await cachedLoad()).toBe('loaded');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
