import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDocsPolicy, findDocsPolicyViolations } from './check-docs-policy.js';

function fixture(content, filename = 'DEPENDENCY_UPDATES.md') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-docs-policy-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const target = path.join(root, 'docs', filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return root;
}

test('allows durable developer documentation', () => {
  const root = fixture('# Dependency updates\n\nKeep lockfiles fresh.');
  try {
    assert.deepEqual(findDocsPolicyViolations(root), []);
    assert.equal(checkDocsPolicy(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects release-note filenames and headings', () => {
  const root = fixture('# Release notes\n\n3.0.5 changes.', 'RELEASE_3.0.5.md');
  try {
    assert.throws(() => checkDocsPolicy(root), /policy violation/iu);
    assert.deepEqual(findDocsPolicyViolations(root).sort(), [
      'RELEASE_3.0.5.md: documentation must be on the durable allowlist',
      'RELEASE_3.0.5.md: forbidden release-document path',
      'RELEASE_3.0.5.md: release-document heading',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a version-only release document filename', () => {
  const root = fixture('# Improvements\n\nQuality fixes.', '3.0.5.md');
  try {
    assert.deepEqual(findDocsPolicyViolations(root).sort(), [
      '3.0.5.md: documentation must be on the durable allowlist',
      '3.0.5.md: forbidden release-document path',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects versioned improvement headings in a generic file', () => {
  const root = fixture('# 3.0.5 Improvements\n\nQuality fixes.', 'overview.md');
  try {
    assert.deepEqual(findDocsPolicyViolations(root).sort(), [
      'overview.md: documentation must be on the durable allowlist',
      'overview.md: release-document heading',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a What's New version heading in a generic file", () => {
  const root = fixture("# What's New in 3.0.5\n\nQuality fixes.", 'overview.md');
  try {
    assert.deepEqual(findDocsPolicyViolations(root).sort(), [
      'overview.md: documentation must be on the durable allowlist',
      'overview.md: release-document heading',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects release documents in version directories and whats-new files', () => {
  const root = fixture('# Improvements', path.join('3.0.5', 'overview.md'));
  fs.writeFileSync(path.join(root, 'docs', 'whats-new-3.0.5.md'), '# Improvements');
  try {
    assert.deepEqual(findDocsPolicyViolations(root).sort(), [
      '3.0.5/overview.md: documentation must be on the durable allowlist',
      '3.0.5/overview.md: forbidden release-document path',
      'whats-new-3.0.5.md: documentation must be on the durable allowlist',
      'whats-new-3.0.5.md: forbidden release-document path',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
