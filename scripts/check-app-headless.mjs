// Failure modes:
// 1. The build fails, or a scene fails to render: `cargo build`, or a `--snap` or `--tree`
//    run exits non-zero or does not finish within the per-run timeout.
// 2. An empty or missing PNG: the file is absent, has zero bytes, or lacks the PNG signature.
//    Stale output from an earlier run is removed first, so it cannot pass.
// 3. A tree missing expected entries: folder-000000, file-000001.txt, folder-050000 or tile-0/7.
// 4. Rows duplicated at a scroll offset: two mounted row or tile keys are equal.
// 5. The wrong entry selected: the selected keys are not exactly the scene's expected key.
// 6. The grid shows zero or one column at 960 px: no tile shares a row with tile-0.
// 7. No virtualization: a scene mounts 200 or more rows or tiles of the 100,000 entries.
// 8. The app needs a display or GPU: the failing run's stderr names a display or adapter.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'target', 'e2e', 'app');
const artifactPath = path.join(root, 'target', 'e2e', 'app-artifact.json');
const runTimeoutMs = 120_000;
const buildTimeoutMs = process.platform === 'win32' ? 1_200_000 : 600_000;
const maxMountedItems = 200;
const maxOutputBytes = 8 * 1024 * 1024;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const itemRoles = new Set(['row', 'grid-cell']);
const displayErrorPattern = /display|wayland|x11|adapter|gpu|surface/i;

const scenes = [
  {
    name: 'list',
    present: ['folder-000000', 'file-000001.txt'],
    absent: [],
    selected: ['folder-000000'],
  },
  {
    name: 'list-scrolled',
    present: ['folder-050000'],
    absent: ['file-000001.txt'],
    selected: ['folder-050000'],
  },
  { name: 'grid', present: ['tile-0'], absent: [], gridRow: true },
  { name: 'grid-selected', present: ['tile-7'], absent: [], selected: ['tile-7'] },
];

function runCargo(args, timeout) {
  return spawnSync('cargo', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
    windowsHide: true,
    timeout,
    maxBuffer: maxOutputBytes,
  });
}

function runApp(args) {
  return runCargo(['run', '--locked', '-p', 'iyeris-app', '--', ...args], runTimeoutMs);
}

function describeRunFailure(run, label) {
  if (run.error) return `${label} did not finish: ${run.error.message}`;
  if (run.status === 0) return null;
  const stderrTail = (run.stderr || '').trim().split('\n').slice(-12).join('\n');
  const hint = displayErrorPattern.test(stderrTail)
    ? ' (the app may need a display or GPU adapter)'
    : '';
  return `${label} exited with ${run.status ?? run.signal}${hint}\n${stderrTail}`;
}

function pngProblem(file) {
  if (!fs.existsSync(file)) return 'PNG is missing';
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0) return 'PNG is empty';
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    return 'file does not start with the PNG signature';
  }
  return null;
}

function collectItems(node, items = []) {
  if (itemRoles.has(node.role) && typeof node.key === 'string') items.push(node);
  for (const child of node.children ?? []) collectItems(child, items);
  return items;
}

function readRuneRev() {
  const lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  const match = lock.match(
    /\[\[package\]\]\r?\nname = "rune"\r?\nversion = "[^"]+"\r?\nsource = "git\+https:\/\/github\.com\/anomalyco\/rune\?rev=([0-9a-f]{40})#/
  );
  if (!match) throw new Error('Could not read the Rune rev from the root Cargo.lock');
  return match[1];
}

