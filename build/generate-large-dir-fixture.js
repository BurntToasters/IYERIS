import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../scripts/direct-execution.js';

const SCRIPT_VERSION = '2.0.0';
export const DEFAULT_FILE_COUNT = 15_000;
export const DEFAULT_FOLDER_COUNT = 300;
export const DEFAULT_BUCKET_COUNT = 60;
export const DEFAULT_HIDDEN_EVERY = 41;
const WRITE_BATCH_SIZE = 300;
const FIXTURE_MARKER_VERSION = 1;
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'ts', 'js', 'csv', 'log']);
const EXTENSIONS = [
  'txt',
  'md',
  'json',
  'ts',
  'js',
  'png',
  'jpg',
  'webp',
  'gif',
  'pdf',
  'mp4',
  'mp3',
  'zip',
  'csv',
  'log',
];

function parseInteger(flag, value, { minimum = 0 } = {}) {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be at least ${minimum}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const result = {
    output: '',
    files: DEFAULT_FILE_COUNT,
    folders: DEFAULT_FOLDER_COUNT,
    buckets: DEFAULT_BUCKET_COUNT,
    hiddenEvery: DEFAULT_HIDDEN_EVERY,
    layout: 'flat',
    clean: false,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--clean') {
      result.clean = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--output') {
      if (!next) throw new Error('--output requires a value');
      result.output = next;
      index += 1;
    } else if (arg === '--files') {
      result.files = parseInteger(arg, next);
      index += 1;
    } else if (arg === '--folders') {
      result.folders = parseInteger(arg, next);
      index += 1;
    } else if (arg === '--buckets') {
      result.buckets = parseInteger(arg, next, { minimum: 1 });
      index += 1;
    } else if (arg === '--hidden-every') {
      result.hiddenEvery = parseInteger(arg, next);
      index += 1;
    } else if (arg === '--layout') {
      if (next !== 'flat' && next !== 'nested') {
        throw new Error('--layout must be flat or nested');
      }
      result.layout = next;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  result.output = path.resolve(
    result.output || path.join(os.tmpdir(), `iyeris-large-dir-fixture-${Date.now()}`)
  );
  return result;
}

function printHelp() {
  console.log(`IYERIS Large Directory Fixture Generator

Usage:
  npm run smoke:perf:fixture -- [options]

Options:
  --output <path>        Target directory. Default: new temp directory.
  --files <count>        Files to create. Default: ${DEFAULT_FILE_COUNT}
  --folders <count>      Folders to create. Default: ${DEFAULT_FOLDER_COUNT}
  --layout flat|nested   Flat load fixture or recursive fixture. Default: flat
  --buckets <count>      Nested-layout buckets. Default: ${DEFAULT_BUCKET_COUNT}
  --hidden-every <n>     Every nth file hidden; 0 disables. Default: ${DEFAULT_HIDDEN_EVERY}
  --clean                Replace a fixture owned by this generator.
  --help                 Show this message.
`);
}

function fileContent(index, extension) {
  if (!TEXT_EXTENSIONS.has(extension)) return '';
  return `fixture-index:${index}\nfixture-ext:${extension}\n`;
}

export function fixtureMarkerPath(output) {
  return `${output}.iyeris-perf-fixture.json`;
}

function assertSafeTarget(output) {
  const protectedPaths = new Set([
    path.parse(output).root,
    path.resolve(os.homedir()),
    path.resolve(REPO_ROOT),
  ]);
  if (protectedPaths.has(path.resolve(output))) {
    throw new Error(`Refusing to use protected path as fixture target: ${output}`);
  }
}

function fixtureIdentity(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    // birthtime is unavailable or zero on some Linux filesystems. Include
    // ctime/mtime so a stale marker cannot match a replacement directory that
    // happens to reuse the same inode.
    birthtimeMs: stats.birthtimeMs,
    ctimeMs: stats.ctimeMs,
    mtimeMs: stats.mtimeMs,
  };
}

async function hasOwnedMarker(output, stats) {
  try {
    const marker = JSON.parse(await fs.readFile(fixtureMarkerPath(output), 'utf8'));
    return (
      marker.version === FIXTURE_MARKER_VERSION &&
      marker.output === path.resolve(output) &&
      marker.identity?.dev === stats.dev &&
      marker.identity?.ino === stats.ino &&
      marker.identity?.birthtimeMs === stats.birthtimeMs &&
      marker.identity?.ctimeMs === stats.ctimeMs &&
      marker.identity?.mtimeMs === stats.mtimeMs
    );
  } catch {
    return false;
  }
}

