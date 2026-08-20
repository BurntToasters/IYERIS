import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIN_PUBLISH_AGE_MS,
  crateIndexPath,
  isPublishAgeAllowed,
  parseArguments,
  parsePublishTime,
} from './cargo-safe-update.mjs';

const now = Date.parse('2026-08-20T12:00:00Z');

test('allows publish age exactly at 72 hours', () => {
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS, now), true);
});

test('blocks publish age below 72 hours', () => {
  assert.equal(isPublishAgeAllowed(now - MIN_PUBLISH_AGE_MS + 1, now), false);
});

test('fails closed for missing or invalid publish time', () => {
  assert.equal(parsePublishTime(undefined), null);
  assert.equal(parsePublishTime('not-a-timestamp'), null);
  assert.equal(isPublishAgeAllowed(null, now), false);
});

test('uses crates.io sparse index path rules', () => {
  assert.equal(crateIndexPath('serde'), 'se/rd/serde');
  assert.equal(crateIndexPath('ab'), '2/ab');
  assert.equal(crateIndexPath('a'), '1/a');
});

test('keeps exact emergency overrides and Cargo arguments separate', () => {
  const parsed = parseArguments([
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '-p',
    'arrayref',
    '--allow-young',
    'arrayref@0.3.10',
    '--reason',
    'critical security fix',
  ]);
  assert.deepEqual(parsed.cargoArgs, ['--manifest-path', 'src-tauri/Cargo.toml', '-p', 'arrayref']);
  assert.equal(parsed.allowYoung.has('arrayref@0.3.10'), true);
});

test('dependency update entry points use guarded Cargo resolution', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['u', 'u2']) {
    const command = packageJson.scripts[name];
    if (!command) continue;
    assert.doesNotMatch(command, /\bcargo update\b/);
    assert.match(command, /cargo-safe-update/);
  }
  const helperCommand = readFileSync(new URL('./update-iyeris-pkg.js', import.meta.url), 'utf8');
  assert.doesNotMatch(helperCommand, /\bcargo update\b/);
  assert.match(helperCommand, /cargo-safe-update/);
});
