#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const FLATPAK_BUILD_DIR_PREFIX = 'flatpak-build';
const TAURI_TARGET_DIR = path.join('src-tauri', 'target');

const CLEAN_TARGETS = {
  clean: ['dist'],
  'clean-release': ['release'],
  'clean-release-artifacts': ['release', 'dist', 'msstore'],
  'clean-flatpak': ['flatpak-repo'],
  'clean-all': ['dist', 'release', 'msstore', 'flatpak-repo'],
};

function listFlatpakBuildDirs(cwd) {
  try {
    return fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === FLATPAK_BUILD_DIR_PREFIX ||
            entry.name.startsWith(`${FLATPAK_BUILD_DIR_PREFIX}-`))
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listTauriBundleDirs(cwd) {
  const targetRoot = path.join(cwd, TAURI_TARGET_DIR);
  if (!fs.existsSync(targetRoot)) return [];
  const results = [];
  const addIfDir = (fullPath) => {
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory())
        results.push(path.relative(cwd, fullPath));
    } catch {}
  };
  addIfDir(path.join(targetRoot, 'release', 'bundle'));
  addIfDir(path.join(targetRoot, 'debug', 'bundle'));
  try {
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = path.join(targetRoot, entry.name);
      addIfDir(path.join(base, 'release', 'bundle'));
      addIfDir(path.join(base, 'debug', 'bundle'));
      addIfDir(path.join(base, 'bundle'));
    }
  } catch {}
  return Array.from(new Set(results));
}

function getCleanTargets(mode, cwd) {
  const baseTargets = CLEAN_TARGETS[mode];
  if (!baseTargets) throw new Error(`Unknown clean mode "${mode}"`);
  if (mode === 'clean-release-artifacts')
    return Array.from(new Set([...baseTargets, ...listTauriBundleDirs(cwd)]));
  if (mode === 'clean-flatpak')
    return Array.from(new Set([...baseTargets, ...listFlatpakBuildDirs(cwd)]));
  if (mode === 'clean-all')
    return Array.from(
      new Set([...baseTargets, ...listFlatpakBuildDirs(cwd), ...listTauriBundleDirs(cwd)])
    );
  return baseTargets;
}

function cleanDirs(mode) {
  const cwd = process.cwd();
  const dirs = getCleanTargets(mode, cwd);
  for (const relativeDir of dirs) {
    const dir = path.resolve(cwd, relativeDir);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`Failed to clean "${relativeDir}": ${error?.message || error}`);
    }
  }
}

const mode = process.argv[2];
if (
  mode === 'clean' ||
  mode === 'clean-release' ||
  mode === 'clean-release-artifacts' ||
  mode === 'clean-flatpak' ||
  mode === 'clean-all'
) {
  cleanDirs(mode);
  process.exit(0);
}

console.error(
  'Usage: node scripts/dist-tools.js <clean|clean-release|clean-release-artifacts|clean-flatpak|clean-all>'
);
process.exit(1);
