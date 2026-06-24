// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderSkeleton, clearSkeleton } from '../rendererSkeleton';

describe('rendererSkeleton', () => {
  it('renders grid skeleton items correctly', () => {
    const container = document.createElement('div');
    renderSkeleton(container, 'grid');

    expect(container.classList.contains('skeleton-loading')).toBe(true);
    const items = container.querySelectorAll('.file-item.skeleton-loading');
    expect(items.length).toBe(12);

    const firstItem = items[0];
    expect(firstItem).toBeTruthy();
    expect(firstItem.querySelector('.file-icon.skeleton-shimmer')).toBeTruthy();
    expect(firstItem.querySelector('.file-name.skeleton-shimmer')).toBeTruthy();
  });

  it('renders list skeleton items correctly', () => {
    const container = document.createElement('div');
    renderSkeleton(container, 'list');

    expect(container.classList.contains('skeleton-loading')).toBe(true);
    const items = container.querySelectorAll('.file-item.skeleton-loading');
    expect(items.length).toBe(12);

    const firstItem = items[0];
    expect(firstItem).toBeTruthy();
    expect(firstItem.querySelector('.file-icon.skeleton-shimmer')).toBeTruthy();
    expect(firstItem.querySelector('.file-name.skeleton-shimmer')).toBeTruthy();
    expect(firstItem.querySelector('.file-info')).toBeTruthy();
    expect(firstItem.querySelector('.file-type.skeleton-shimmer')).toBeTruthy();
    expect(firstItem.querySelector('.file-size.skeleton-shimmer')).toBeTruthy();
    expect(firstItem.querySelector('.file-modified.skeleton-shimmer')).toBeTruthy();
  });

  it('clears skeleton styling correctly', () => {
    const container = document.createElement('div');
    renderSkeleton(container, 'grid');
    expect(container.classList.contains('skeleton-loading')).toBe(true);

    clearSkeleton(container);
    expect(container.classList.contains('skeleton-loading')).toBe(false);
  });
});
