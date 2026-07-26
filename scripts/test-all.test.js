import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createInitialResults,
  createStepPlan,
  isQualityGateClean,
  main,
  parseTest,
  printSummary,
  runCommand,
} from './test-all.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readScripts() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
}

function passingResults(plan, failing = []) {
  const results = createInitialResults(plan);
  for (const step of plan) {
    results[step.name].status = failing.includes(step.name) ? 'failed' : 'passed';
  }
  return results;
}

/** Drives main() with every side effect injected, recording the call order. */
function runGate({ failing = [], proofRecorded = true } = {}) {
  const calls = [];
  const plan = createStepPlan({ npm: 'npm' });
  const logs = [];
  const exitCode = main({
    plan,
    runStep: (step, results) => {
      calls.push(`run:${step.name}`);
      results[step.name].status = failing.includes(step.name) ? 'failed' : 'passed';
    },
    recordProof: () => {
      calls.push('recordProof');
      return proofRecorded;
    },
    clearProof: () => {
      calls.push('clearProof');
    },
    root: repoRoot,
    log: (line) => logs.push(String(line)),
  });
  return { calls, exitCode, logs, plan };
}

test('the release-asset suites are a gated plan step, not chained after the gate', () => {
  const plan = createStepPlan({ npm: 'npm' });
  const step = plan.find((entry) => entry.name === 'releaseAssets');
  assert.ok(step, 'releaseAssets must be part of the quality-gate step plan');
  assert.deepEqual(step.args, ['run', 'test:release-assets']);

  const scripts = readScripts();
  assert.equal(
    scripts['test:all'],
    'node scripts/test-all.js',
    'test:all must not chain checks after the runner; chained checks chain past the proof write'
  );
  assert.ok(
    !scripts['test:all'].includes('&&'),
    'anything chained onto test:all runs after recordSuccessfulQualityGate'
  );
  assert.match(scripts['test:release-assets'], /post-release-assets\.test\.js/);
  assert.match(scripts['test:release-assets'], /release-session\.test\.js/);
  assert.match(scripts['test:release-assets'], /test-all\.test\.js/);
});

test('the build/release scripts are linted by the gate', () => {
  const plan = createStepPlan({ npm: 'npm' });
  const step = plan.find((entry) => entry.name === 'lintScripts');
  assert.ok(step, 'scripts/ was previously unlinted; the gate must cover it');
  assert.deepEqual(step.args, ['run', 'lint:scripts']);

  const scripts = readScripts();
  assert.ok(scripts['lint:scripts'], 'lint:scripts must exist');
  assert.match(
    scripts['lint:scripts'],
    /--max-warnings 0/,
    'scripts lint must not tolerate warnings'
  );
  assert.match(scripts['lint'], /lint:scripts/, 'the umbrella lint script must include scripts/');
});

test('rust formatting is gated the same way the JS side is', () => {
  const plan = createStepPlan({ npm: 'npm', cargoManifest: 'src-tauri/Cargo.toml' });
  const step = plan.find((entry) => entry.name === 'rustFormat');
  assert.ok(step, 'cargo fmt --check had no gate in test:all or CI');
  assert.equal(step.command, 'cargo');
  assert.deepEqual(step.args, [
    'fmt',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--all',
    '--check',
  ]);

  // It must run before the slower Rust steps so formatting fails fast.
  const names = plan.map((entry) => entry.name);
  assert.ok(names.indexOf('rustFormat') < names.indexOf('rustCheck'));
  assert.ok(names.indexOf('rustFormat') < names.indexOf('rustClippy'));
});

test('every planned step is represented in the results map that gates the proof', () => {
  const plan = createStepPlan({ npm: 'npm' });
  assert.deepEqual(
    Object.keys(createInitialResults(plan)),
    plan.map((step) => step.name)
  );
  assert.deepEqual(createInitialResults(plan).test, {
    status: 'pending',
    passed: null,
    failed: null,
    files: null,
  });
});

