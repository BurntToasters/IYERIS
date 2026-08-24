import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  clearQualityGateProof,
  recordSuccessfulQualityGate,
  blockingReleaseWorkingTreePaths,
} from './release-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const packageJsonPath = resolve(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const appVersion = packageJson.version ?? 'unknown';
const scriptVersion = '1.1.0';

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};
const defaultTimeoutMs = 300_000;
const rustTimeoutMs = process.platform === 'win32' ? 1_200_000 : 600_000;

function getNpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences are control chars by definition
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseTest(output, results) {
  const cleanOutput = stripAnsi(output);
  const passedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+passed/);
  const failedMatch = cleanOutput.match(/Tests?\s+(\d+)\s+failed/);
  const filesMatch = cleanOutput.match(/Test Files\s+(\d+)\s+passed(?:\s+\((\d+)\))?/);
  results.test.passed = passedMatch ? parseInt(passedMatch[1], 10) : null;
  results.test.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  if (filesMatch) results.test.files = parseInt(filesMatch[1], 10);
}

function formatTestDetail(result) {
  const failedSuffix = result.failed > 0 ? `, ${result.failed} failed` : '';
  const filesSuffix = result.files ? `, ${result.files} files` : '';
  return ` (${result.passed ?? 'n/a'} passed${failedSuffix}${filesSuffix})`;
}

/**
 * Every check that gates the release quality-gate proof, in execution order.
 *
 * This list is the single source of truth: `createInitialResults` derives the
 * results map from it and `isQualityGateClean` requires all of them to pass, so
 * a step cannot run without also gating the proof.
 *
 * `releaseAssets` used to be chained after this script with a shell `&&` in
 * package.json's `test:all`. That put it *after* `recordSuccessfulQualityGate`,
 * so a failing release-tooling suite still left a valid proof on disk that
 * `release:session:start` would accept. Release-gating checks belong in this
 * plan, never chained after it.
 */
function createStepPlan({
  npm = getNpmCommand(),
  rustTimeout = rustTimeoutMs,
  cargoManifest = 'src-tauri/Cargo.toml',
} = {}) {
  return [
    { name: 'typecheck', label: 'TypeCheck', command: npm, args: ['run', 'typecheck'] },
    {
      name: 'typecheckTest',
      label: 'TypeCheck(Test)',
      command: npm,
      args: ['run', 'typecheck:test'],
    },
    { name: 'lint', label: 'Lint', command: npm, args: ['run', 'lint:prod'] },
    { name: 'lintTest', label: 'Lint(Test)', command: npm, args: ['run', 'lint:test'] },
    { name: 'lintScripts', label: 'Lint(Scripts)', command: npm, args: ['run', 'lint:scripts'] },
    { name: 'format', label: 'Format', command: npm, args: ['run', 'format:check'] },
    {
      name: 'nativePolicy',
      label: 'Native Policy',
      command: npm,
      args: ['run', 'check:native-process-policy'],
    },
    {
      name: 'cargoSafeUpdate',
      label: 'Cargo Safe Update',
      command: npm,
      args: ['run', 'test:cargo-safe-update'],
    },
    {
      name: 'cargoUpdatePolicy',
      label: 'Cargo Policy',
      command: npm,
      args: ['run', 'check:cargo-update-policy'],
    },
    {
      name: 'test',
      label: 'Tests',
      command: npm,
      args: ['run', 'test:cov'],
      parser: parseTest,
      detail: formatTestDetail,
    },
    {
      name: 'releaseAssets',
      label: 'Release Assets',
      command: npm,
      args: ['run', 'test:release-assets'],
    },
    {
      // The JS/TS side is format-checked by `format:check`; the Rust side had no
      // equivalent gate in either test:all or CI until now.
      name: 'rustFormat',
      label: 'Rust Format',
      command: 'cargo',
      args: ['fmt', '--manifest-path', cargoManifest, '--all', '--check'],
      timeout: rustTimeout,
    },
    {
      name: 'rustCheck',
      label: 'Rust Check',
      command: 'cargo',
      args: ['check', '--locked', '--manifest-path', cargoManifest],
      timeout: rustTimeout,
    },
    {
      name: 'rustClippy',
      label: 'Rust Clippy',
      command: 'cargo',
      args: [
        'clippy',
        '--locked',
        '--manifest-path',
        cargoManifest,
        '--all-targets',
        '--',
        '-D',
        'warnings',
        '-A',
        'unsafe_code',
      ],
      timeout: rustTimeout,
    },
    {
      name: 'rustTest',
      label: 'Rust Test',
      command: 'cargo',
      args: ['test', '--locked', '--manifest-path', cargoManifest, '--all-targets'],
      timeout: rustTimeout,
    },
  ];
}

