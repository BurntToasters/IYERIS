#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RELEASE_DIR = path.join(__dirname, '..', 'release');

const BUILD_ONLY_DIRECTORIES = ['app', 'appimage', 'deb', 'dmg', 'macos', 'msi', 'nsis', 'rpm'];
const BUILD_ONLY_FILES = [];

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function cleanReleaseArtifacts(releaseDir = RELEASE_DIR) {
  for (const dir of BUILD_ONLY_DIRECTORIES) removePath(path.join(releaseDir, dir));
  for (const file of BUILD_ONLY_FILES) removePath(path.join(releaseDir, file));
}

function getAfterPackLocation(env = process.env) {
  const value = env.AFTER_PACK_LOC;
  if (typeof value !== 'string') return '';
  return value.trim();
}

function copyReleaseAssets(releaseDir = RELEASE_DIR, destination) {
  if (!destination || !fs.existsSync(releaseDir)) return;
  const resolvedReleaseDir = path.resolve(releaseDir);
  const resolvedDestination = path.resolve(destination);
  if (resolvedDestination === resolvedReleaseDir) return;
  if (resolvedDestination.startsWith(`${resolvedReleaseDir}${path.sep}`)) {
    throw new Error('AFTER_PACK_LOC cannot be inside the release directory');
  }
  fs.mkdirSync(resolvedDestination, { recursive: true });
  for (const entry of fs.readdirSync(releaseDir)) {
    const sourcePath = path.join(releaseDir, entry);
    const destinationPath = path.join(resolvedDestination, entry);
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false });
  }
}

function run({ releaseDir = RELEASE_DIR, env = process.env } = {}) {
  cleanReleaseArtifacts(releaseDir);
  const destination = getAfterPackLocation(env);
  if (!destination) return { mirrored: false, destination: null };
  copyReleaseAssets(releaseDir, destination);
  return { mirrored: true, destination: path.resolve(destination) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const result = run();
    if (result.mirrored) console.log(`Mirrored cleaned release assets to: ${result.destination}`);
    else console.log('Cleaned release assets; AFTER_PACK_LOC not set, mirror skipped.');
  } catch (error) {
    console.error(`Failed: ${error?.message || error}`);
    process.exit(1);
  }
}

export {
  RELEASE_DIR,
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  cleanReleaseArtifacts,
  getAfterPackLocation,
  copyReleaseAssets,
  run,
};
