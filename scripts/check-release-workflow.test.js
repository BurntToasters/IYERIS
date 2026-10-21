import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkReleaseWorkflow, findReleaseWorkflowViolations } from './check-release-workflow.js';

test('all CI workflows stay free of release operations', () => {
  assert.deepEqual(checkReleaseWorkflow(), []);
});

test('test, audit, and smoke commands are allowed', () => {
  assert.deepEqual(
    findReleaseWorkflowViolations(
      'permissions:\n  contents: read\nrun: npm run test:release-assets\nrun: npm run smoke:perf:fixture\nrun: npm run audit'
    ),
    []
  );
});

test('release mutations, credentials, and write permissions are rejected', () => {
  for (const command of [
    'permissions: write-all',
    'contents: write',
    'release:\n types: [published]',
    'gh release upload v1.0.0 file --clobber',
    'gh api --method PATCH /repos/owner/repo/releases/1',
    'npm run release:publish',
    'npm run release:mac',
    'npm run build:win:prepared',
    'node scripts/sync-beta-manifests.cjs',
    'node scripts/publish-release.cjs',
    'uses: softprops/action-gh-release@sha',
    'uses: tauri-apps/tauri-action@sha',
    'KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
  ])
    assert.ok(findReleaseWorkflowViolations(command).length, command);
});

test('policy inspects new workflows too', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-ci-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'ci.yml'), 'run: npm test');
  fs.writeFileSync(path.join(directory, 'unexpected.yaml'), 'run: npm run release:publish');
  assert.deepEqual(checkReleaseWorkflow(directory), ['unexpected.yaml: release script']);
});