function createInitialResults(plan = createStepPlan()) {
  const results = {};
  for (const step of plan) {
    results[step.name] =
      step.name === 'test'
        ? { status: 'pending', passed: null, failed: null, files: null }
        : { status: 'pending' };
  }
  return results;
}

/** Sole gate for recording the release proof: every planned step must have passed. */
function isQualityGateClean(results) {
  const values = Object.values(results);
  if (values.length === 0) return false;
  return values.every((result) => result?.status === 'passed');
}

function printTail(output, log) {
  const cleanOutput = stripAnsi(output).trim();
  if (!cleanOutput) return;
  const lines = cleanOutput.split('\n');
  const tail = lines.slice(-20).join('\n');
  log(`${colors.red}${tail}${colors.reset}`);
}

function runCommand(step, results, { spawn = spawnSync, log = console.log } = {}) {
  log(`${colors.blue}${colors.bold}Running ${step.name}...${colors.reset}`);
  const useShell = process.platform === 'win32' && /\.cmd$/i.test(step.command);
  const timeout = step.timeout ?? defaultTimeoutMs;
  const run = spawn(step.command, step.args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: useShell,
    windowsHide: true,
    timeout,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (step.parser) step.parser(output, results);
  if (!run.error && run.status === 0) {
    results[step.name].status = 'passed';
    log(`${colors.green}✓ ${step.name} passed${colors.reset}\n`);
    return true;
  }
  results[step.name].status = 'failed';
  const reason = run.error
    ? run.error.message
    : run.status === null
      ? `signal ${run.signal || 'unknown'}`
      : `exit code ${run.status}`;
  log(`${colors.red}✗ ${step.name} failed (${reason})${colors.reset}`);
  printTail(output, log);
  log('');
  return false;
}

function printBanner(log = console.log) {
  log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║        IYERIS TEST SUITE             ║
╚══════════════════════════════════════╝
IYERIS Version: ${appVersion}
Script Version: ${scriptVersion}
${colors.reset}`);
}

function printSummary(results, plan = createStepPlan(), log = console.log) {
  log(`${colors.bold}${colors.blue}
╔══════════════════════════════════════╗
║               SUMMARY                ║
╚══════════════════════════════════════╝
${colors.reset}`);
  const width = Math.max(...plan.map((step) => step.label.length)) + 2;
  for (const step of plan) {
    const result = results[step.name] ?? { status: 'pending' };
    const mark = result.status === 'passed' ? `${colors.green}✓ PASS` : `${colors.red}✗ FAIL`;
    const label = `${step.label}:`.padEnd(width, ' ');
    const detail = step.detail ? step.detail(result) : '';
    log(`${colors.bold}${label}${colors.reset}${mark}${colors.reset}${detail}`);
  }
  log('');
  if (isQualityGateClean(results)) {
    log(`${colors.green}${colors.bold}✓ All checks passed.${colors.reset}`);
    return 0;
  }
  log(`${colors.red}${colors.bold}✗ Some checks failed. Review output above.${colors.reset}`);
  return 1;
}

function main({
  plan = createStepPlan(),
  runStep = runCommand,
  recordProof = recordSuccessfulQualityGate,
  clearProof = clearQualityGateProof,
  listBlockingPaths = blockingReleaseWorkingTreePaths,
  root = repoRoot,
  log = console.log,
} = {}) {
  clearProof(root);
  const results = createInitialResults(plan);
  printBanner(log);
  for (const step of plan) {
    runStep(step, results, { log });
  }
  const exitCode = printSummary(results, plan, log);
  if (exitCode !== 0) return exitCode;
  if (recordProof(root)) {
    log('Release quality-gate proof recorded for this clean commit.');
  } else {
    log('Release quality-gate proof not recorded because the working tree is dirty.');
    const blocking = listBlockingPaths(root);
    if (blocking.length > 0) {
      log(`Blocking paths:\n${blocking.map((filePath) => `  ${filePath}`).join('\n')}`);
    }
    log(
      'Commit or stash changes (only version/metainfo/lockfile/schema drift from bootstrap is allowed).'
    );
  }
  return exitCode;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  process.exit(main());
}

export {
  createInitialResults,
  createStepPlan,
  getNpmCommand,
  isQualityGateClean,
  main,
  parseTest,
  printSummary,
  runCommand,
  stripAnsi,
};
