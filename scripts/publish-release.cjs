#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { verifyReleaseContent } = require('./verify-release-content.cjs');
const { assertGitHubCliAuthenticated, githubApi } = require('./github-cli.cjs');
const { expectedReleaseAssets, validateReleaseDraft } = require('./verify-release-draft.cjs');

require('dotenv').config();

const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG = `v${VERSION}`;
const IS_PRERELEASE = /-(?:alpha|beta|rc)(?:[.-]?\d+)?/i.test(VERSION);
const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'IYERIS';

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function githubRequest(method, endpoint, body) {
  return githubApi(method, endpoint, body);
}

function findDraft(releases) {
  return releases.find((release) => release?.draft && release.tag_name === TAG) || null;
}

function listAssets(releaseId) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = githubRequest(
      'GET',
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid assets payload.');
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

function publishPayload() {
  return { draft: false, prerelease: IS_PRERELEASE };
}

async function main() {
  if (process.env.GITHUB_ACTIONS === 'true')
    throw new Error('Releases belong to release VMs, never CI.');
  assertGitHubCliAuthenticated();
  execFileSync(process.execPath, [path.join(__dirname, 'release-session.js')], {
    stdio: 'inherit',
  });
  const targetCommit = currentCommit();
  const releases = githubRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`);
  if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid releases payload.');
  const release = findDraft(releases);
  if (!release) throw new Error(`No draft release found for ${TAG}.`);
  if (release.target_commitish !== targetCommit) {
    throw new Error(
      `Release ${TAG} is pinned to ${release.target_commitish || '<missing>'}, expected ${targetCommit}.`
    );
  }

  const assets = listAssets(release.id);
  const errors = validateReleaseDraft(release, assets, {
    prerelease: IS_PRERELEASE,
    tag: TAG,
    targetCommit,
    requireDigests: true,
  });
  if (errors.length > 0) {
    throw new Error(`Release draft is incomplete:\n- ${errors.join('\n- ')}`);
  }
  await verifyReleaseContent(assets, {
    tag: TAG,
    repository: `${REPO_OWNER}/${REPO_NAME}`,
    publicKey: require('../src-tauri/tauri.conf.json').plugins.updater.pubkey,
  });
  const currentAssets = listAssets(release.id);
  const identity = (items) =>
    items
      .map(({ id, name, size, digest }) => JSON.stringify([id, name, size, digest]))
      .sort()
      .join('\n');
  if (identity(assets) !== identity(currentAssets))
    throw new Error('Release assets changed during verification');
  const requiredCount = expectedReleaseAssets({ prerelease: IS_PRERELEASE }).size;
  console.log(`Publishing ${TAG} (${assets.length} assets; ${requiredCount} required)...`);
  const published = githubRequest(
    'PATCH',
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${release.id}`,
    publishPayload()
  );
  if (published?.draft) throw new Error(`GitHub did not publish ${TAG}.`);
  console.log(`Published ${TAG}.`);
  try {
    require('./sync-beta-manifests.cjs').syncBetaManifests({
      tag: TAG,
      repository: `${REPO_OWNER}/${REPO_NAME}`,
    });
  } catch (error) {
    throw new Error(
      `Release is published, but beta reconciliation failed: ${error.message}. Retry npm run release:sync-beta on the release VM.`,
      { cause: error }
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release publish failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = { findDraft, publishPayload };
