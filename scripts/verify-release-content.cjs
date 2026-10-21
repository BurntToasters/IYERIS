'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { githubCliEnvironment } = require('./github-cli.cjs');

function signatureText(value) {
  const text = String(value).trim();
  return text.startsWith('untrusted comment:')
    ? text
    : Buffer.from(text, 'base64').toString('utf8').trim();
}

// Minisign's hashed signature format: https://jedisct1.github.io/minisign/
function verifyUpdaterSignature(blake2bDigest, signature, publicKey) {
  const keyLines = signatureText(publicKey).split(/\r?\n/);
  const key = Buffer.from(keyLines[1] || '', 'base64');
  const lines = signatureText(signature).split(/\r?\n/);
  const packet = Buffer.from(lines[1] || '', 'base64');
  if (
    key.length !== 42 ||
    packet.length !== 74 ||
    key.subarray(0, 2).toString() !== 'Ed' ||
    packet.subarray(0, 2).toString() !== 'ED' ||
    !key.subarray(2, 10).equals(packet.subarray(2, 10)) ||
    !lines[2]?.startsWith('trusted comment: ')
  ) {
    throw new Error('Invalid updater signature format or signing key');
  }
  const verificationKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const detached = packet.subarray(10);
  const commentMessage = Buffer.concat([detached, Buffer.from(lines[2].slice(17))]);
  if (
    !crypto.verify(null, blake2bDigest, verificationKey, detached) ||
    !crypto.verify(null, commentMessage, verificationKey, Buffer.from(lines[3] || '', 'base64'))
  ) {
    throw new Error('Updater signature does not match artifact bytes');
  }
}

async function hashFile(file) {
  const sha256 = crypto.createHash('sha256');
  const blake2b = crypto.createHash('blake2b512');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    sha256.update(chunk);
    blake2b.update(chunk);
  }
  return { size, sha256: sha256.digest('hex'), blake2b: blake2b.digest() };
}

function readSmall(file) {
  if (fs.statSync(file).size > 8 * 1024 * 1024)
    throw new Error(`Release metadata too large: ${path.basename(file)}`);
  return fs.readFileSync(file, 'utf8');
}

function gpgFingerprint(keyId) {
  if (!keyId) throw new Error('GPG_KEY_ID is required to verify release signatures');
  const listing = execFileSync(
    'gpg',
    ['--batch', '--with-colons', '--fingerprint', '--list-keys', keyId],
    { encoding: 'utf8' }
  );
  if (listing.split('\n').filter((line) => line.startsWith('pub:')).length !== 1)
    throw new Error('GPG_KEY_ID must resolve to exactly one public key');
  const fingerprint = listing
    .split('\n')
    .find((line) => line.startsWith('fpr:'))
    ?.split(':')[9];
  if (!/^[A-F0-9]{40,64}$/i.test(fingerprint || ''))
    throw new Error('Cannot resolve release signing fingerprint');
  return fingerprint.toUpperCase();
}

