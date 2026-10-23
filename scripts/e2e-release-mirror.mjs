import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Failure inventory (before implementation): session/dotfile metadata reaches the
// share; native recursive copy aborts; SMB rejects copyFile with EPERM/EACCES;
// fallback hides a real I/O/write error; same-sized corruption passes verification;
// recursive artifacts or signatures are lost; beta policy changes; metadata alone
// counts as a successful mirror. Exercise the actual CLI in disposable checkouts.
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repositoryRoot, 'coverage', 'release-mirror-e2e');
fs.mkdirSync(output, { recursive: true });
const evidence = fs.mkdtempSync(path.join(output, 'run-'));
const results = [];
const payload = Buffer.from('signed installer fixture\0\xff', 'latin1');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

for (const scenario of [
  'metadata',
  'no-native-recursion',
  'EPERM',
  'EACCES',
  'EIO',
  'write-denied',
  'corrupt-copy',
  'metadata-only',
  'beta',
  'beta-override',
]) {
  const root = path.join(evidence, scenario);
  const release = path.join(root, 'release');
  const mirror = path.join(root, 'mirror');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(release);
  fs.mkdirSync(mirror);
  for (const name of [
    'finalize-release-assets.js',
    'post-release-assets.js',
    'direct-execution.js',
  ]) {
    fs.copyFileSync(path.join(repositoryRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      version: scenario.startsWith('beta') ? '3.0.5-beta.1' : '3.0.5',
    })
  );
  fs.writeFileSync(path.join(release, '.build-session.json'), '{"privateSession":true}');
  fs.writeFileSync(path.join(release, '.other-build-marker'), 'private');
  fs.mkdirSync(path.join(release, 'nsis'));
  fs.writeFileSync(path.join(release, 'nsis', 'build-only.exe'), 'build');
  // A conflicting destination marker makes accidental metadata copies fail on
  // every host, without requiring a Windows share to reproduce the regression.
  const hasMarkerTrap = ['metadata', 'beta', 'beta-override'].includes(scenario);
  if (hasMarkerTrap) fs.mkdirSync(path.join(mirror, '.build-session.json'));
  fs.writeFileSync(path.join(mirror, 'other-platform.dmg'), 'preserve');
  if (scenario !== 'metadata-only') {
    fs.writeFileSync(path.join(release, 'IYERIS-Windows-x64.exe'), payload);
    fs.writeFileSync(path.join(release, 'IYERIS-Windows-x64.exe.sig'), 'signature');
    fs.mkdirSync(path.join(release, 'extras'));
    fs.writeFileSync(path.join(release, 'extras', 'checksums.txt'), 'checksums');
  }
  const preload = path.join(root, 'faults.mjs');
  fs.writeFileSync(
    preload,
    `
import fs from 'node:fs';
import path from 'node:path';
const scenario = ${JSON.stringify(scenario)};
const originalCopy = fs.copyFileSync;
const originalWrite = fs.writeFileSync;
const injected = (code) => Object.assign(new Error('injected ' + code), { code });
if (scenario === 'no-native-recursion') {
  fs.cpSync = () => { throw new Error('native recursive copy must not run'); };
}
fs.copyFileSync = (source, destination, ...args) => {
  if (path.basename(source) === 'IYERIS-Windows-x64.exe') {
    if (['EPERM', 'EACCES', 'EIO'].includes(scenario)) throw injected(scenario);
    if (scenario === 'write-denied') throw injected('EPERM');
    if (scenario === 'corrupt-copy') {
      return originalWrite(destination, Buffer.alloc(fs.statSync(source).size));
    }
  }
  return originalCopy(source, destination, ...args);
};
if (scenario === 'write-denied') {
  fs.writeFileSync = (destination, ...args) => {
    if (String(destination).endsWith('.exe')) throw injected('EACCES');
    return originalWrite(destination, ...args);
  };
}
`
  );
  const child = spawnSync(
    process.execPath,
    ['--import', preload, path.join(root, 'scripts', 'finalize-release-assets.js')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        AFTER_PACK_LOC: mirror,
        SKIP_RELEASE_MIRROR: '',
        OVERRIDE_BETA_MIRROR_SKIP: scenario === 'beta-override' ? '1' : '',
      },
    }
  );
  fs.writeFileSync(path.join(root, 'cli.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`);
  const shouldFail = ['EIO', 'write-denied', 'corrupt-copy', 'metadata-only'].includes(scenario);
  try {
    assert.equal(child.error, undefined);
    assert.equal(child.status, shouldFail ? 1 : 0, child.stderr);
    if (shouldFail) {
      assert.match(child.stderr, /FAILED:/);
      const expectedFailure = {
        EIO: /injected EIO/,
        'write-denied': /injected EACCES/,
        'corrupt-copy': /mirrored file hash differs/,
        'metadata-only': /release directory is empty/,
      };
      assert.match(child.stderr, expectedFailure[scenario]);
    } else if (scenario === 'beta') {
      assert.equal(fs.existsSync(path.join(mirror, 'IYERIS-Windows-x64.exe')), false);
    } else {
      assert.equal(
        digest(fs.readFileSync(path.join(mirror, 'IYERIS-Windows-x64.exe'))),
        digest(payload)
      );
      assert.equal(
        fs.readFileSync(path.join(mirror, 'IYERIS-Windows-x64.exe.sig'), 'utf8'),
        'signature'
      );
      assert.equal(
        fs.readFileSync(path.join(mirror, 'extras', 'checksums.txt'), 'utf8'),
        'checksums'
      );
      assert.equal(fs.existsSync(path.join(mirror, '.other-build-marker')), false);
      assert.equal(fs.existsSync(path.join(mirror, 'nsis')), false);
    }
    if (hasMarkerTrap) {
      assert.equal(fs.statSync(path.join(mirror, '.build-session.json')).isDirectory(), true);
    } else {
      assert.equal(fs.existsSync(path.join(mirror, '.build-session.json')), false);
    }
    assert.equal(fs.readFileSync(path.join(mirror, 'other-platform.dmg'), 'utf8'), 'preserve');
    results.push({ scenario, passed: true, status: child.status });
  } catch (error) {
    results.push({ scenario, passed: false, status: child.status, error: error.message });
  }
}
const report = {
  platform: process.platform,
  node: process.version,
  artifactSha256: digest(payload),
  evidence,
  results,
};
fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Release mirror CLI: ${results.filter((result) => result.passed).length}/${results.length} passed; evidence: ${output}`
);
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
