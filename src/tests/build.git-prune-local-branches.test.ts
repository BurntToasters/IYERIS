import { describe, expect, it } from 'vitest';
import * as gitPrune from '../../build/git-prune-local-branches.js';

type GitPruneModule = {
  parseArgs: (argv: string[]) => { remote: string; dryRun: boolean; force: boolean };
  stripRemotePrefix: (ref: string, remote: string) => string | null;
  selectBranchesToDelete: (
    localBranches: string[],
    remoteBranches: string[],
    currentBranch: string
  ) => string[];
  deleteBranches: (
    branches: string[],
    options?: { force?: boolean; dryRun?: boolean }
  ) => { deleted: string[]; skipped: Array<{ branch: string; reason: string }> };
};

const typedGitPrune = gitPrune as unknown as GitPruneModule;

describe('build/git-prune-local-branches.js', () => {
  it('parses default args', () => {
    const parsed = typedGitPrune.parseArgs(['node', 'script']);
    expect(parsed).toEqual({
      remote: 'origin',
      dryRun: false,
      force: false,
    });
  });

  it('parses remote and mode flags', () => {
    const parsed = typedGitPrune.parseArgs([
      'node',
      'script',
      '--remote',
      'upstream',
      '--dry-run',
      '--force',
    ]);
    expect(parsed).toEqual({
      remote: 'upstream',
      dryRun: true,
      force: true,
    });
  });

  it('strips origin ref prefixes', () => {
    expect(typedGitPrune.stripRemotePrefix('origin/main', 'origin')).toBe('main');
    expect(typedGitPrune.stripRemotePrefix('origin/feature/test', 'origin')).toBe('feature/test');
    expect(typedGitPrune.stripRemotePrefix('origin/HEAD', 'origin')).toBeNull();
    expect(typedGitPrune.stripRemotePrefix('upstream/main', 'origin')).toBeNull();
  });

  it('selects local branches absent on remote and skips current branch', () => {
    const selected = typedGitPrune.selectBranchesToDelete(
      ['main', 'feature/a', 'feature/b', 'wip/local-only'],
      ['main', 'feature/b'],
      'feature/a'
    );

    expect(selected).toEqual(['wip/local-only']);
  });

  it('supports dry-run branch deletion selection without side effects', () => {
    const result = typedGitPrune.deleteBranches(['x', 'y'], { dryRun: true, force: false });
    expect(result.deleted).toEqual(['x', 'y']);
    expect(result.skipped).toEqual([]);
  });
});
