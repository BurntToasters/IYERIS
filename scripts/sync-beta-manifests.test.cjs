const assert = require('node:assert/strict');
const test = require('node:test');
const { betaIsNewer, validateManifest, syncBetaManifests } = require('./sync-beta-manifests.cjs');

test('stable releases at or beyond beta base cannot be downgraded', () => {
  assert.equal(betaIsNewer('v3.0.5-beta.1', 'v3.0.4'), true);
  assert.equal(betaIsNewer('v3.0.5-beta.1', 'v3.0.5'), false);
  assert.equal(betaIsNewer('v3.0.5-beta.1', 'v3.1.0'), false);
  assert.equal(betaIsNewer('v3.0.10-beta.1', 'v3.0.9'), true);
  assert.throws(() => betaIsNewer('v3.0.5-rc.1', 'v3.0.4'));
});

test('manifest requires exact version, repository, tag and nonempty signatures', () => {
  const manifest = {
    version: '3.0.5-beta.1',
    platforms: {
      linux: {
        url: 'https://github.com/owner/repo/releases/download/v3.0.5-beta.1/app.tar.gz',
        signature: 'signed',
      },
    },
  };
  validateManifest(manifest, 'v3.0.5-beta.1', 'owner/repo');
  assert.throws(() => validateManifest(manifest, 'v3.0.5-beta.2', 'owner/repo'));
  assert.throws(() => validateManifest(manifest, 'v3.0.5-beta.1', 'attacker/repo'));
  manifest.platforms.linux.signature = '';
  assert.throws(() => validateManifest(manifest, 'v3.0.5-beta.1', 'owner/repo'));
});

test('CI guard rejects reconciliation before invoking any client', () => {
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    assert.throws(
      () => syncBetaManifests({ tag: 'v3.0.5-beta.1', repository: 'owner/repo', client: {} }),
      /never CI/u
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
});
