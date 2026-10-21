import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  checkBundleBudget,
  CSS_GZIP_LIMIT_BYTES,
  CSS_RAW_LIMIT_BYTES,
  ENTRY_GZIP_LIMIT_BYTES,
  ENTRY_RAW_LIMIT_BYTES,
  INITIAL_GZIP_LIMIT_BYTES,
  INITIAL_RAW_LIMIT_BYTES,
  measureEntryChunk,
} from './check-bundle-size.js';

test('bundle budget accepts exact limits', () => {
  assert.deepEqual(
    checkBundleBudget({
      rawBytes: ENTRY_RAW_LIMIT_BYTES,
      gzipBytes: ENTRY_GZIP_LIMIT_BYTES,
      cssRawBytes: CSS_RAW_LIMIT_BYTES,
      cssGzipBytes: CSS_GZIP_LIMIT_BYTES,
      initialRawBytes: INITIAL_RAW_LIMIT_BYTES,
      initialGzipBytes: INITIAL_GZIP_LIMIT_BYTES,
    }),
    []
  );
});

test('bundle budget reports raw and gzip overruns independently', () => {
  assert.deepEqual(checkBundleBudget({ rawBytes: ENTRY_RAW_LIMIT_BYTES + 1, gzipBytes: 1 }), [
    `raw ${ENTRY_RAW_LIMIT_BYTES + 1} B exceeds ${ENTRY_RAW_LIMIT_BYTES} B`,
  ]);
  assert.deepEqual(checkBundleBudget({ rawBytes: 1, gzipBytes: ENTRY_GZIP_LIMIT_BYTES + 1 }), [
    `gzip ${ENTRY_GZIP_LIMIT_BYTES + 1} B exceeds ${ENTRY_GZIP_LIMIT_BYTES} B`,
  ]);
});

test('bundle budget reports CSS and total initial-load overruns independently', () => {
  assert.deepEqual(checkBundleBudget({ cssRawBytes: CSS_RAW_LIMIT_BYTES + 1 }), [
    `CSS raw ${CSS_RAW_LIMIT_BYTES + 1} B exceeds ${CSS_RAW_LIMIT_BYTES} B`,
  ]);
  assert.deepEqual(checkBundleBudget({ cssGzipBytes: CSS_GZIP_LIMIT_BYTES + 1 }), [
    `CSS gzip ${CSS_GZIP_LIMIT_BYTES + 1} B exceeds ${CSS_GZIP_LIMIT_BYTES} B`,
  ]);
  assert.deepEqual(checkBundleBudget({ initialRawBytes: INITIAL_RAW_LIMIT_BYTES + 1 }), [
    `initial raw ${INITIAL_RAW_LIMIT_BYTES + 1} B exceeds ${INITIAL_RAW_LIMIT_BYTES} B`,
  ]);
  assert.deepEqual(checkBundleBudget({ initialGzipBytes: INITIAL_GZIP_LIMIT_BYTES + 1 }), [
    `initial gzip ${INITIAL_GZIP_LIMIT_BYTES + 1} B exceeds ${INITIAL_GZIP_LIMIT_BYTES} B`,
  ]);
});

test('measurement counts each HTML-linked initial asset once', (t) => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'iyeris-bundle-budget-test-'));
  const assetsDir = path.join(distDir, 'assets');
  t.after(() => rmSync(distDir, { recursive: true, force: true }));
  mkdirSync(assetsDir);

  const mainJs = Buffer.from('console.log("main");\n');
  const mainCss = Buffer.from('body { color: black; }\n');
  const vendorJs = Buffer.from('export const vendor = true;\n');
  const index = Buffer.from(`<!doctype html>
<link rel="stylesheet" href="/assets/main-a.css">
<link rel="modulepreload" href="/assets/vendor-b.js?cache=1">
<script type="module" src="/assets/main-a.js"></script>
<link rel="modulepreload" href="/assets/main-a.js">
`);
  writeFileSync(path.join(assetsDir, 'main-a.js'), mainJs);
  writeFileSync(path.join(assetsDir, 'main-a.css'), mainCss);
  writeFileSync(path.join(assetsDir, 'vendor-b.js'), vendorJs);
  writeFileSync(path.join(distDir, 'index.html'), index);

  const measurement = measureEntryChunk(distDir);
  const initialContents = [index, mainCss, vendorJs, mainJs];
  assert.deepEqual(measurement.initialAssetNames, ['main-a.css', 'vendor-b.js', 'main-a.js']);
  assert.equal(
    measurement.initialRawBytes,
    initialContents.reduce((total, content) => total + content.byteLength, 0)
  );
  assert.equal(
    measurement.initialGzipBytes,
    initialContents.reduce((total, content) => total + gzipSync(content).byteLength, 0)
  );
});
