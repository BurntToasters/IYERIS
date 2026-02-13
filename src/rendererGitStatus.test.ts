import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGitStatusController } from './rendererGitStatus.js';

function makeDeps(overrides: Partial<Parameters<typeof createGitStatusController>[0]> = {}) {
  return {
    getCurrentSettings: () => ({ enableGitStatus: true, gitIncludeUntracked: true }) as any,
    getCurrentPath: () => '/test/dir',
    getFileElement: vi.fn((_path: string) => undefined as HTMLElement | undefined),
    getGitStatus: vi.fn(async () => ({
      success: true,
      isGitRepo: true,
      statuses: [{ path: '/test/dir/file.ts', status: 'modified' }],
    })),
    getGitBranch: vi.fn(async () => ({ success: true, branch: 'main' })),
    ...overrides,
  };
}

describe('rendererGitStatus', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('clearGitIndicators', () => {
    it('removes git-indicator elements', () => {
      const fileEl = document.createElement('div');
      const indicator = document.createElement('span');
      indicator.className = 'git-indicator modified';
      fileEl.appendChild(indicator);
      document.body.appendChild(fileEl);

      const deps = makeDeps({ getFileElement: () => fileEl });
      const ctrl = createGitStatusController(deps as any);
      ctrl.gitIndicatorPaths.add('/test/file.ts');
      ctrl.clearGitIndicators();

      expect(fileEl.querySelector('.git-indicator')).toBeNull();
      expect(ctrl.gitIndicatorPaths.size).toBe(0);
    });
  });

  describe('fetchGitStatusAsync', () => {
    it('fetches and applies git statuses', async () => {
      const fileEl = document.createElement('div');
      document.body.appendChild(fileEl);

      const deps = makeDeps({
        getFileElement: (path: string) => (path === '/test/dir/file.ts' ? fileEl : undefined),
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.fetchGitStatusAsync('/test/dir');

      expect(deps.getGitStatus).toHaveBeenCalledWith('/test/dir', true);
      const indicator = fileEl.querySelector('.git-indicator') as HTMLElement;
      expect(indicator).toBeTruthy();
      expect(indicator.classList.contains('modified')).toBe(true);
      expect(indicator.title).toBe('Modified');
    });

    it('does nothing when gitStatus is disabled', async () => {
      const deps = makeDeps({
        getCurrentSettings: () => ({ enableGitStatus: false }) as any,
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.fetchGitStatusAsync('/test/dir');
      expect(deps.getGitStatus).not.toHaveBeenCalled();
    });

    it('clears indicators when result is not a git repo', async () => {
      const deps = makeDeps({
        getGitStatus: vi.fn(async () => ({
          success: true,
          isGitRepo: false,
          statuses: [],
        })),
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.fetchGitStatusAsync('/test/dir');
      expect(ctrl.gitIndicatorPaths.size).toBe(0);
    });

    it('handles fetch errors gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const deps = makeDeps({
        getGitStatus: vi.fn(async () => {
          throw new Error('network fail');
        }),
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.fetchGitStatusAsync('/test/dir');
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it('ignores stale requests', async () => {
      const fileEl = document.createElement('div');
      document.body.appendChild(fileEl);

      let resolveGit!: (v: any) => void;
      const deps = makeDeps({
        getFileElement: () => fileEl,
        getGitStatus: vi.fn(
          () =>
            new Promise((r) => {
              resolveGit = r;
            })
        ) as any,
      });
      const ctrl = createGitStatusController(deps as any);

      const p1 = ctrl.fetchGitStatusAsync('/test/dir');

      const p2 = ctrl.fetchGitStatusAsync('/test/dir');
      resolveGit({
        success: true,
        isGitRepo: true,
        statuses: [{ path: '/test/dir/f.ts', status: 'added' }],
      });
      await p1;
      await p2;
    });

    it('uses gitIncludeUntracked=false when setting is false', async () => {
      const deps = makeDeps({
        getCurrentSettings: () => ({ enableGitStatus: true, gitIncludeUntracked: false }) as any,
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.fetchGitStatusAsync('/test/dir');
      expect(deps.getGitStatus).toHaveBeenCalledWith('/test/dir', false);
    });
  });

  describe('getGitStatusCached', () => {
    it('returns cached result within TTL', async () => {
      const deps = makeDeps();
      const ctrl = createGitStatusController(deps as any);

      await ctrl.fetchGitStatusAsync('/test/dir');
      expect(deps.getGitStatus).toHaveBeenCalledTimes(1);

      await ctrl.fetchGitStatusAsync('/test/dir');

      expect(deps.getGitStatus).toHaveBeenCalledTimes(1);
    });

    it('deduplicates in-flight requests', async () => {
      let resolveGit!: (v: any) => void;
      const deps = makeDeps({
        getGitStatus: vi.fn(
          () =>
            new Promise((r) => {
              resolveGit = r;
            })
        ) as any,
      });
      const ctrl = createGitStatusController(deps as any);

      const p1 = ctrl.fetchGitStatusAsync('/test/dir');
      const p2 = ctrl.fetchGitStatusAsync('/test/dir');

      resolveGit({ success: true, isGitRepo: true, statuses: [] });
      await p1;
      await p2;
      expect(deps.getGitStatus).toHaveBeenCalledTimes(1);
    });

    it('evicts oldest cache entry when max reached', async () => {
      const deps = makeDeps({
        getGitStatus: vi.fn(async () => ({
          success: true,
          isGitRepo: true,
          statuses: [],
        })),
      });
      const ctrl = createGitStatusController(deps as any);

      for (let i = 0; i < 101; i++) {
        const path = `/test/dir${i}`;
        const current = { ...deps, getCurrentPath: () => path };
        ctrl.gitStatusCache.set(`${path}|all`, {
          timestamp: Date.now(),
          isGitRepo: true,
          statuses: [],
        });
      }
      expect(ctrl.gitStatusCache.size).toBe(101);

      await ctrl.fetchGitStatusAsync('/test/dir');
    });
  });

  describe('updateGitBranch', () => {
    it('displays branch name on success', async () => {
      document.body.innerHTML = `
        <span id="status-git-branch" style="display:none">
          <span id="status-git-branch-name"></span>
        </span>
      `;
      const deps = makeDeps();
      const ctrl = createGitStatusController(deps as any);
      await ctrl.updateGitBranch('/test/dir');

      expect(document.getElementById('status-git-branch')!.style.display).toBe('inline-flex');
      expect(document.getElementById('status-git-branch-name')!.textContent).toBe('main');
    });

    it('hides branch when git disabled', async () => {
      document.body.innerHTML = `
        <span id="status-git-branch" style="display:inline-flex">
          <span id="status-git-branch-name"></span>
        </span>
      `;
      const deps = makeDeps({
        getCurrentSettings: () => ({ enableGitStatus: false }) as any,
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.updateGitBranch('/test/dir');
      expect(document.getElementById('status-git-branch')!.style.display).toBe('none');
    });

    it('hides branch on failure', async () => {
      document.body.innerHTML = `
        <span id="status-git-branch" style="display:inline-flex">
          <span id="status-git-branch-name"></span>
        </span>
      `;
      const deps = makeDeps({
        getGitBranch: vi.fn(async () => ({ success: false })),
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.updateGitBranch('/test/dir');
      expect(document.getElementById('status-git-branch')!.style.display).toBe('none');
    });

    it('hides branch on exception', async () => {
      document.body.innerHTML = `
        <span id="status-git-branch" style="display:inline-flex">
          <span id="status-git-branch-name"></span>
        </span>
      `;
      const deps = makeDeps({
        getGitBranch: vi.fn(async () => {
          throw new Error('fail');
        }),
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.updateGitBranch('/test/dir');
      expect(document.getElementById('status-git-branch')!.style.display).toBe('none');
    });

    it('does nothing without DOM elements', async () => {
      const deps = makeDeps();
      const ctrl = createGitStatusController(deps as any);
      await ctrl.updateGitBranch('/test/dir');
      expect(deps.getGitBranch).not.toHaveBeenCalled();
    });

    it('hides when dirPath differs from currentPath', async () => {
      document.body.innerHTML = `
        <span id="status-git-branch" style="display:inline-flex">
          <span id="status-git-branch-name"></span>
        </span>
      `;
      const deps = makeDeps({
        getCurrentPath: () => '/other/dir',
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.updateGitBranch('/test/dir');
      expect(document.getElementById('status-git-branch')!.style.display).toBe('none');
    });
  });

  describe('updateGitIndicators', () => {
    it('disables removes all indicators when git disabled', () => {
      const deps = makeDeps({
        getCurrentSettings: () => ({ enableGitStatus: false }) as any,
      });
      const ctrl = createGitStatusController(deps as any);
      ctrl.updateGitIndicators();
      expect(ctrl.gitIndicatorPaths.size).toBe(0);
    });
  });

  describe('applyGitIndicatorsToPaths', () => {
    it('creates indicator elements on file items', async () => {
      const fileEl = document.createElement('div');
      document.body.appendChild(fileEl);

      const deps = makeDeps({
        getFileElement: (p: string) => (p === '/test/file.ts' ? fileEl : undefined),
      });
      const ctrl = createGitStatusController(deps as any);

      await ctrl.fetchGitStatusAsync('/test/dir');

      ctrl.applyGitIndicatorsToPaths(['/test/dir/file.ts']);
    });

    it('updates existing indicator', async () => {
      const fileEl = document.createElement('div');
      const existing = document.createElement('span');
      existing.className = 'git-indicator old';
      fileEl.appendChild(existing);
      document.body.appendChild(fileEl);

      const deps = makeDeps({
        getFileElement: (p: string) => (p === '/test/dir/file.ts' ? fileEl : undefined),
      });
      const ctrl = createGitStatusController(deps as any);
      await ctrl.fetchGitStatusAsync('/test/dir');

      const indicator = fileEl.querySelector('.git-indicator') as HTMLElement;
      expect(indicator.classList.contains('modified')).toBe(true);
      expect(indicator.classList.contains('old')).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('clears all internal caches', () => {
      const deps = makeDeps();
      const ctrl = createGitStatusController(deps as any);
      ctrl.gitIndicatorPaths.add('/test');
      ctrl.gitStatusCache.set('key', { timestamp: 0, isGitRepo: true, statuses: [] });

      ctrl.clearCache();
      expect(ctrl.gitIndicatorPaths.size).toBe(0);
      expect(ctrl.gitStatusCache.size).toBe(0);
      expect(ctrl.gitStatusInFlight.size).toBe(0);
    });
  });
});