function runScene(scene, failures) {
  const pngPath = path.join(outDir, `${scene.name}.png`);
  const repeatPath = path.join(outDir, `.${scene.name}.repeat.png`);
  const treePath = path.join(outDir, `${scene.name}.json`);
  const sceneFailures = [];
  const report = (message) => sceneFailures.push(`${scene.name}: ${message}`);
  for (const file of [pngPath, repeatPath, treePath]) fs.rmSync(file, { force: true });

  // The second snap run only measures whether the PNG size is stable across runs.
  const snapError = describeRunFailure(
    runApp(['--snap', pngPath, '--scene', scene.name]),
    `${scene.name} snap run`
  );
  let pngOk = false;
  if (snapError) {
    report(snapError);
  } else {
    const problem = pngProblem(pngPath);
    if (problem) report(problem);
    else pngOk = true;
  }

  const repeatError = describeRunFailure(
    runApp(['--snap', repeatPath, '--scene', scene.name]),
    `${scene.name} repeat snap run`
  );
  if (repeatError) report(repeatError);
  const pngBytes = pngOk ? fs.statSync(pngPath).size : null;
  const repeatBytes = fs.existsSync(repeatPath) ? fs.statSync(repeatPath).size : -1;
  const stable = pngOk && repeatBytes === pngBytes;
  fs.rmSync(repeatPath, { force: true });

  let items = [];
  const treeError = describeRunFailure(
    runApp(['--tree', treePath, '--scene', scene.name]),
    `${scene.name} tree run`
  );
  if (treeError) {
    report(treeError);
  } else {
    try {
      const json = JSON.parse(fs.readFileSync(treePath, 'utf8'));
      if (json.accessibility) items = collectItems(json.accessibility);
      else report('tree JSON has no accessibility root');
    } catch (error) {
      report(`tree JSON is unreadable: ${error.message}`);
    }
  }

  const keys = items.map((item) => item.key);
  const selected = items
    .filter((item) => (item.states ?? []).includes('selected'))
    .map((item) => item.key)
    .sort();
  for (const key of scene.present) {
    if (!keys.includes(key)) report(`tree is missing ${key}`);
  }
  for (const key of scene.absent) {
    if (keys.includes(key)) report(`tree mounts ${key}, which must be scrolled out of view`);
  }
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  if (duplicates.length > 0) {
    report(`rows duplicated at this scroll offset: ${duplicates.slice(0, 5).join(', ')}`);
  }
  if (items.length >= maxMountedItems) {
    report(`mounts ${items.length} rows or tiles; the limit is fewer than ${maxMountedItems}`);
  }
  if (scene.selected && JSON.stringify(selected) !== JSON.stringify(scene.selected)) {
    report(`selected ${JSON.stringify(selected)}, expected ${JSON.stringify(scene.selected)}`);
  }
  if (scene.gridRow) {
    const first = items.find((item) => item.key === 'tile-0');
    const tilesInRow = first ? items.filter((item) => item.bounds?.[1] === first.bounds[1]) : [];
    if (tilesInRow.length < 2) {
      report(`grid shows ${tilesInRow.length} tile(s) in the first row at 960 px; expected more`);
    }
  }

  failures.push(...sceneFailures);
  return {
    name: scene.name,
    ok: sceneFailures.length === 0,
    mounted: items.length,
    selected,
    firstKey: keys[0] ?? null,
    lastKey: keys.at(-1) ?? null,
    pngOk,
    ...(stable ? { pngBytes } : {}),
  };
}

function failedScene(scene) {
  return {
    name: scene.name,
    ok: false,
    mounted: 0,
    selected: [],
    firstKey: null,
    lastKey: null,
    pngOk: false,
  };
}

function main() {
  const failures = [];
  fs.mkdirSync(outDir, { recursive: true });
  let rev = null;
  try {
    rev = readRuneRev();
  } catch (error) {
    failures.push(error.message);
  }

  const buildError = describeRunFailure(
    runCargo(['build', '--locked', '-p', 'iyeris-app'], buildTimeoutMs),
    'cargo build'
  );
  if (buildError) failures.push(buildError);

  const sceneEntries = scenes.map((scene) => {
    if (buildError) return failedScene(scene);
    try {
      return runScene(scene, failures);
    } catch (error) {
      failures.push(`${scene.name}: ${error.message}`);
      return failedScene(scene);
    }
  });

  // The artifact is written before the exit code, so a failing run still leaves evidence.
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const artifact = { schema: 1, rev, scenes: sceneEntries };
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  if (failures.length > 0) {
    console.error('App headless check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log(`App headless check passed (${scenes.length} scenes).`);
  return 0;
}

process.exitCode = main();
