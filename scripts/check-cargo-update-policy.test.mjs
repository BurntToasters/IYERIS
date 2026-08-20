import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPolicyCheck } from './check-cargo-update-policy.mjs';

function createTempRepo() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'policy-scan-test-'));
  writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({
      name: 'test-pkg',
      scripts: {
        u: 'node scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml',
      },
    })
  );
  mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(tempDir, 'scripts', 'cargo-safe-update.mjs'),
    '// approved implementation\ncargo update\n'
  );
  return tempDir;
}

test('1. allows guarded update in package.json and approved implementation', () => {
  const root = createTempRepo();
  try {
    const logs = [];
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, true);
    assert.equal(errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('2. blocks raw cargo update in package.json', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          u: 'cd src-tauri && cargo update',
        },
      })
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('raw Cargo mutation')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('3. blocks guarded plus raw update in one chained command', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          u: 'node scripts/cargo-safe-update.mjs && cargo update',
        },
      })
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('raw Cargo mutation')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('4. blocks recursive nested script in scripts/deps/rust/update.sh', () => {
  const root = createTempRepo();
  try {
    const nested = path.join(root, 'scripts', 'deps', 'rust');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'update.sh'), '#!/bin/sh\ncargo update\n');
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('scripts/deps/rust/update.sh')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('5. blocks Unix lock deletion (rm -f src-tauri/Cargo.lock)', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'scripts', 'reset.sh'),
      '#!/bin/sh\nrm -f src-tauri/Cargo.lock\n'
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('Cargo.lock deletion')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('6. blocks PowerShell lock deletion (Remove-Item -Force src-tauri/Cargo.lock)', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'scripts', 'reset.ps1'),
      'Remove-Item -Force src-tauri/Cargo.lock\n'
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('Cargo.lock deletion')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('7. blocks cmd/batch deletion (del /f src-tauri\\Cargo.lock)', () => {
  const root = createTempRepo();
  try {
    writeFileSync(path.join(root, 'scripts', 'reset.cmd'), 'del /f src-tauri\\Cargo.lock\n');
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('Cargo.lock deletion')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('8. blocks batch file in tools/update-deps.bat', () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, 'tools'), { recursive: true });
    writeFileSync(path.join(root, 'tools', 'update-deps.bat'), '@echo off\ncargo update\n');
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('tools/update-deps.bat')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('9. blocks Taskfile mutation (Taskfile.yml with cargo update)', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'Taskfile.yml'),
      'version: "3"\ntasks:\n  deps:\n    cmds:\n      - cargo update\n'
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('Taskfile.yml')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('10. blocks Taskfile lock deletion (Taskfile.yaml with rm Cargo.lock)', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'Taskfile.yaml'),
      'version: "3"\ntasks:\n  clean:\n    cmds:\n      - rm Cargo.lock\n'
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('Taskfile.yaml')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('11. allows documentation files containing cargo update', () => {
  const root = createTempRepo();
  try {
    writeFileSync(
      path.join(root, 'README.md'),
      'To update dependencies, run `cargo update` or `npm run u`.\n'
    );
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('12. requires exact path exclusion (tools/cargo-safe-update.mjs is blocked)', () => {
  const root = createTempRepo();
  try {
    mkdirSync(path.join(root, 'tools'), { recursive: true });
    writeFileSync(path.join(root, 'tools', 'cargo-safe-update.mjs'), 'cargo update\n');
    const errors = [];
    const ok = runPolicyCheck({
      root,
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('tools/cargo-safe-update.mjs')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
