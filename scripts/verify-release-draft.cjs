#!/usr/bin/env node

const https = require('https');
const path = require('path');

require('dotenv').config();

const pkg = require('../package.json');
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GH_REPO_OWNER || 'BurntToasters';
const REPO_NAME = process.env.GH_REPO_NAME || 'IYERIS';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.GH_REQUEST_TIMEOUT_MS || '30000', 10);

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

function expectedStableAssets() {
  const installers = [
    'IYERIS-Win-x64.exe',
    'IYERIS-Win-arm64.exe',
    'IYERIS-Win-x64-Enterprise.msi',
    'IYERIS-Win-arm64-Enterprise.msi',
    'IYERIS-MacOS-universal.dmg',
    'IYERIS-MacOS-universal.zip',
    'IYERIS-MacOS-universal.app.tar.gz',
    'IYERIS-Linux-x86_64.AppImage',
    'IYERIS-Linux-amd64.deb',
    'IYERIS-Linux-x86_64.rpm',
    'IYERIS-Linux-x86_64.flatpak',
  ];
  const updaterArtifacts = [
    'IYERIS-Win-x64.exe',
    'IYERIS-Win-arm64.exe',
    'IYERIS-Win-x64-Enterprise.msi',
    'IYERIS-Win-arm64-Enterprise.msi',
    'IYERIS-MacOS-universal.app.tar.gz',
    'IYERIS-Linux-x86_64.AppImage',
    'IYERIS-Linux-amd64.deb',
    'IYERIS-Linux-x86_64.rpm',
  ];
  const targetKeys = [
    'windows-x86_64',
    'windows-aarch64',
    'darwin-x86_64',
    'darwin-aarch64',
    'linux-x86_64',
  ];

  return new Set([
    ...installers,
    ...installers.map((name) => `${name}.asc`),
    ...updaterArtifacts.map((name) => `${name}.sig`),
    ...targetKeys.map((target) => `latest-${target}.json`),
    ...targetKeys.map((target) => `SHA256SUMS-${target}.txt`),
    ...targetKeys.map((target) => `SHA256SUMS-${target}.txt.asc`),
  ]);
}

function validateStableDraft(release, assets) {
  const errors = [];
  if (!release?.draft) errors.push(`${TAG} is not a draft release`);
  if (release?.prerelease) errors.push(`${TAG} is marked as a prerelease`);
  if (release?.tag_name !== TAG)
    errors.push(`expected tag ${TAG}, found ${release?.tag_name || 'none'}`);

  const byName = new Map();
  for (const asset of assets) {
    if (!asset?.name) continue;
    if (byName.has(asset.name)) errors.push(`duplicate asset name: ${asset.name}`);
    byName.set(asset.name, asset);
  }
  for (const name of expectedStableAssets()) {
    const asset = byName.get(name);
    if (!asset) errors.push(`missing asset: ${name}`);
    else if (!Number.isFinite(asset.size) || asset.size <= 0) errors.push(`empty asset: ${name}`);
  }
  return errors;
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
  if (/-(?:alpha|beta|rc)/i.test(VERSION)) {
    throw new Error(`Stable draft verification requires a stable version; found ${VERSION}.`);
  }

  const release = await findDraft();
  if (!release) throw new Error(`No draft release found for ${TAG}.`);
  const assets = await listAllAssets(release.id);
  const errors = validateStableDraft(release, assets);
  if (errors.length > 0) {
    throw new Error(`Release draft is incomplete:\n- ${errors.join('\n- ')}`);
  }
  console.log(`Release draft ${TAG} is complete (${assets.length} assets).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release draft verification failed: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = { expectedStableAssets, validateStableDraft, tag: TAG };
