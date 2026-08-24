#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const MINIMUM_NPM_VERSION = '12.0.1';
export const SUPPORTED_NODE_VERSIONS = '^22.22.2 || ^24.15.0 || >=26.0.0';
export const PINNED_RUST_VERSION = '1.97.1';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function parseVersion(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

export function isVersionAtLeast(value, minimum) {
  const current = parseVersion(value);
  const required = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function isSupportedNodeVersion(value) {
  const [major] = parseVersion(value);
  if (major === 22) return isVersionAtLeast(value, '22.22.2');
  if (major === 24) return isVersionAtLeast(value, '24.15.0');
  return major >= 26;
}

export function hasPinnedRustToolchain(output, version = PINNED_RUST_VERSION) {
  return String(output)
    .split(/\r?\n/u)
    .some(
      (line) => line === version || line.startsWith(`${version}-`) || line.startsWith(`${version} `)
    );
}

export function npmUpdateArguments(cachePath) {
  return [
    'update',
    '--package-lock-only',
    '--ignore-scripts',
    '--min-release-age=3',
    `--cache=${cachePath}`,
  ];
}

export function commandRequiresShell(command, platform = process.platform) {
  return platform === 'win32' && /\.cmd$/iu.test(command);
}

function run(command, args, { cwd = process.cwd(), env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: commandRequiresShell(command),
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim() : '';
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}${detail ? `\n${detail}` : ''}`
    );
  }
  return capture ? result.stdout.trim() : '';
}

function readSnapshot(filePath) {
  try {
    return { existed: true, bytes: readFileSync(filePath) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { existed: false, bytes: null };
    throw error;
  }
}

function snapshotMatches(filePath, snapshot) {
  const current = readSnapshot(filePath);
  return (
    current.existed === snapshot.existed &&
    (!current.existed || current.bytes.equals(snapshot.bytes))
  );
}

export function restoreSnapshot(filePath, snapshot, expectedCurrent = null) {
  if (expectedCurrent && !snapshotMatches(filePath, expectedCurrent)) {
    throw new Error('Concurrent package-lock edit detected; refusing to overwrite ' + filePath);
  }
  if (!snapshot.existed) {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
    return;
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.restore`;
  writeFileSync(temporaryPath, snapshot.bytes, { flag: 'wx' });
  try {
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function acquireUpdateLock(root) {
  const lockPath = path.join(root, '.npm-safe-update.lock');
  const owner = `${process.pid}:${randomUUID()}\n`;
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, owner);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    }
    if (error?.code === 'EEXIST') {
      throw new Error(`Another npm dependency update holds ${lockPath}`, { cause: error });
    }
    throw error;
  }
  closeSync(descriptor);
  return () => {
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === owner) {
      rmSync(lockPath, { force: true });
    }
  };
}

export function assertUpdateEnvironment() {
  const nodeVersion = process.versions.node;
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new Error(`Node.js ${SUPPORTED_NODE_VERSIONS} required; found ${nodeVersion}`);
  }

  const npmVersion = run(npmCommand, ['--version'], { capture: true });
  if (!isVersionAtLeast(npmVersion, MINIMUM_NPM_VERSION)) {
    throw new Error(`npm ${MINIMUM_NPM_VERSION}+ required; found ${npmVersion}`);
  }

  const rustToolchains = run('rustup', ['toolchain', 'list'], { capture: true });
  if (!hasPinnedRustToolchain(rustToolchains)) {
    throw new Error(
      `Rust ${PINNED_RUST_VERSION} must already be installed before updating dependencies`
    );
  }
}

function main() {
  assertUpdateEnvironment();
  const root = process.cwd();
  const packageLock = path.join(root, 'package-lock.json');
  const releaseUpdateLock = acquireUpdateLock(root);
  let tempRoot;

  try {
    const snapshot = readSnapshot(packageLock);
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-update-'));
    const cachePath = path.join(tempRoot, 'cache');
    const env = {
      ...process.env,
      npm_config_cache: cachePath,
      npm_config_ignore_scripts: 'true',
      npm_config_min_release_age: '3',
    };

    try {
      run(npmCommand, npmUpdateArguments(cachePath), { cwd: root, env });
    } catch (error) {
      restoreSnapshot(packageLock, snapshot);
      throw error;
    }

    const candidate = readSnapshot(packageLock);
    let auditError;
    try {
      run(npmCommand, ['audit', '--audit-level=high', '--ignore-scripts', '--cache=' + cachePath], {
        cwd: root,
        env,
      });
    } catch (error) {
      auditError = error;
    }

    if (!snapshotMatches(packageLock, candidate)) {
      throw new Error(
        'Concurrent package-lock edit detected after npm update; preserved ' + packageLock,
        { cause: auditError }
      );
    }
    if (auditError) {
      restoreSnapshot(packageLock, snapshot, candidate);
      throw auditError;
    }
  } finally {
    try {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    } finally {
      releaseUpdateLock();
    }
  }
}

const isMainModule =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`npm-safe-update: ${error.message}`);
    process.exitCode = 1;
  }
}
