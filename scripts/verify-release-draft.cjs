#!/usr/bin/env node

const https = require('https');

require('dotenv').config();

const pkg = require('../package.json');
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const IS_PRERELEASE = /-(?:alpha|beta|rc)(?:[.-]?\d+)?/i.test(VERSION);
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'IYERIS';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.GH_REQUEST_TIMEOUT_MS || '30000', 10);

const BASE_INSTALLERS = [
  'IYERIS-Win-x64.exe',
  'IYERIS-Win-arm64.exe',
  'IYERIS-MacOS-universal.dmg',
  'IYERIS-MacOS-universal.zip',
  'IYERIS-MacOS-universal.app.tar.gz',
  'IYERIS-Linux-x86_64.AppImage',
  'IYERIS-Linux-amd64.deb',
  'IYERIS-Linux-x86_64.rpm',
  'IYERIS-Linux-x86_64.flatpak',
];
const MSI_INSTALLERS = ['IYERIS-Win-x64-Enterprise.msi', 'IYERIS-Win-arm64-Enterprise.msi'];
const BASE_UPDATER_ARTIFACTS = [
  'IYERIS-Win-x64.exe',
  'IYERIS-Win-arm64.exe',
  'IYERIS-MacOS-universal.app.tar.gz',
  'IYERIS-Linux-x86_64.AppImage',
  'IYERIS-Linux-amd64.deb',
  'IYERIS-Linux-x86_64.rpm',
];
const STABLE_TARGET_KEYS = [
  'windows-x86_64',
  'windows-aarch64',
  'darwin-x86_64',
  'darwin-aarch64',
  'linux-x86_64',
];

function betaTargetKey(target) {
  const separator = target.indexOf('-');
  if (separator < 0) throw new Error(`Invalid release target key: ${target}`);
  return `${target.slice(0, separator)}-beta${target.slice(separator)}`;
}

function githubRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.github.com',
        path: endpoint,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          'User-Agent': 'IYERIS-Release-Verifier',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          let parsed;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch (error) {
            reject(new Error(`GitHub returned invalid JSON: ${error.message}`));
            return;
          }
          if ((response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300) {
            resolve(parsed);
            return;
          }
          reject(
            new Error(
              `GitHub ${response.statusCode || 0}: ${parsed?.message || body || 'unknown error'}`
            )
          );
        });
      }
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`GitHub request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on('error', reject);
    request.end();
  });
}

function expectedReleaseAssets({ prerelease = IS_PRERELEASE } = {}) {
  const installers = prerelease ? BASE_INSTALLERS : [...BASE_INSTALLERS, ...MSI_INSTALLERS];
  const updaterArtifacts = prerelease
    ? BASE_UPDATER_ARTIFACTS
    : [...BASE_UPDATER_ARTIFACTS, ...MSI_INSTALLERS];
  const targetKeys = prerelease
    ? [...STABLE_TARGET_KEYS, ...STABLE_TARGET_KEYS.map(betaTargetKey)]
    : STABLE_TARGET_KEYS;

  return new Set([
    ...installers,
    ...installers.map((name) => `${name}.asc`),
    ...updaterArtifacts.map((name) => `${name}.sig`),
    ...targetKeys.map((target) => `latest-${target}.json`),
    ...targetKeys.map((target) => `SHA256SUMS-${target}.txt`),
    ...targetKeys.map((target) => `SHA256SUMS-${target}.txt.asc`),
  ]);
}

function expectedStableAssets() {
  return expectedReleaseAssets({ prerelease: false });
}

function expectedPrereleaseAssets() {
  return expectedReleaseAssets({ prerelease: true });
}

function validateReleaseDraft(release, assets, { prerelease = IS_PRERELEASE, tag = TAG } = {}) {
  const errors = [];
  if (!release?.draft) errors.push(`${tag} is not a draft release`);
  if (prerelease && !release?.prerelease) errors.push(`${tag} is not marked as a prerelease`);
  if (!prerelease && release?.prerelease) errors.push(`${tag} is marked as a prerelease`);
  if (release?.tag_name !== tag)
    errors.push(`expected tag ${tag}, found ${release?.tag_name || 'none'}`);

  const byName = new Map();
  for (const asset of assets) {
    if (!asset?.name) continue;
    if (byName.has(asset.name)) errors.push(`duplicate asset name: ${asset.name}`);
    byName.set(asset.name, asset);
  }
  for (const name of expectedReleaseAssets({ prerelease })) {
    const asset = byName.get(name);
    if (!asset) errors.push(`missing asset: ${name}`);
    else if (!Number.isFinite(asset.size) || asset.size <= 0) errors.push(`empty asset: ${name}`);
  }
  return errors;
}

function validateStableDraft(release, assets) {
  return validateReleaseDraft(release, assets, { prerelease: false, tag: TAG });
}

function validatePrereleaseDraft(release, assets) {
  return validateReleaseDraft(release, assets, { prerelease: true, tag: TAG });
}

async function findDraft() {
  const releases = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`);
  if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid releases payload');
  return releases.find((release) => release?.draft && release?.tag_name === TAG) || null;
}

async function listAllAssets(releaseId) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid assets payload');
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

async function main() {
  if (!GH_TOKEN) throw new Error('GH_TOKEN is required to verify the release draft.');

  const release = await findDraft();
  if (!release) throw new Error(`No draft release found for ${TAG}.`);
  const assets = await listAllAssets(release.id);
  const errors = validateReleaseDraft(release, assets);
  if (errors.length > 0) {
    throw new Error(`Release draft is incomplete:\n- ${errors.join('\n- ')}`);
  }
  console.log(
    `Release draft ${TAG} is complete (${assets.length} assets; ${expectedReleaseAssets().size} required).`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release draft verification failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  expectedPrereleaseAssets,
  expectedReleaseAssets,
  expectedStableAssets,
  isPrerelease: IS_PRERELEASE,
  tag: TAG,
  validatePrereleaseDraft,
  validateReleaseDraft,
  validateStableDraft,
};
