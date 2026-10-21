const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildChangelogReleaseBody,
  isPrereleaseVersion,
  releaseTag,
} = require('./changelog-release-body.cjs');

const SAMPLE = `<!-- > [!NOTE]
> 🅱️ This is a Beta build. -->

# Downloads
[x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.4/IYERIS-Win-x64.exe)
`;

test('identifies prerelease versions and tags', () => {
  assert.equal(isPrereleaseVersion('3.0.5-beta.1'), true);
  assert.equal(isPrereleaseVersion('3.0.5'), false);
  assert.equal(releaseTag('3.0.5-beta.1'), 'v3.0.5-beta.1');
});

test('rewrites download links and uncomments the beta banner for prereleases', () => {
  const body = buildChangelogReleaseBody(SAMPLE, '3.0.5-beta.1');
  assert.match(body, /^>\s*\[!NOTE\]/mu);
  assert.doesNotMatch(body, /<!--\s*>\s*\[!NOTE\]/u);
  assert.match(body, /releases\/download\/v3\.0\.5-beta\.1\/IYERIS-Win-x64\.exe/u);
  assert.doesNotMatch(body, /releases\/download\/v3\.0\.4\//u);
});

test('rejects a beta changelog that has no beta warning', () => {
  assert.throws(
    () =>
      buildChangelogReleaseBody(
        '[x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.4/a.exe)\n',
        '3.0.5-beta.1'
      ),
    /visible GitHub beta warning/u
  );
});

test('rewrites stable links without requiring a beta banner', () => {
  const body = buildChangelogReleaseBody(
    '[x64](https://github.com/BurntToasters/IYERIS/releases/download/v3.0.4/IYERIS-Win-x64.exe)\n',
    '3.0.5'
  );
  assert.match(body, /releases\/download\/v3\.0\.5\/IYERIS-Win-x64\.exe/u);
  assert.doesNotMatch(body, /\[!NOTE\]/u);
});
