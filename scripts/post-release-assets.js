#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDirectExecution as isModuleDirectExecution, pathsEqual } from './direct-execution.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RELEASE_DIR = path.join(__dirname, '..', 'release');

const BUILD_ONLY_DIRECTORIES = ['app', 'appimage', 'deb', 'dmg', 'macos', 'msi', 'nsis', 'rpm'];
const BUILD_ONLY_FILES = [];
const CLI_FLAG = '--finalize-release-assets';

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

function isDirectExecution(argv = process.argv, platform = process.platform) {
  if (argv.includes(CLI_FLAG)) return true;
  return isModuleDirectExecution(import.meta.url, argv, platform);
}

function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }
  const entries = fs.readdirSync(releaseDir);
  if (entries.length === 0) throw new Error(`release directory is empty: ${releaseDir}`);
  return entries;
}

function verifyCopiedPath(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  let destination;
  try {
    destination = fs.statSync(destinationPath);
  } catch {
    throw new Error(`mirrored path is missing: ${destinationPath}`);
  }
  if (source.isDirectory() !== destination.isDirectory()) {
    throw new Error(`mirrored path type differs: ${destinationPath}`);
  }
  if (source.isFile() && source.size !== destination.size) {
    throw new Error(
      `mirrored file size differs: ${destinationPath} (${destination.size} bytes; expected ${source.size})`
    );
  }
  if (source.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath)) {
      verifyCopiedPath(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
  }
}

function copyReleaseAssets(releaseDir = RELEASE_DIR, destination) {
  if (!destination) throw new Error('AFTER_PACK_LOC is empty');
  const resolvedReleaseDir = path.resolve(releaseDir);
  const resolvedDestination = path.resolve(destination);
  if (pathsEqual(resolvedDestination, resolvedReleaseDir)) {
    throw new Error('AFTER_PACK_LOC cannot be the release directory');
  }
  const releasePrefix = `${resolvedReleaseDir}${path.sep}`;
  const destinationForComparison =
    process.platform === 'win32' ? resolvedDestination.toLowerCase() : resolvedDestination;
  const releasePrefixForComparison =
    process.platform === 'win32' ? releasePrefix.toLowerCase() : releasePrefix;
  if (destinationForComparison.startsWith(releasePrefixForComparison)) {
    throw new Error('AFTER_PACK_LOC cannot be inside the release directory');
  }
  fs.mkdirSync(resolvedDestination, { recursive: true });
  const entries = getReleaseEntries(resolvedReleaseDir);
  for (const entry of entries) {
    const sourcePath = path.join(resolvedReleaseDir, entry);
    const destinationPath = path.join(resolvedDestination, entry);
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false });
    verifyCopiedPath(sourcePath, destinationPath);
  }
  return entries.length;
}

function run({ releaseDir = RELEASE_DIR, env = process.env } = {}) {
  cleanReleaseArtifacts(releaseDir);
  const destination = getAfterPackLocation(env);
  if (!destination) return { mirrored: false, destination: null };
  const copiedEntries = copyReleaseAssets(releaseDir, destination);
  return { mirrored: true, destination: path.resolve(destination), copiedEntries };
}

if (isDirectExecution()) {
  try {
    const result = run();
    if (result.mirrored) {
      console.log(
        `Mirrored and verified ${result.copiedEntries} cleaned release entries to: ${result.destination}`
      );
    } else {
      console.warn(
        'WARNING: Cleaned release assets, but AFTER_PACK_LOC is not set; mirror intentionally skipped.'
      );
    }
  } catch (error) {
    console.error(`Failed to finalize release assets: ${error?.message || error}`);
    console.error(`Source release directory: ${RELEASE_DIR}`);
    console.error(`Configured AFTER_PACK_LOC: ${JSON.stringify(getAfterPackLocation())}`);
    console.error(`Platform: ${process.platform}; Node: ${process.version}; cwd: ${process.cwd()}`);
    console.error(
      'The following git reset/clean was blocked. Correct the problem and rerun npm run release:finalize.'
    );
    process.exit(1);
  }
}

export {
  RELEASE_DIR,
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  CLI_FLAG,
  cleanReleaseArtifacts,
  getAfterPackLocation,
  pathsEqual,
  isDirectExecution,
  getReleaseEntries,
  verifyCopiedPath,
  copyReleaseAssets,
  run,
};
