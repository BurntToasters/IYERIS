/**
 * Skeleton loading screen placeholders for IYERIS
 */

export function renderSkeleton(container: HTMLElement, viewMode: 'grid' | 'list' | 'column'): void {
  container.replaceChildren();

  // Add a class to container to mark it as skeleton loading
  container.classList.add('skeleton-loading');

  const count = 12;
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const item = document.createElement('div');
    item.className = 'file-item skeleton-loading';
    item.setAttribute('role', 'status');
    item.setAttribute('aria-label', 'Loading item...');

    if (viewMode === 'list') {
      // eslint-disable-next-line no-restricted-syntax -- static HTML skeleton structure, no user input
      item.innerHTML = `
        <div class="file-main">
          <div class="file-icon skeleton-shimmer" style="width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; margin-bottom: 0;"></div>
          <div class="file-text" style="flex: 1;">
            <div class="file-name skeleton-shimmer" style="width: ${80 + (i % 3) * 30}px; height: 14px; border-radius: 4px; margin-top: 2px;"></div>
          </div>
        </div>
        <div class="file-info">
          <span class="file-type skeleton-shimmer" style="width: 70px; height: 12px; border-radius: 4px; display: inline-block;"></span>
          <span class="file-size skeleton-shimmer" style="width: 45px; height: 12px; border-radius: 4px; display: inline-block;"></span>
          <span class="file-modified skeleton-shimmer" style="width: 110px; height: 12px; border-radius: 4px; display: inline-block;"></span>
        </div>
      `;
    } else {
      // grid view or column view fallback
      // eslint-disable-next-line no-restricted-syntax -- static HTML skeleton structure, no user input
      item.innerHTML = `
        <div class="file-main" style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%;">
          <div class="file-icon skeleton-shimmer" style="width: var(--icon-size-grid, 64px); height: var(--icon-size-grid, 64px); border-radius: 8px; margin-bottom: var(--file-icon-margin-bottom, 8px); float: none;"></div>
          <div class="file-text" style="padding: 0; text-align: center; display: flex; justify-content: center; width: 100%;">
            <div class="file-name skeleton-shimmer" style="width: ${50 + (i % 4) * 15}px; height: 12px; border-radius: 4px;"></div>
          </div>
        </div>
      `;
    }
    fragment.appendChild(item);
  }

  container.appendChild(fragment);
}

export function clearSkeleton(container: HTMLElement): void {
  container.classList.remove('skeleton-loading');
}
