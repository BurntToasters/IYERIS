const assert = require('node:assert/strict');
const test = require('node:test');
const { version } = require('../package.json');
const { publishPayload } = require('./publish-release.cjs');

test('publish payload promotes draft without changing prerelease channel', () => {
  const expected = /-(?:alpha|beta|rc)(?:[.-]?\d+)?/i.test(version);
  assert.deepEqual(publishPayload(), { draft: false, prerelease: expected });
});