function verifyGpg(signature, artifact, fingerprint) {
  const status = execFileSync(
    'gpg',
    ['--batch', '--no-auto-key-retrieve', '--status-fd', '1', '--verify', signature, artifact],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const valid = status.split('\n').filter((line) => line.startsWith('[GNUPG:] VALIDSIG '));
  if (
    !valid.some((line) => {
      const fields = line.split(' ');
      return fields[2] === fingerprint || fields[11] === fingerprint;
    })
  )
    throw new Error(`Unexpected GPG signer: ${path.basename(artifact)}`);
}

function artifactMatchesTarget(name, target, platform) {
  const allowed = {
    'windows-x86_64': ['IYERIS-Win-x64.exe', 'IYERIS-Win-x64-Enterprise.msi'],
    'windows-aarch64': ['IYERIS-Win-arm64.exe', 'IYERIS-Win-arm64-Enterprise.msi'],
    'darwin-x86_64': ['IYERIS-MacOS-universal.app.tar.gz'],
    'darwin-aarch64': ['IYERIS-MacOS-universal.app.tar.gz'],
    'linux-x86_64': [
      'IYERIS-Linux-x86_64.AppImage',
      'IYERIS-Linux-amd64.deb',
      'IYERIS-Linux-x86_64.rpm',
    ],
  }[target.replace('-beta-', '-')];
  if (!allowed?.includes(name)) return false;
  const installer = platform.startsWith(`${target}-`) ? platform.slice(target.length + 1) : '';
  const extensions = {
    nsis: '.exe',
    msi: '.msi',
    app: '.app.tar.gz',
    appimage: '.AppImage',
    deb: '.deb',
    rpm: '.rpm',
  };
  return (
    !installer || (extensions[installer] !== undefined && name.endsWith(extensions[installer]))
  );
}

async function verifyReleaseDirectory(
  directory,
  assets,
  { tag, repository, publicKey, fingerprint, verifyDetached = verifyGpg }
) {
  const byName = new Map();
  for (const asset of assets) {
    if (
      !asset.name ||
      path.basename(asset.name) !== asset.name ||
      // eslint-disable-next-line no-control-regex -- reject controls and path separators in asset names
      /[\\/\x00-\x1f]/u.test(asset.name) ||
      byName.has(asset.name)
    )
      throw new Error('Unsafe or duplicate release asset name');
    const file = path.join(directory, asset.name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Not a regular release artifact: ${asset.name}`);
    const hashes = await hashFile(file);
    if (hashes.size !== asset.size || `sha256:${hashes.sha256}` !== asset.digest?.toLowerCase())
      throw new Error(`Uploaded bytes differ from GitHub digest: ${asset.name}`);
    byName.set(asset.name, { ...hashes, file });
  }
  const covered = new Set();
  for (const [name, artifact] of byName) {
    if (name.startsWith('SHA256SUMS-') && name.endsWith('.txt')) {
      const seen = new Set();
      for (const line of readSmall(artifact.file).trim().split(/\r?\n/)) {
        const match = /^([a-f0-9]{64}) [ *](.+)$/iu.exec(line);
        if (!match || seen.has(match[2]) || byName.get(match[2])?.sha256 !== match[1].toLowerCase())
          throw new Error(`Checksum content mismatch in ${name}`);
        seen.add(match[2]);
        covered.add(match[2]);
      }
    }
    if (name.endsWith('.asc')) {
      const original = byName.get(name.slice(0, -4));
      if (!original) throw new Error(`Orphan release signature: ${name}`);
      verifyDetached(artifact.file, original.file, fingerprint);
    }
    if (name.endsWith('.sig')) {
      const original = byName.get(name.slice(0, -4));
      if (!original) throw new Error(`Orphan updater signature: ${name}`);
      verifyUpdaterSignature(original.blake2b, readSmall(artifact.file), publicKey);
    }
    if (/^latest-.*\.json$/u.test(name)) {
      const manifest = JSON.parse(readSmall(artifact.file));
      const target = name.slice(7, -5);
      if (manifest.version !== tag.replace(/^v/u, '') || !manifest.platforms?.[target])
        throw new Error(`Wrong version or missing target in ${name}`);
      for (const [platform, entry] of Object.entries(manifest.platforms)) {
        const bareBeta = target.split('-').slice(0, 2).join('-');
        if (platform !== target && !platform.startsWith(`${target}-`) && platform !== bareBeta)
          throw new Error(`Unexpected platform in ${name}: ${platform}`);
        const url = new URL(entry.url);
        const prefixes = [
          `/${repository}/releases/download/${tag}/`,
          `/${repository}/releases/latest/download/`,
        ];
        const prefix = prefixes.find((value) => url.pathname.startsWith(value));
        if (
          url.origin !== 'https://github.com' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !prefix
        )
          throw new Error(`Unexpected updater URL in ${name}`);
        const fileName = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!artifactMatchesTarget(fileName, target, platform))
          throw new Error(`Updater artifact has wrong platform in ${name}: ${fileName}`);
        const original = byName.get(fileName);
        const signature = byName.get(`${fileName}.sig`);
        if (
          !original ||
          !signature ||
          signatureText(entry.signature) !== signatureText(readSmall(signature.file))
        )
          throw new Error(`Manifest signature/artifact mismatch in ${name}`);
        verifyUpdaterSignature(original.blake2b, entry.signature, publicKey);
      }
    }
  }
  for (const name of byName.keys()) {
    if (!name.endsWith('.asc') && !name.startsWith('SHA256SUMS-') && !covered.has(name))
      throw new Error(`Asset missing from checksums: ${name}`);
  }
}

async function verifyReleaseContent(
  assets,
  { tag, repository, publicKey, keyId = process.env.GPG_KEY_ID }
) {
  const fingerprint = gpgFingerprint(keyId);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-release-verify-'));
  try {
    // gh writes downloads directly to disk; binaries are never buffered or executed.
    execFileSync('gh', ['release', 'download', tag, '--repo', repository, '--dir', directory], {
      env: githubCliEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30 * 60 * 1000,
    });
    await verifyReleaseDirectory(directory, assets, { tag, repository, publicKey, fingerprint });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = {
  hashFile,
  signatureText,
  verifyUpdaterSignature,
  verifyReleaseDirectory,
  verifyReleaseContent,
};
