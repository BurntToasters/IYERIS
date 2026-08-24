import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createReleaseSession,
  isAcceptableReleaseWorkingTree,
  parsePorcelainPaths,
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