async function assertSafeMarker(output) {
  try {
    const markerStats = await fs.lstat(fixtureMarkerPath(output));
    if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
      throw new Error('Refusing to use an unsafe fixture ownership marker');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function prepareTarget(output, clean) {
  assertSafeTarget(output);
  await assertSafeMarker(output);
  const markerPath = fixtureMarkerPath(output);
  let existing = null;
  try {
    existing = await fs.lstat(output);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (existing?.isSymbolicLink()) {
    throw new Error('Refusing to use a symbolic link as fixture target');
  }
  if (existing && !existing.isDirectory()) {
    throw new Error('Refusing to use a non-directory fixture target');
  }
  if (existing && !(await hasOwnedMarker(output, existing))) {
    throw new Error('Refusing to use an existing unmarked directory as fixture target');
  }
  if (existing && !clean) {
    throw new Error('Fixture target already exists; pass --clean to replace it');
  }
  if (clean && existing) {
    await fs.rm(output, { recursive: true, force: true });
  }
  // Marker is a sibling of the fixture directory. Remove any old regular
  // marker before reserving a fresh one; never truncate a path that could
  // have been swapped to a symlink after the lstat check.
  try {
    await fs.unlink(markerPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(output, { recursive: true });
  await writeOwnershipMarker(output);
}

async function writeOwnershipMarker(output) {
  const markerPath = fixtureMarkerPath(output);
  // Never follow a marker swapped to a symlink between the initial lstat and
  // this refresh. Remove only a regular marker, then reserve with 'wx'.
  try {
    const existing = await fs.lstat(markerPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Refusing to refresh an unsafe fixture ownership marker');
    }
    await fs.unlink(markerPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const created = await fs.lstat(output);
  const marker = `${JSON.stringify({
    version: FIXTURE_MARKER_VERSION,
    output: path.resolve(output),
    identity: fixtureIdentity(created),
  })}\n`;
  const handle = await fs.open(markerPath, 'wx');
  try {
    await handle.writeFile(marker, 'utf8');
  } finally {
    await handle.close();
  }
}

async function createBuckets(output, count) {
  const buckets = Array.from({ length: count }, (_, index) =>
    path.join(output, `bucket-${String(index).padStart(3, '0')}`)
  );
  await Promise.all(buckets.map((bucket) => fs.mkdir(bucket, { recursive: true })));
  return buckets;
}

export function buildFilePlan(parentDirs, fileCount, hiddenEvery) {
  return Array.from({ length: fileCount }, (_, index) => {
    const extension = EXTENSIONS[index % EXTENSIONS.length];
    const parent = parentDirs[index % parentDirs.length];
    const hidden = hiddenEvery > 0 && index % hiddenEvery === 0;
    const stem = `${hidden ? '.hidden' : 'item'}-${String(index).padStart(6, '0')}`;
    return { index, extension, filePath: path.join(parent, `${stem}.${extension}`) };
  });
}

async function writeFiles(plan) {
  for (let index = 0; index < plan.length; index += WRITE_BATCH_SIZE) {
    const batch = plan.slice(index, index + WRITE_BATCH_SIZE);
    await Promise.all(
      batch.map((entry) =>
        fs.writeFile(entry.filePath, fileContent(entry.index, entry.extension), { flag: 'wx' })
      )
    );
  }
}

async function createFolders(output, count, layout) {
  const folders = Array.from({ length: count }, (_, index) => {
    const name = `folder-${String(index).padStart(4, '0')}`;
    return layout === 'flat'
      ? path.join(output, name)
      : path.join(output, 'folders', `group-${String(index % 25).padStart(2, '0')}`, name);
  });
  await Promise.all(folders.map((folder) => fs.mkdir(folder, { recursive: true })));
}

async function scanFixture(output, { signal, onEntry } = {}) {
  let files = 0;
  let folders = 0;
  let fixtureIndexMatches = 0;
  let visitedEntries = 0;
  const pending = [output];
  while (pending.length > 0) {
    if (signal?.aborted) throw new Error('Fixture scan cancelled');
    const current = pending.pop();
    if (!current) break;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      visitedEntries += 1;
      onEntry?.(visitedEntries);
      if (signal?.aborted) throw new Error('Fixture scan cancelled');
      if (entry.isDirectory()) {
        folders += 1;
        pending.push(path.join(current, entry.name));
      } else if (entry.isFile()) {
        files += 1;
        if (entry.name.includes('item-0001')) fixtureIndexMatches += 1;
      }
      if (visitedEntries % 256 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  return { files, folders, fixtureIndexMatches, visitedEntries };
}

async function measureFixture(output, rssBefore) {
  const listStarted = performance.now();
  const directEntries = await fs.readdir(output, { withFileTypes: true });
  const listMs = performance.now() - listStarted;

  const searchStarted = performance.now();
  const scan = await scanFixture(output);
  const searchMs = performance.now() - searchStarted;

  const controller = new AbortController();
  const cancelAfterEntries = Math.min(256, scan.visitedEntries);
  let cancelRequestedAt = performance.now();
  let cancellationObserved = false;
  if (cancelAfterEntries === 0) controller.abort();
  try {
    await scanFixture(output, {
      signal: controller.signal,
      onEntry: (visitedEntries) => {
        if (!controller.signal.aborted && visitedEntries >= cancelAfterEntries) {
          cancelRequestedAt = performance.now();
          controller.abort();
        }
      },
    });
  } catch (error) {
    if (controller.signal.aborted && error?.message === 'Fixture scan cancelled') {
      cancellationObserved = true;
    } else {
      throw error;
    }
  }
  const cancellationLatencyMs = performance.now() - cancelRequestedAt;

  return {
    directEntries: directEntries.length,
    files: scan.files,
    folders: scan.folders,
    fixtureIndexMatches: scan.fixtureIndexMatches,
    listMs,
    searchMs,
    cancellationObserved,
    cancelAfterEntries,
    cancellationLatencyMs,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
  };
}

export async function generateFixture(options) {
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  await prepareTarget(options.output, options.clean);
  const parents =
    options.layout === 'flat'
      ? [options.output]
      : await createBuckets(options.output, options.buckets);
  const filePlan = buildFilePlan(parents, options.files, options.hiddenEvery);
  await writeFiles(filePlan);
  await createFolders(options.output, options.folders, options.layout);
  // The directory ctime/mtime changes while files are written. Refresh the
  // marker after the tree is complete so the same owned fixture can be
  // cleaned later, while a recreated directory still fails the identity check.
  await writeOwnershipMarker(options.output);
  const generationMs = performance.now() - started;
  const measurements = await measureFixture(options.output, rssBefore);
  return {
    output: options.output,
    layout: options.layout,
    files: options.files,
    folders: options.folders,
    buckets: options.layout === 'nested' ? options.buckets : 0,
    generationMs,
    measurements,
  };
}

function printSummary(summary) {
  console.log('IYERIS Large Directory Fixture Generator');
  console.log(`Script Version: ${SCRIPT_VERSION}`);
  console.log(`Output: ${summary.output}`);
  console.log(`Layout: ${summary.layout}`);
  console.log(`Files: ${summary.files.toLocaleString()}`);
  console.log(`Folders: ${summary.folders.toLocaleString()}`);
  if (summary.buckets) console.log(`Buckets: ${summary.buckets}`);
  console.log(`Generation: ${summary.generationMs.toFixed(1)} ms`);
  console.log(`Direct listing: ${summary.measurements.listMs.toFixed(1)} ms`);
  console.log(`Recursive name search: ${summary.measurements.searchMs.toFixed(1)} ms`);
  console.log(
    `Cancellation observed: ${summary.measurements.cancellationObserved ? 'yes' : 'no'} after ${summary.measurements.cancelAfterEntries} entries (${summary.measurements.cancellationLatencyMs.toFixed(3)} ms)`
  );
  console.log(`RSS delta: ${summary.measurements.rssDeltaBytes.toLocaleString()} bytes`);
  console.log(`Safety marker: ${fixtureMarkerPath(summary.output)}`);
  console.log(`Open this path in IYERIS: ${summary.output}`);
}

export async function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  printSummary(await generateFixture(options));
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(`Failed to generate fixture: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
