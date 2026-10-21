import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createReleaseSession,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
  releaseWorkingTreeSha256,
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
