const assert = require('node:assert/strict');
const test = require('node:test');
const { publishPayload } = require('./publish-release.cjs');

test('publish payload promotes beta draft without changing prerelease channel', () => {
  assert.deepEqual(publishPayload(), { draft: false, prerelease: true });
});
