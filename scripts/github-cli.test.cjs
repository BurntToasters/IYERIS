'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  githubApiArgs,
  githubCliEnvironment,
  githubStatusCode,
  releaseUploadArgs,
} = require('./github-cli.cjs');

test('GitHub CLI children use credential-store authentication', () => {
  assert.deepEqual(
    githubCliEnvironment({ PATH: '/bin', GH_TOKEN: 'old', GITHUB_TOKEN: 'old-too' }),
    { PATH: '/bin' }
  );
});

test('GitHub CLI commands preserve API and upload semantics', () => {
  assert.deepEqual(githubApiArgs('PATCH', 'repos/o/r/releases/1', true), [
    'api',
    '--method',
    'PATCH',
    'repos/o/r/releases/1',
    '--input',
    '-',
  ]);
  assert.deepEqual(releaseUploadArgs('o/r', 'v1.0.0', '/tmp/app.zip', { clobber: true }), [
    'release',
    'upload',
    'v1.0.0',
    '--repo',
    'o/r',
    '--clobber',
    '/tmp/app.zip',
  ]);
  assert.equal(githubStatusCode('HTTP 422: Validation Failed'), 422);
});