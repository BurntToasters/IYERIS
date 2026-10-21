#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  macBundleVersionFromSemver,
  macMarketingVersionFromSemver,
  syncChangelogForVersion,
  syncNpmLockfileVersion,
  updateCargoLockPackageVersion,
  updatePlistStringValue,
} from './sync-version-helpers.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;

const macBundleVersion = macBundleVersionFromSemver(version);
const macMarketingVersion = macMarketingVersionFromSemver(version);

function writeFileAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let ownsTemporaryPath = false;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    ownsTemporaryPath = true;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (ownsTemporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The rename succeeded, so there is no temporary file left to clean.
      }
    }
  }
}

const tauriConf = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(tauriConf, 'utf-8'));
if (!conf.bundle?.macOS) {
  console.error('tauri.conf.json is missing bundle.macOS configuration');
  process.exit(1);
}
if (conf.version !== version || conf.bundle.macOS.bundleVersion !== macBundleVersion) {
  conf.version = version;
  conf.bundle.macOS.bundleVersion = macBundleVersion;
  writeFileAtomic(tauriConf, JSON.stringify(conf, null, 2) + '\n');
  const verify = JSON.parse(fs.readFileSync(tauriConf, 'utf-8'));
  if (verify.version !== version || verify.bundle?.macOS?.bundleVersion !== macBundleVersion) {
    console.error('tauri.conf.json write verification failed');
    process.exit(1);
  }
  console.log(`tauri.conf.json → ${version} (macOS build ${macBundleVersion})`);
}

const macInfoPath = path.join(root, 'src-tauri', 'Info.plist');
const macInfo = fs.readFileSync(macInfoPath, 'utf8');
let updatedMacInfo;
try {
  updatedMacInfo = updatePlistStringValue(
    macInfo,
    'CFBundleShortVersionString',
    macMarketingVersion
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedMacInfo !== macInfo) {
  writeFileAtomic(macInfoPath, updatedMacInfo);
  console.log(`Info.plist       → ${macMarketingVersion}`);
}

const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
let cargo = fs.readFileSync(cargoPath, 'utf-8');
const packageSectionPattern = /(\[package\][\s\S]*?)(\r?\n\[[^\]]+\]|$)/;
const packageSectionMatch = cargo.match(packageSectionPattern);
if (!packageSectionMatch) {
  console.error('Cargo.toml is missing a package section');
  process.exit(1);
}

const packageName = packageSectionMatch[1].match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
if (!packageName) {
  console.error('Cargo.toml package name is missing');
  process.exit(1);
}

let updated = cargo;
const packageSection = packageSectionMatch[1];
const nextPackageSection = packageSection.replace(/^(\s*version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
if (nextPackageSection !== packageSection) {
  updated = cargo.replace(packageSection, nextPackageSection);
}

if (updated !== cargo) {
  writeFileAtomic(cargoPath, updated);
  const cargoVerify = fs.readFileSync(cargoPath, 'utf-8');
  if (!cargoVerify.includes(`version = "${version}"`)) {
    console.error('Cargo.toml write verification failed');
    process.exit(1);
  }
  console.log(`Cargo.toml      → ${version}`);
}

const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');
const cargoLock = fs.readFileSync(cargoLockPath, 'utf-8');
let updatedLock;
try {
  updatedLock = updateCargoLockPackageVersion(cargoLock, packageName, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedLock !== cargoLock) {
  writeFileAtomic(cargoLockPath, updatedLock);
  const lockVerify = fs.readFileSync(cargoLockPath, 'utf-8');
  if (!lockVerify.match(new RegExp(`name = "${packageName}"\\r?\\nversion = "${version}"`))) {
    console.error('Cargo.lock write verification failed');
    process.exit(1);
  }
  console.log(`Cargo.lock      → ${version}`);
}

const changelogPath = path.join(root, 'CHANGELOG.md');
const changelog = fs.readFileSync(changelogPath, 'utf8');
let syncedChangelog;
try {
  syncedChangelog = syncChangelogForVersion(changelog, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (syncedChangelog !== changelog) {
  writeFileAtomic(changelogPath, syncedChangelog);
  console.log(`CHANGELOG.md    → ${version} (download URLs + section)`);
}

const npmLockPath = path.join(root, 'package-lock.json');
const npmLock = fs.readFileSync(npmLockPath, 'utf8');
let updatedNpmLock;
try {
  updatedNpmLock = syncNpmLockfileVersion(npmLock, version);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (updatedNpmLock !== npmLock) {
  writeFileAtomic(npmLockPath, updatedNpmLock);
  const lockVerify = JSON.parse(fs.readFileSync(npmLockPath, 'utf8'));
  if (lockVerify.version !== version || lockVerify.packages?.['']?.version !== version) {
    console.error('package-lock.json write verification failed');
    process.exit(1);
  }
  console.log(`package-lock.json → ${version}`);
}
