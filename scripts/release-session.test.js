import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  createReleaseSession,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
  releaseWorkingTreeSha256,
  recordSuccessfulQualityGate,
  verifyQualityGate,
} from './release-session.js';

test('isAcceptableReleaseWorkingTree allows bootstrap-only drift', () => {
  assert.equal(isAcceptableReleaseWorkingTree(''), true);
  assert.equal(isAcceptableReleaseWorkingTree(' M run.rosie.iyeris.metainfo.xml'), true);
  assert.equal(isAcceptableReleaseWorkingTree(' M src-tauri/Cargo.lock'), true);
  assert.equal(
    isAcceptableReleaseWorkingTree(' M src-tauri/gen/schemas/windows-schema.json'),
    true
  );
  assert.equal(isAcceptableReleaseWorkingTree(' M src-tauri/gen/schemas/linux-schema.json'), true);
  assert.equal(isAcceptableReleaseWorkingTree(' M package.json'), false);
});

test('parsePorcelainPaths keeps git XY status spacing', () => {
  assert.deepEqual(parsePorcelainPaths(' M src-tauri/Cargo.lock'), ['src-tauri/Cargo.lock']);
  assert.deepEqual(parsePorcelainPaths(' M src-tauri/gen/schemas/linux-schema.json'), [
    'src-tauri/gen/schemas/linux-schema.json',
  ]);
});

test('createReleaseSession rejects when quality gate proof is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-release-'));
  try {
    assert.throws(() => createReleaseSession(root), /quality-gate proof/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release working-tree fingerprint changes when checkout contents change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-release-fingerprint-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'IYERIS Test'], { cwd: root });
    const filePath = path.join(root, 'tracked.txt');
    fs.writeFileSync(filePath, 'before');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

    const before = releaseWorkingTreeSha256(root);
    fs.writeFileSync(filePath, 'after');
    assert.notEqual(releaseWorkingTreeSha256(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Failure inventory before changing session identity:
// - tracked schemas rewritten by a native build invalidate the prepared session;
// - schemas added or removed by another target invalidate the prepared session;
// - excluding generated schemas accidentally permits source, config, metainfo, or lock drift;
// - the fix bypasses missing, expired, or environment-mismatched session checks.
const regressionEvidence = [];
const regressionReport = new URL('../coverage/release-session-regression.json', import.meta.url);
after(() => {
  fs.mkdirSync(new URL('../coverage/', import.meta.url), { recursive: true });
  fs.writeFileSync(
    regressionReport,
    `${JSON.stringify({ command: 'node --test scripts/release-session.test.js', cases: regressionEvidence }, null, 2)}\n`
  );
});

function releaseFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-release-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ version: '1.0.0', type: 'module' }),
    'package-lock.json': '{}',
    'src-tauri/Cargo.lock': '# fixture lock',
    'src-tauri/tauri.conf.json': '{}',
    'src-tauri/src/main.rs': 'fn main() {}',
    'src-tauri/gen/schemas/acl-manifests.json': '{}',
    'src-tauri/gen/schemas/desktop-schema.json': '{}',
    'src-tauri/gen/schemas/macOS-schema.json': '{}',
    'run.rosie.iyeris.metainfo.xml': '<component/>',
    '.gitignore': 'coverage/\nrelease/\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(
    new URL('./release-session.js', import.meta.url),
    path.join(root, 'scripts/release-session.js')
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root }
  );
  // Match bootstrap drift already present before preparation on a builder VM.
  fs.appendFileSync(path.join(root, 'run.rosie.iyeris.metainfo.xml'), '\n');
  assert.equal(recordSuccessfulQualityGate(root), true);
  const cli = (...args) =>
    execFileSync(process.execPath, ['scripts/release-session.js', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  cli('start');
  return { root, cli };
}

for (const scenario of ['rewritten', 'added', 'deleted']) {
  test(`prepared release CLI accepts ${scenario} generated schemas`, (t) => {
    const { root, cli } = releaseFixture(t);
    const before = releaseWorkingTreeSha256(root);
    const schemaDirectory = path.join(root, 'src-tauri/gen/schemas');
    if (scenario === 'rewritten') {
      for (const name of ['acl-manifests.json', 'desktop-schema.json', 'macOS-schema.json']) {
        fs.writeFileSync(
          path.join(schemaDirectory, name),
          '{"generatedBy":"native-release-build"}'
        );
      }
    } else if (scenario === 'added') {
      fs.writeFileSync(path.join(schemaDirectory, 'linux-schema.json'), '{}');
    } else {
      fs.rmSync(path.join(schemaDirectory, 'macOS-schema.json'));
    }
    const evidence = { scenario: `schemas ${scenario}`, passed: false };
    regressionEvidence.push(evidence);
    assert.equal(releaseWorkingTreeSha256(root), before);
    assert.doesNotThrow(() => verifyQualityGate(root));
    assert.match(cli(), /release-session: ok/);
    evidence.passed = true;
  });
}

for (const file of [
  'src-tauri/src/main.rs',
  'src-tauri/tauri.conf.json',
  'run.rosie.iyeris.metainfo.xml',
  'package-lock.json',
  'src-tauri/Cargo.lock',
]) {
  test(`prepared release CLI still rejects changes to ${file}`, (t) => {
    const { root, cli } = releaseFixture(t);
    fs.appendFileSync(path.join(root, file), '\nchanged');
    const evidence = { scenario: `reject drift: ${file}`, passed: false };
    regressionEvidence.push(evidence);
    assert.throws(cli, /does not match this checkout\/environment/);
    evidence.passed = true;
  });
}

for (const scenario of ['missing', 'expired', 'environment mismatch']) {
  test(`prepared release CLI still rejects ${scenario} sessions`, (t) => {
    const { root, cli } = releaseFixture(t);
    const sessionPath = path.join(root, 'release/.build-session.json');
    if (scenario === 'missing') {
      fs.rmSync(sessionPath);
    } else {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (scenario === 'expired') session.startedAt = Date.now() - 48 * 60 * 60 * 1000;
      else session.platform = 'another-platform';
      fs.writeFileSync(sessionPath, JSON.stringify(session));
    }
    const evidence = { scenario: `reject session: ${scenario}`, passed: false };
    regressionEvidence.push(evidence);
    assert.throws(cli, /release-session: FAILED/);
    evidence.passed = true;
  });
}

test('moving source into the generated directory still invalidates the session', (t) => {
  const { root, cli } = releaseFixture(t);
  fs.renameSync(
    path.join(root, 'src-tauri/src/main.rs'),
    path.join(root, 'src-tauri/gen/schemas/main.rs')
  );
  const evidence = { scenario: 'reject source moved into schemas', passed: false };
  regressionEvidence.push(evidence);
  assert.throws(cli, /workingTreeSha256 does not match/);
  evidence.passed = true;
});
