// Type declarations for the plain-JS branch pruning helper so its test can be
// type-checked under `strict` like the rest of the suite. Mirrors the exports of
// git-prune-local-branches.js. Same pattern as scripts/release-session.d.ts.

export interface GitPruneArgs {
  remote: string;
  dryRun: boolean;
  force: boolean;
}

export interface SkippedBranch {
  branch: string;
  reason: string;
}

export interface DeleteBranchesResult {
  deleted: string[];
  skipped: SkippedBranch[];
}

export function parseArgs(argv: string[]): GitPruneArgs;
export function stripRemotePrefix(ref: string, remote: string): string | null;
export function selectBranchesToDelete(
  localBranches: string[],
  remoteBranches: string[],
  currentBranch: string
): string[];
export function deleteBranches(
  branches: string[],
  options?: { force?: boolean; dryRun?: boolean }
): DeleteBranchesResult;
export function main(argv?: string[]): number;
