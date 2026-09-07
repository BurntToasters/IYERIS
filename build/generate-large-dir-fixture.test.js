import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixtureMarkerPath, generateFixture, parseArgs } from './generate-large-dir-fixture.js';

test('parseArgs defaults to 15,000 files, 300 folders, and flat layout', () => {
  const options = parseArgs(['node', 'fixture']);
  assert.equal(options.files, 15_000);
  assert.equal(options.folders, 300);
  assert.equal(options.layout, 'flat');
});

test('parseArgs validates nested options and malformed input', () => {
  const options = parseArgs([
    'node',
    'fixture',
    '--layout',
    'nested',
    '--files',
    '4',
    '--folders',
    '2',
    '--buckets',
    '3',
    '--hidden-every',
    '0',
  ]);
  assert.equal(options.layout, 'nested');
  assert.equal(options.files, 4);
  assert.equal(options.folders, 2);
  assert.equal(options.buckets, 3);
  assert.equal(options.hiddenEvery, 0);
  assert.throws(() => parseArgs(['node', 'fixture', '--layout', 'wide']), /flat or nested/u);
  assert.throws(() => parseArgs(['node', 'fixture', '--files', '-1']), /integer/u);
  assert.throws(() => parseArgs(['node', 'fixture', '--wat']), /Unknown option/u);
});

test('small flat generation creates all entries directly in target', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-fixture-test-'));
  const output = path.join(parent, 'fixture');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const summary = await generateFixture({
    output,
    files: 4,
    folders: 2,
    buckets: 3,
    hiddenEvery: 2,
    layout: 'flat',
    clean: true,
  });
  const entries = await fs.readdir(output, { withFileTypes: true });
  assert.equal(entries.filter((entry) => entry.isFile()).length, 4);
  assert.equal(entries.filter((entry) => entry.isDirectory()).length, 2);
  assert.equal(summary.buckets, 0);
  assert.equal(summary.measurements.directEntries, 6);
  assert.equal(summary.measurements.files, 4);
  assert.equal(summary.measurements.folders, 2);
  assert.ok(summary.generationMs >= 0);
  assert.ok(summary.measurements.listMs >= 0);
  assert.ok(summary.measurements.searchMs >= 0);
  assert.equal(summary.measurements.cancellationObserved, true);
  assert.ok(summary.measurements.cancellationLatencyMs >= 0);
  assert.ok(Number.isFinite(summary.measurements.rssDeltaBytes));
});

test('small nested generation uses requested buckets', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-fixture-test-'));
  const output = path.join(parent, 'fixture');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const summary = await generateFixture({
    output,
    files: 6,
    folders: 2,
    buckets: 2,
    hiddenEvery: 0,
    layout: 'nested',
    clean: true,
  });
  assert.equal(summary.buckets, 2);
  assert.equal((await fs.readdir(path.join(output, 'bucket-000'))).length, 3);
  assert.equal((await fs.readdir(path.join(output, 'bucket-001'))).length, 3);
  assert.equal(summary.measurements.files, 6);
  assert.equal(summary.measurements.folders, 7);
});

test('clean refuses unmarked and protected targets', async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-unmarked-test-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  await expectReject(
    generateFixture({
      output,
      files: 0,
      folders: 0,
      buckets: 1,
      hiddenEvery: 0,
      layout: 'flat',
      clean: true,
    }),
    /unmarked directory/u
  );
  await expectReject(
    generateFixture({
      output,
      files: 0,
      folders: 0,
      buckets: 1,
      hiddenEvery: 0,
      layout: 'flat',
      clean: false,
    }),
    /unmarked directory/u
  );
  await expectReject(
    generateFixture({
      output: os.homedir(),
      files: 0,
      folders: 0,
      buckets: 1,
      hiddenEvery: 0,
      layout: 'flat',
      clean: true,
    }),
    /protected path/u
  );
});

test('clean permits a previously marked fixture', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-marked-test-'));
  const output = path.join(parent, 'fixture');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const options = {
    output,
    files: 1,
    folders: 0,
    buckets: 1,
    hiddenEvery: 0,
    layout: 'flat',
    clean: false,
  };

  await generateFixture(options);
  await generateFixture({ ...options, clean: true });

  assert.equal((await fs.readdir(output)).length, 1);
});

test('an owned fixture still requires explicit clean before replacement', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-explicit-clean-test-'));
  const output = path.join(parent, 'fixture');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const options = {
    output,
    files: 1,
    folders: 0,
    buckets: 1,
    hiddenEvery: 0,
    layout: 'flat',
    clean: false,
  };

  await generateFixture(options);
  await expectReject(generateFixture(options), /pass --clean/u);
});

test('a stale marker cannot authorize deleting a replacement directory', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-stale-marker-test-'));
  const output = path.join(parent, 'fixture');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const options = {
    output,
    files: 1,
    folders: 0,
    buckets: 1,
    hiddenEvery: 0,
    layout: 'flat',
    clean: false,
  };

  await generateFixture(options);
  await fs.rm(output, { recursive: true });
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'keep-me.txt'), 'not fixture data');

  await expectReject(generateFixture({ ...options, clean: true }), /unmarked directory/u);
  assert.equal(await fs.readFile(path.join(output, 'keep-me.txt'), 'utf8'), 'not fixture data');
  assert.ok((await fs.stat(fixtureMarkerPath(output))).isFile());
});

test('refuses a symbolic-link ownership marker', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Creating file symlinks is privilege-dependent on Windows');
    return;
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'iyeris-marker-link-test-'));
  const output = path.join(parent, 'fixture');
  const markerTarget = path.join(parent, 'marker-target');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.writeFile(markerTarget, 'do not overwrite');
  await fs.symlink(markerTarget, fixtureMarkerPath(output));

  await expectReject(
    generateFixture({
      output,
      files: 0,
      folders: 0,
      buckets: 1,
      hiddenEvery: 0,
      layout: 'flat',
      clean: false,
    }),
    /unsafe fixture ownership marker/u
  );
  assert.equal(await fs.readFile(markerTarget, 'utf8'), 'do not overwrite');
});

async function expectReject(promise, pattern) {
  await assert.rejects(promise, pattern);
}
