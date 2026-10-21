import assert from 'node:assert/strict';
import test from 'node:test';
import { findVersionMismatches } from './check-version-consistency.js';

const labels = [
  'package-lock.json top-level',
  'package-lock.json root package',
  'Cargo.toml',
  'Cargo.lock',
  'tauri.conf.json',
  'AppStream top release',
];

function matchingSources() {
  return Object.fromEntries(['package.json', ...labels].map((label) => [label, '3.0.5-beta.1']));
}

test('matching version sources pass', () => {
  assert.deepEqual(findVersionMismatches(matchingSources()), []);
});

for (const label of labels) {
  test(`reports ${label} independently`, () => {
    const sources = matchingSources();
    sources[label] = '3.0.4';
    assert.deepEqual(findVersionMismatches(sources), [
      { label, expected: '3.0.5-beta.1', actual: '3.0.4' },
    ]);
  });
}

test('missing package.json version fails', () => {
  const sources = matchingSources();
  sources['package.json'] = '';
  assert.throws(() => findVersionMismatches(sources), /package\.json version missing/u);
});
