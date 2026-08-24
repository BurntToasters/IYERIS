import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

function prepareFinalizeHarness(version) {
  const root = makeTemporaryDirectory();
  const scriptsDir = path.join(root, 'scripts');
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(releaseDir);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'iyeris', version }));
  const repoScripts = path.dirname(fileURLToPath(import.meta.url));
  for (const name of [
    'post-release-assets.js',
    'finalize-release-assets.js',
    'direct-execution.js',
  ]) {
    fs.copyFileSync(path.join(repoScripts, name), path.join(scriptsDir, name));
  }
  fs.writeFileSync(path.join(releaseDir, 'IYERIS-Win-x64.exe'), 'installer');
  return { scriptsDir, releaseDir };
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

test('Windows basename match is enough to run the finalizer', () => {
  assert.equal(
    isDirectExecution(['node', 'D:\\mapped\\IYERIS\\scripts\\POST-RELEASE-ASSETS.JS'], 'win32'),
    true
  );
  assert.equal(
    isDirectExecution(['node', 'D:\\mapped\\IYERIS\\scripts\\gpg-sign.js'], 'win32'),
    false
  );
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

  assert.equal(isBetaReleaseVersion(STABLE_VERSION), false);
  assert.equal(isBetaReleaseVersion(BETA_VERSION), true);
  assert.equal(shouldSkipBetaMirror({}, STABLE_VERSION), false);
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

  assert.deepEqual(
    run({
      releaseDir,
      env: {},
      version: BETA_VERSION,
    }),
    {
      mirrored: false,
      destination: null,
      skippedBetaMirror: true,
    }
  );

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

test('release finalization runs the observable mirror command first', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert.match(packageJson.scripts.r, /origin\/main/);
  assert.match(packageJson.scripts.b, /origin\/beta/);
  assert.match(packageJson.scripts['release:mirror'], /scripts\/finalize-release-assets\.js/);
  assert.match(packageJson.scripts['release:finalize'], /^npm run release:mirror &&/);
  assert.match(packageJson.scripts['release:win'], /release:win:continue/);
  assert.match(packageJson.scripts['release:mac'], /release:mac:continue/);
  assert.match(packageJson.scripts['release:linux:x64'], /release:linux:x64:continue/);
});

test('dedicated runner copies stable artifacts without an argv path guard', () => {
  const { scriptsDir } = prepareFinalizeHarness(STABLE_VERSION);
  const destination = path.join(makeTemporaryDirectory(), 'mirror');

  const ran = spawnSync(process.execPath, [path.join(scriptsDir, 'finalize-release-assets.js')], {
    encoding: 'utf8',
    env: { ...process.env, AFTER_PACK_LOC: destination, SKIP_RELEASE_MIRROR: '' },
  });
  const combined = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
  assert.equal(ran.status, 0, combined);
  assert.match(combined, /\[release:mirror] starting/);
  assert.match(combined, /Mirrored and verified 1 cleaned release entries/);
  assert.equal(fs.readFileSync(path.join(destination, 'IYERIS-Win-x64.exe'), 'utf8'), 'installer');
});

test('dedicated runner skips the mirror for beta versions even when AFTER_PACK_LOC is set', () => {
  const { scriptsDir } = prepareFinalizeHarness(BETA_VERSION);
  const destination = path.join(makeTemporaryDirectory(), 'mirror');

  const ran = spawnSync(process.execPath, [path.join(scriptsDir, 'finalize-release-assets.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AFTER_PACK_LOC: destination,
      SKIP_RELEASE_MIRROR: '',
      OVERRIDE_BETA_MIRROR_SKIP: '',
    },
  });
  const combined = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
  assert.equal(ran.status, 0, combined);
  assert.match(combined, /skipping AFTER_PACK_LOC mirror/);
  assert.equal(fs.existsSync(path.join(destination, 'IYERIS-Win-x64.exe')), false);
});

test('dedicated runner refuses a stable finalize when AFTER_PACK_LOC is unset', () => {
  const { scriptsDir, releaseDir } = prepareFinalizeHarness(STABLE_VERSION);

  const ran = spawnSync(process.execPath, [path.join(scriptsDir, 'finalize-release-assets.js')], {
    encoding: 'utf8',
    env: { ...process.env, AFTER_PACK_LOC: '', SKIP_RELEASE_MIRROR: '' },
  });
  const combined = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
  assert.equal(ran.status, 1, combined);
  assert.match(combined, /Stable release .* requires AFTER_PACK_LOC/);
  assert.equal(fs.existsSync(path.join(releaseDir, 'IYERIS-Win-x64.exe')), true);
});