test('isQualityGateClean requires every step to have passed', () => {
  const plan = createStepPlan({ npm: 'npm' });
  assert.equal(isQualityGateClean(passingResults(plan)), true);
  assert.equal(isQualityGateClean(passingResults(plan, ['releaseAssets'])), false);
  assert.equal(isQualityGateClean(passingResults(plan, ['rustClippy'])), false);
  assert.equal(isQualityGateClean(createInitialResults(plan)), false, 'pending is not clean');
  assert.equal(isQualityGateClean({}), false, 'an empty result set is never clean');
});

test('main does not record the quality-gate proof when the release-asset suites fail', () => {
  const { calls, exitCode } = runGate({ failing: ['releaseAssets'] });
  assert.ok(calls.includes('run:releaseAssets'), 'the release-asset step must actually run');
  assert.ok(
    !calls.includes('recordProof'),
    'a failing release-asset suite must never leave a valid proof behind'
  );
  assert.equal(exitCode, 1);
});

test('main records the proof only after every step has run', () => {
  const { calls, exitCode } = runGate();
  const recordIndex = calls.indexOf('recordProof');
  const releaseIndex = calls.indexOf('run:releaseAssets');
  assert.ok(releaseIndex >= 0);
  assert.ok(recordIndex > releaseIndex, 'proof must be written after the release-asset step');
  assert.equal(recordIndex, calls.length - 1, 'proof must be the final action');
  assert.equal(exitCode, 0);
});

test('main clears any stale proof before running the gate', () => {
  const { calls } = runGate({ failing: ['test'] });
  assert.equal(calls[0], 'clearProof');
  assert.ok(!calls.includes('recordProof'));
});

test('main keeps a clean exit when the proof is skipped for a dirty tree', () => {
  const { exitCode, logs } = runGate({ proofRecorded: false });
  assert.equal(exitCode, 0);
  assert.ok(logs.some((line) => line.includes('not recorded because the working tree is dirty')));
});

test('printSummary reports the release-asset step and fails the run', () => {
  const plan = createStepPlan({ npm: 'npm' });
  const logs = [];
  const code = printSummary(passingResults(plan, ['releaseAssets']), plan, (line) =>
    logs.push(String(line))
  );
  assert.equal(code, 1);
  const summary = logs.join('\n');
  assert.ok(summary.includes('Release Assets:'));
  assert.equal(
    printSummary(passingResults(plan), plan, () => {}),
    0
  );
});

test('runCommand records failure and surfaces command output', () => {
  const plan = createStepPlan({ npm: 'npm' });
  const results = createInitialResults(plan);
  const logs = [];
  const ok = runCommand(
    plan.find((step) => step.name === 'releaseAssets'),
    results,
    {
      spawn: () => ({ status: 1, stdout: '', stderr: 'release assets exploded' }),
      log: (line) => logs.push(String(line)),
    }
  );
  assert.equal(ok, false);
  assert.equal(results.releaseAssets.status, 'failed');
  assert.ok(logs.join('\n').includes('release assets exploded'));
});

test('runCommand passes each step its own timeout', () => {
  const plan = createStepPlan({ npm: 'npm', rustTimeout: 4242 });
  const results = createInitialResults(plan);
  const seen = [];
  const spawn = (command, args, options) => {
    seen.push({ command, args, timeout: options.timeout });
    return { status: 0, stdout: '', stderr: '' };
  };
  for (const name of ['releaseAssets', 'rustClippy']) {
    runCommand(
      plan.find((step) => step.name === name),
      results,
      { spawn, log: () => {} }
    );
  }
  assert.equal(seen[0].timeout, 300_000);
  assert.equal(seen[1].timeout, 4242);
  assert.equal(results.releaseAssets.status, 'passed');
  assert.equal(results.rustClippy.status, 'passed');
});

test('parseTest extracts vitest counts from colored output', () => {
  const results = { test: {} };
  parseTest(
    ['\x1b[32m Test Files \x1b[39m 117 passed (117)', ' Tests  2918 passed (2918)'].join('\n'),
    results
  );
  assert.equal(results.test.passed, 2918);
  assert.equal(results.test.failed, 0);
  assert.equal(results.test.files, 117);
});
