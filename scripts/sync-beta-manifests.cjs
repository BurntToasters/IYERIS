#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cli = require('./github-cli.cjs');

function validateManifest(manifest, tag, repository) {
  const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
  if (
    manifest?.version !== tag.slice(1) ||
    !manifest.platforms ||
    Array.isArray(manifest.platforms) ||
    typeof manifest.platforms !== 'object' ||
    !Object.keys(manifest.platforms).length ||
    !Object.values(manifest.platforms).every(
      (entry) =>
        typeof entry?.url === 'string' &&
        entry.url.startsWith(prefix) &&
        typeof entry.signature === 'string' &&
        entry.signature.trim().length > 0
    )
  ) {
    throw new Error('Invalid beta updater manifest');
  }
}

function betaIsNewer(tag, stableTag) {
  const beta = /^v(\d+)\.(\d+)\.(\d+)-beta\.\d+$/u.exec(tag);
  const stable = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(stableTag);
  if (!beta || !stable) throw new Error('Invalid beta or stable release tag');
  for (let index = 1; index <= 3; index += 1) {
    if (BigInt(beta[index]) !== BigInt(stable[index]))
      return BigInt(beta[index]) > BigInt(stable[index]);
  }
  return false;
}

// Invoked by release VMs after publication, or explicitly to retry reconciliation.
// CI imports pure validators only; it never invokes this entry point.
function syncBetaManifests({ tag, repository, client = cli }) {
  if (process.env.GITHUB_ACTIONS === 'true')
    throw new Error('Release reconciliation belongs to release VMs, never CI.');
  tag = tag.startsWith('v') ? tag : `v${tag}`;
  if (!/^v\d+\.\d+\.\d+-beta\.\d+$/u.test(tag)) return { skipped: true };
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('Invalid repository');
  const endpoint = `/repos/${repository}/releases`;
  const beta = client.githubApi('GET', `${endpoint}/tags/${tag}`);
  if (beta.draft || !beta.prerelease || beta.tag_name !== tag)
    throw new Error('Beta release is not published');
  let stable;
  try {
    stable = client.githubApi('GET', `${endpoint}/latest`);
  } catch (error) {
    if (error.statusCode === 404) return { skipped: true };
    throw error;
  }
  if (stable.draft || stable.prerelease) throw new Error('Latest release is not stable');
  if (!betaIsNewer(tag, stable.tag_name)) return { skipped: true };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iyeris-beta-manifests-'));
  try {
    client.runGitHub([
      'release',
      'download',
      tag,
      '--repo',
      repository,
      '--pattern',
      'latest-*-beta-*.json',
      '--dir',
      directory,
    ]);
    const manifests = fs
      .readdirSync(directory)
      .filter((name) => /^latest-[\w-]+-beta-[\w-]+\.json$/u.test(name));
    if (!manifests.length) throw new Error('No beta manifests found');
    // Validate the entire set before uploading anything.
    for (const name of manifests) {
      const file = path.join(directory, name);
      if (fs.statSync(file).size > 1024 * 1024) throw new Error(`Manifest too large: ${name}`);
      validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')), tag, repository);
    }
    const current = client.githubApi('GET', `${endpoint}/latest`);
    if (current.id !== stable.id || current.tag_name !== stable.tag_name)
      throw new Error('Stable release changed during reconciliation; retry');
    for (const name of manifests) {
      const file = path.join(directory, name);
      client.uploadReleaseAsset(repository, stable.tag_name, file, { clobber: true });
    }
    const uploaded = client.githubApi('GET', `${endpoint}/${stable.id}/assets?per_page=100`);
    for (const name of manifests) {
      const expected = `sha256:${crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, name)))
        .digest('hex')}`;
      if (!uploaded.some((asset) => asset.name === name && asset.digest === expected))
        throw new Error(`Cannot verify uploaded manifest: ${name}`);
    }
    return { skipped: false, count: manifests.length, stableTag: stable.tag_name };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    cli.assertGitHubCliAuthenticated();
    const result = syncBetaManifests({
      tag: process.argv[2] || `v${require('../package.json').version}`,
      repository: `${process.env.GH_REPO_OWNER || 'BurntToasters'}/${process.env.GH_REPO_NAME || 'IYERIS'}`,
    });
    console.log(
      result.skipped
        ? 'Beta reconciliation skipped.'
        : `Reconciled ${result.count} manifests on ${result.stableTag}.`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { betaIsNewer, validateManifest, syncBetaManifests };
