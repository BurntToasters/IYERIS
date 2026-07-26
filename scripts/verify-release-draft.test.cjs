const assert = require('node:assert/strict');
const test = require('node:test');

const {
  expectedPrereleaseAssets,
  expectedStableAssets,
  tag,
  validateReleaseDraft,
} = require('./verify-release-draft.cjs');

const BETA_TARGETS = [
  'windows-beta-x86_64',
  'windows-beta-aarch64',
  'darwin-beta-x86_64',
  'darwin-beta-aarch64',
  'linux-beta-x86_64',
];

function assetsFrom(names) {
  return Array.from(names, (name) => ({ name, size: 1 }));
}

test('prerelease policy requires beta manifests, checksums, and signatures', () => {
  const prereleaseAssets = expectedPrereleaseAssets();

  assert.equal(prereleaseAssets.size, 54);
  assert.equal(prereleaseAssets.has('IYERIS-Win-x64-Enterprise.msi'), false);
  assert.equal(prereleaseAssets.has('IYERIS-Win-arm64-Enterprise.msi'), false);
  for (const target of BETA_TARGETS) {
    assert.equal(prereleaseAssets.has(`latest-${target}.json`), true);
    assert.equal(prereleaseAssets.has(`SHA256SUMS-${target}.txt`), true);
    assert.equal(prereleaseAssets.has(`SHA256SUMS-${target}.txt.asc`), true);
  }
});

test('stable policy retains MSI assets without beta-channel checksums', () => {
  const stableAssets = expectedStableAssets();

  assert.equal(stableAssets.size, 45);
  assert.equal(stableAssets.has('IYERIS-Win-x64-Enterprise.msi'), true);
  assert.equal(stableAssets.has('IYERIS-Win-arm64-Enterprise.msi'), true);
  for (const target of BETA_TARGETS) {
    assert.equal(stableAssets.has(`latest-${target}.json`), false);
    assert.equal(stableAssets.has(`SHA256SUMS-${target}.txt`), false);
  }
});

test('complete prerelease asset matrix passes validation', () => {
  const errors = validateReleaseDraft(
    { draft: true, prerelease: true, tag_name: tag },
    assetsFrom(expectedPrereleaseAssets()),
    { prerelease: true, tag }
  );

  assert.deepEqual(errors, []);
});

test('prerelease validation rejects orphaned beta checksum signatures', () => {
  const missingChecksums = BETA_TARGETS.map((target) => `SHA256SUMS-${target}.txt`);
  const incomplete = new Set(expectedPrereleaseAssets());
  for (const name of missingChecksums) incomplete.delete(name);

  const errors = validateReleaseDraft(
    { draft: true, prerelease: true, tag_name: tag },
    assetsFrom(incomplete),
    { prerelease: true, tag }
  );

  assert.deepEqual(
    errors.filter((error) => error.startsWith('missing asset: SHA256SUMS-')),
    missingChecksums.map((name) => `missing asset: ${name}`)
  );
});

test('prerelease validation requires draft and prerelease flags', () => {
  const errors = validateReleaseDraft(
    { draft: false, prerelease: false, tag_name: tag },
    assetsFrom(expectedPrereleaseAssets()),
    { prerelease: true, tag }
  );

  assert.deepEqual(errors, [
    `${tag} is not a draft release`,
    `${tag} is not marked as a prerelease`,
  ]);
});

test('signer upload policy includes every generated beta checksum', async () => {
  const { isChecksumTextName, shouldUploadReleaseEntry, validateGeneratedUploadNames } =
    await import('./gpg-sign.js');
  const manifests = BETA_TARGETS.map((target) => `latest-${target}.json`);
  const checksums = BETA_TARGETS.map((target) => `SHA256SUMS-${target}.txt`);
  const signatures = checksums.map((name) => `${name}.asc`);

  const uploadNames = validateGeneratedUploadNames(manifests, checksums, signatures);
  for (const name of checksums) {
    assert.equal(isChecksumTextName(name), true);
    assert.equal(shouldUploadReleaseEntry(name), true);
    assert.equal(uploadNames.includes(name), true);
  }

  assert.throws(
    () => validateGeneratedUploadNames(manifests, checksums.slice(1), signatures),
    /missing checksum: SHA256SUMS-windows-beta-x86_64\.txt/
  );
});
