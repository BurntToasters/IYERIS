#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TAURI_CONF = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const PRODUCT_NAME = TAURI_CONF.productName;
const VERSION = TAURI_CONF.version;
const ASSETS_DIR = path.join(ROOT, 'src-tauri', 'msstore-assets');
const MANIFEST_TEMPLATE = path.join(ASSETS_DIR, 'AppxManifest.xml');
const MSSTORE_DIR = path.join(ROOT, 'msstore');

const MSIX_VERSION = toFourPartVersion(VERSION);

const REQUIRED_ENV = {
  MSSTORE_IDENTITY_NAME: 'Identity Name from Partner Center (e.g., 12345Publisher.IYERIS)',
  MSSTORE_PUBLISHER: 'Publisher CN from Partner Center (e.g., CN=XXXXXXXX-...)',
  MSSTORE_PUBLISHER_DISPLAY_NAME: 'Publisher display name (e.g., Your Name)',
};

const TARGETS = [
  { arch: 'x64', msixArch: 'x64', rustTarget: 'x86_64-pc-windows-msvc' },
  { arch: 'arm64', msixArch: 'arm64', rustTarget: 'aarch64-pc-windows-msvc' },
];

function toFourPartVersion(semver) {
  const clean = semver.replace(/-.*$/, '');
  const parts = clean.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function findExe(rustTarget) {
  const releasePath = path.join(
    ROOT,
    'src-tauri',
    'target',
    rustTarget,
    'release',
    `${PRODUCT_NAME}.exe`
  );
  if (fs.existsSync(releasePath)) return releasePath;

  const fallback = path.join(ROOT, 'src-tauri', 'target', 'release', `${PRODUCT_NAME}.exe`);
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

function copyDirContents(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function loadEnv() {
  const missing = [];
  const values = {};
  for (const [key, desc] of Object.entries(REQUIRED_ENV)) {
    const val = process.env[key];
    if (!val) {
      missing.push(`  ${key} — ${desc}`);
    } else {
      values[key] = val;
    }
  }
  if (missing.length > 0) {
    console.error('Missing required environment variables:\n' + missing.join('\n'));
    console.error('\nSet them in your .env file or export them before running this script.');
    process.exit(1);
  }
  return values;
}

function buildManifest(arch, env) {
  let manifest = fs.readFileSync(MANIFEST_TEMPLATE, 'utf8');
  manifest = manifest.replace(/\{\{IDENTITY_NAME\}\}/g, env.MSSTORE_IDENTITY_NAME);
  manifest = manifest.replace(/\{\{PUBLISHER\}\}/g, env.MSSTORE_PUBLISHER);
  manifest = manifest.replace(
    /\{\{PUBLISHER_DISPLAY_NAME\}\}/g,
    env.MSSTORE_PUBLISHER_DISPLAY_NAME
  );
  manifest = manifest.replace(/\{\{VERSION\}\}/g, MSIX_VERSION);
  manifest = manifest.replace(/\{\{ARCH\}\}/g, arch);
  return manifest;
}

const requestedArch = process.argv[2];
const targets = requestedArch ? TARGETS.filter((t) => t.arch === requestedArch) : TARGETS;

if (targets.length === 0) {
  console.error(`Unknown architecture: ${requestedArch}. Use x64 or arm64.`);
  process.exit(1);
}

const env = loadEnv();
ensureDir(MSSTORE_DIR);

const msixPaths = [];

for (const { arch, msixArch, rustTarget } of targets) {
  console.log(`\nPackaging MSIX for ${arch}...`);

  const exe = findExe(rustTarget);
  if (!exe) {
    console.error(`No built exe found for ${rustTarget}. Run "npm run build:win:${arch}" first.`);
    process.exit(1);
  }

  const packDir = path.join(MSSTORE_DIR, `pack-${arch}`);
  fs.rmSync(packDir, { recursive: true, force: true });
  ensureDir(packDir);

  fs.copyFileSync(exe, path.join(packDir, `${PRODUCT_NAME}.exe`));

  const assetsOut = path.join(packDir, 'Assets');
  ensureDir(assetsOut);
  for (const file of fs.readdirSync(ASSETS_DIR)) {
    if (file.endsWith('.png')) {
      fs.copyFileSync(path.join(ASSETS_DIR, file), path.join(assetsOut, file));
    }
  }

  const manifestContent = buildManifest(msixArch, env);
  fs.writeFileSync(path.join(packDir, 'AppxManifest.xml'), manifestContent, 'utf8');

  const msixName = `${PRODUCT_NAME}_${MSIX_VERSION}_${arch}.msix`;
  const msixOut = path.join(MSSTORE_DIR, msixName);
  if (fs.existsSync(msixOut)) fs.unlinkSync(msixOut);

  run(`makeappx pack /d "${packDir}" /p "${msixOut}" /nv`);

  fs.rmSync(packDir, { recursive: true, force: true });

  if (fs.existsSync(msixOut)) {
    console.log(`Created: ${msixName}`);
    msixPaths.push(msixOut);
  } else {
    console.error(`Failed to create ${msixName}`);
    process.exit(1);
  }
}

if (msixPaths.length > 1) {
  console.log('\nCreating MSIX bundle...');
  const bundleName = `${PRODUCT_NAME}_${MSIX_VERSION}.msixbundle`;
  const bundleOut = path.join(MSSTORE_DIR, bundleName);
  if (fs.existsSync(bundleOut)) fs.unlinkSync(bundleOut);

  const bundleDir = path.join(MSSTORE_DIR, 'bundle-input');
  fs.rmSync(bundleDir, { recursive: true, force: true });
  ensureDir(bundleDir);
  for (const msixPath of msixPaths) {
    fs.copyFileSync(msixPath, path.join(bundleDir, path.basename(msixPath)));
  }

  run(`makeappx bundle /d "${bundleDir}" /p "${bundleOut}"`);
  fs.rmSync(bundleDir, { recursive: true, force: true });

  if (fs.existsSync(bundleOut)) {
    console.log(`Created bundle: ${bundleName}`);
  }
}

console.log(`\nMSIX packages are in: ${MSSTORE_DIR}/`);
console.log(
  'Upload the .msixbundle (or individual .msix) to Partner Center — Microsoft will sign it.'
);
