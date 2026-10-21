'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  hashFile,
  verifyUpdaterSignature,
  verifyReleaseDirectory,
} = require('./verify-release-content.cjs');

function signed(content) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = crypto.randomBytes(8);
  const key = Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
  const digest = crypto.createHash('blake2b512').update(content).digest();
  const signature = crypto.sign(null, digest, privateKey);
  const comment = 'timestamp:1000';
  const packet = Buffer.concat([Buffer.from('ED'), keyId, signature]);
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  return {
    digest,
    signature: Buffer.from(
      `untrusted comment: test\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`
    ).toString('base64'),
    publicKey: Buffer.from(`untrusted comment: test\n${key.toString('base64')}\n`).toString(
      'base64'
    ),
  };
}

test('updater signature binds bytes, key and trusted comment', () => {
  const fixture = signed(Buffer.from('installer bytes'));
  verifyUpdaterSignature(fixture.digest, fixture.signature, fixture.publicKey);
  assert.throws(
    () => verifyUpdaterSignature(Buffer.alloc(64), fixture.signature, fixture.publicKey),
    /does not match/
  );
  assert.throws(
    () =>
      verifyUpdaterSignature(
        fixture.digest,
        fixture.signature,
        signed(Buffer.from('other')).publicKey
      ),
    /signing key/
  );
  const changedComment = Buffer.from(
    Buffer.from(fixture.signature, 'base64').toString().replace('timestamp:1000', 'timestamp:2000')
  ).toString('base64');
  assert.throws(
    () => verifyUpdaterSignature(fixture.digest, changedComment, fixture.publicKey),
    /does not match/
  );
});

test('release content binds manifests, checksums and uploaded bytes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-content-test-'));
  try {
    const content = Buffer.from('installer bytes');
    const fixture = signed(content);
    const files = new Map([
      ['IYERIS-Win-x64.exe', content],
      ['IYERIS-Win-x64.exe.sig', Buffer.from(fixture.signature)],
      [
        'latest-windows-x86_64.json',
        Buffer.from(
          JSON.stringify({
            version: '1.0.0',
            platforms: {
              'windows-x86_64': {
                url: 'https://github.com/owner/repo/releases/download/v1.0.0/IYERIS-Win-x64.exe',
                signature: fixture.signature,
              },
            },
          })
        ),
      ],
    ]);
    const sums = [...files]
      .map(([name, bytes]) => `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`)
      .join('\n');
    files.set('SHA256SUMS-windows-x86_64.txt', Buffer.from(sums));
    const assets = [];
    for (const [name, bytes] of files) {
      fs.writeFileSync(path.join(directory, name), bytes);
      const hash = await hashFile(path.join(directory, name));
      assets.push({ name, size: hash.size, digest: `sha256:${hash.sha256}` });
    }
    const options = { tag: 'v1.0.0', repository: 'owner/repo', publicKey: fixture.publicKey };
    await verifyReleaseDirectory(directory, assets, options);
    fs.writeFileSync(path.join(directory, 'IYERIS-Win-x64.exe'), 'tampered bytes');
    await assert.rejects(verifyReleaseDirectory(directory, assets, options), /GitHub digest/);
    fs.writeFileSync(path.join(directory, 'IYERIS-Win-x64.exe'), content);
    await assert.rejects(
      verifyReleaseDirectory(directory, assets, { ...options, tag: 'v2.0.0' }),
      /Wrong version/
    );
    const sumAsset = assets.find((asset) => asset.name.startsWith('SHA256SUMS-'));
    fs.writeFileSync(
      path.join(directory, sumAsset.name),
      sums.replace(/^[a-f0-9]{64}/u, '0'.repeat(64))
    );
    const hash = await hashFile(path.join(directory, sumAsset.name));
    sumAsset.digest = `sha256:${hash.sha256}`;
    await assert.rejects(
      verifyReleaseDirectory(directory, assets, options),
      /Checksum content mismatch/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
