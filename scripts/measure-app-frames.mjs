// Frame-time measurement for the 100,000-entry list and grid. A measurement, not a gate: it is
// not part of `test:all`, and its timings never enter target/e2e/app-artifact.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const perfDir = path.join(root, 'target', 'perf');
const resultsPath = path.join(perfDir, 'app-frames.json');

// Written before the code, per AGENTS.md. Each entry is one way the measurement can fail.
const FAILURE_MODES = [
  '1. Release build with --features tooling fails or times out: no measurement; exit non-zero.',
  '2. Release binary missing after a successful build: the run cannot start.',
  '3. Headless trace run fails: recorded as headless false, needsNative true, with the reason.',
  '4. Trace truncated or empty: fewer frame rows than --frames, or no quality.cpu_ms rows.',
  '5. Wrong statistic: wrong field, or the first (mount) frame counted. Nearest rank over frames 2+.',
  '6. Scroll does not scroll: no animating frames, recorded as animatingFrames 0 and flagged.',
  '7. Results file not written, or written with a missing run.',
];
const scriptDir = path.join(root, 'crates', 'iyeris-app', 'scripts');
const buildTimeoutMs = process.platform === 'win32' ? 1_200_000 : 600_000;
const runTimeoutMs = 120_000;
const maxOutputBytes = 8 * 1024 * 1024;
const frameCount = 420;
const displayErrorPattern = /display|wayland|x11|adapter|gpu|surface/i;
const binaryName = process.platform === 'win32' ? 'iyeris-app.exe' : 'iyeris-app';
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, 'target');

const runs = [
  { name: 'list', scene: 'list', script: 'scroll-list.json' },
  { name: 'grid', scene: 'grid', script: 'scroll-grid.json' },
];

function percentile(sorted, p) {
  return sorted[Math.round((sorted.length - 1) * p)];
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function tail(text) {
  return (text || '').trim().split('\n').slice(-8).join('\n');
}

function buildRelease() {
  const run = spawnSync(
    'cargo',
    ['build', '--locked', '--release', '-p', 'iyeris-app', '--features', 'tooling'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
      timeout: buildTimeoutMs,
      maxBuffer: maxOutputBytes,
    }
  );
  if (run.error) return `release build did not finish: ${run.error.message}`;
  if (run.status !== 0)
    return `release build exited with ${run.status ?? run.signal}\n${tail(run.stderr)}`;
  return null;
}

// Reads one trace: the header, then one row per frame. Frame rows carry `quality.cpu_ms`.
function readTrace(tracePath, expectedFrames) {
  const lines = fs
    .readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  const rows = lines.slice(1).map((line) => JSON.parse(line));
  const frames = rows.filter((row) => row.quality && typeof row.quality.cpu_ms === 'number');
  if (frames.length === 0) throw new Error('trace has no frame rows with quality.cpu_ms');
  if (frames.length < expectedFrames) {
    throw new Error(`trace has ${frames.length} frame rows; expected ${expectedFrames}`);
  }
  const measured = frames.slice(1);
  const cpu = measured.map((row) => row.quality.cpu_ms);
  const sorted = [...cpu].sort((a, b) => a - b);
  return {
    frames: frames.length,
    measuredFrames: measured.length,
    animatingFrames: measured.filter((row) => row.quality.animating === true).length,
    p50Ms: round3(percentile(sorted, 0.5)),
    p95Ms: round3(percentile(sorted, 0.95)),
    maxMs: round3(sorted[sorted.length - 1]),
  };
}

function measureRun(binary, run) {
  const tracePath = path.join(perfDir, `${run.name}.jsonl`);
  const scriptPath = path.join(scriptDir, run.script);
  fs.rmSync(tracePath, { force: true });
  const result = {
    name: run.name,
    scene: run.scene,
    script: run.script,
    frames: frameCount,
    headless: false,
    needsNative: false,
  };
  const headless = spawnSync(
    binary,
    [
      '--scene',
      run.scene,
      '--script',
      scriptPath,
      '--trace',
      tracePath,
      '--frames',
      String(frameCount),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
      timeout: runTimeoutMs,
      maxBuffer: maxOutputBytes,
    }
  );
  if (headless.error || headless.status !== 0) {
    const reason = headless.error
      ? `did not finish: ${headless.error.message}`
      : `exited with ${headless.status ?? headless.signal}\n${tail(headless.stderr)}`;
    result.error = `headless trace run ${reason}`;
    const stderr = headless.stderr || '';
    result.needsNative = displayErrorPattern.test(stderr) || /headless|tooling/i.test(stderr);
    return result;
  }
  result.headless = true;
  try {
    Object.assign(result, readTrace(tracePath, frameCount));
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function main() {
  const buildError = buildRelease();
  if (buildError) {
    console.error(`App frame measurement: ${buildError}`);
    return 1;
  }
  const binary = path.join(targetDir, 'release', binaryName);
  if (!fs.existsSync(binary)) {
    console.error(`App frame measurement: release binary is missing at ${binary}`);
    return 1;
  }
  fs.mkdirSync(perfDir, { recursive: true });

  const results = runs.map((run) => measureRun(binary, run));
  const summary = {
    schema: 1,
    build: 'release',
    features: ['tooling'],
    failureModes: FAILURE_MODES,
    runs: results,
  };
  fs.writeFileSync(resultsPath, `${JSON.stringify(summary, null, 2)}\n`);

  for (const run of results) {
    if (run.error) {
      console.log(
        `${run.name}: not measured (${run.needsNative ? 'needs --native' : 'error'}): ${run.error.split('\n')[0]}`
      );
    } else {
      const flag =
        run.animatingFrames === 0
          ? ' (warning: no animating frames; the scroll may not have run)'
          : '';
      console.log(
        `${run.name}: p50 ${run.p50Ms} ms, p95 ${run.p95Ms} ms, max ${run.maxMs} ms${flag}`
      );
    }
  }
  console.log(`Wrote ${path.relative(root, resultsPath)}. This is a measurement, not a gate.`);
  return 0;
}

process.exitCode = main();
