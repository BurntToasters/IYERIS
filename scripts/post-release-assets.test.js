import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isDirectExecution as isModuleDirectExecution } from './direct-execution.js';
import {
  CLI_FLAG,
  copyReleaseAssets,
  isBetaReleaseVersion,
  isDirectExecution,
  pathsEqual,
  run,
  shouldSkipBetaMirror,
} from './post-release-assets.js';

const STABLE_VERSION = '3.0.4';
const BETA_VERSION = '3.0.4-beta.1';

test('module entrypoint comparison tolerates Windows path casing', () => {
  const scriptUrl = new URL('./post-release-assets.js', import.meta.url);

  assert.equal(
    isModuleDirectExecution(
      scriptUrl.href,
      ['node', fileURLToPath(scriptUrl).toUpperCase()],
      'win32'
    ),
    true
  );
});

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-finalize-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('recognizes Windows paths without case sensitivity', () => {
  assert.equal(
    pathsEqual('C:/Users/Main/IYERIS/release', 'c:/users/main/iyeris/release', 'win32'),
    true
  );
});

test('explicit finalizer flag does not depend on path identity', () => {
  assert.equal(isDirectExecution(['node', 'unrelated.js', CLI_FLAG], 'win32'), true);
});

test('cleans, mirrors, and verifies release entries', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  const destination = path.join(root, 'mirror');
  fs.mkdirSync(path.join(releaseDir, 'nsis'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'nsis', 'build-only.exe'), 'build');
  fs.writeFileSync(path.join(releaseDir, 'IYERIS-Windows-x64.exe'), 'installer');

  assert.deepEqual(
    run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
      version: STABLE_VERSION,
    }),
    {
      mirrored: true,
      destination,
      copiedEntries: 1,
      skippedBetaMirror: false,
    }
  );
  assert.equal(fs.existsSync(path.join(releaseDir, 'nsis')), false);
  assert.equal(
    fs.readFileSync(path.join(destination, 'IYERIS-Windows-x64.exe'), 'utf8'),
    'installer'
  );
});

test('skips AFTER_PACK_LOC mirroring for beta versions unless overridden', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  const destination = path.join(root, 'mirror');
  fs.mkdirSync(path.join(releaseDir, 'nsis'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'nsis', 'build-only.exe'), 'build');
  fs.writeFileSync(path.join(releaseDir, 'IYERIS-Windows-x64.exe'), 'installer');

  assert.equal(isBetaReleaseVersion(BETA_VERSION), true);
  assert.equal(shouldSkipBetaMirror({}, BETA_VERSION), true);
  assert.equal(shouldSkipBetaMirror({ OVERRIDE_BETA_MIRROR_SKIP: '1' }, BETA_VERSION), false);

  assert.deepEqual(
    run({
      releaseDir,
      env: { AFTER_PACK_LOC: destination },
      version: BETA_VERSION,
    }),
    {
      mirrored: false,
      destination: null,
      skippedBetaMirror: true,
    }
  );
  assert.equal(fs.existsSync(path.join(releaseDir, 'nsis')), false);
  assert.equal(fs.existsSync(path.join(destination, 'IYERIS-Windows-x64.exe')), false);

  fs.writeFileSync(path.join(releaseDir, 'IYERIS-Windows-x64.exe'), 'installer');
  assert.deepEqual(
    run({
      releaseDir,
      env: {
        AFTER_PACK_LOC: destination,
        OVERRIDE_BETA_MIRROR_SKIP: '1',
      },
      version: BETA_VERSION,
    }),
    {
      mirrored: true,
      destination,
      copiedEntries: 1,
      skippedBetaMirror: false,
    }
  );
});

test('fails instead of claiming success when release directory is missing', () => {
  const root = makeTemporaryDirectory();
  assert.throws(
    () => copyReleaseAssets(path.join(root, 'missing'), path.join(root, 'mirror')),
    /release directory does not exist/
  );
});

test('rejects a mirror inside the release directory', () => {
  const root = makeTemporaryDirectory();
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir);
  fs.writeFileSync(path.join(releaseDir, 'artifact.exe'), 'artifact');
  assert.throws(
    () => copyReleaseAssets(releaseDir, path.join(releaseDir, 'mirror')),
    /cannot be inside the release directory/
  );
});
