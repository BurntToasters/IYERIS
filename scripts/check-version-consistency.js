#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './direct-execution.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function packageVersionFromToml(toml, label) {
  const packageStart = toml.search(/^\[package\]\s*$/mu);
  if (packageStart < 0) throw new Error(`Could not read ${label} package section`);
  const afterHeader = toml.indexOf('\n', packageStart) + 1;
  const nextSectionOffset = toml.slice(afterHeader).search(/^\[/mu);
  const packageSection = toml.slice(
    afterHeader,
    nextSectionOffset < 0 ? undefined : afterHeader + nextSectionOffset
  );
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  if (!version) throw new Error(`Could not read ${label} package version`);
  return version;
}

function appVersionFromCargoLock(lock, packageName = 'iyeris') {
  const blocks = lock.split(/^\[\[package\]\]\s*$/mu).slice(1);
  for (const block of blocks) {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/mu)?.[1];
    if (name === packageName) {
      const version = block.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
      if (version) return version;
    }
  }
  throw new Error(`Could not read Cargo.lock package ${packageName}`);
}

function topAppStreamVersion(xml) {
  const releases = xml.match(/<releases>([\s\S]*?)<\/releases>/u)?.[1];
  const version = releases?.match(/<release\b[^>]*\bversion="([^"]+)"/u)?.[1];
  if (!version) throw new Error('Could not read top AppStream release version');
  return version;
}

export function readVersionSources(root = repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
  );
  const metainfo = fs.readFileSync(path.join(root, 'run.rosie.iyeris.metainfo.xml'), 'utf8');
  return {
    'package.json': packageJson.version,
    'package-lock.json top-level': packageLock.version,
    'package-lock.json root package': packageLock.packages?.['']?.version,
    'Cargo.toml': packageVersionFromToml(cargoToml, 'Cargo.toml'),
    'Cargo.lock': appVersionFromCargoLock(cargoLock),
    'tauri.conf.json': tauriConfig.version,
    'AppStream top release': topAppStreamVersion(metainfo),
  };
}

export function findVersionMismatches(sources) {
  const expected = sources['package.json'];
  if (typeof expected !== 'string' || !expected) throw new Error('package.json version missing');
  return Object.entries(sources)
    .filter(([, version]) => version !== expected)
    .map(([label, version]) => ({ label, expected, actual: version }));
}

export function checkVersionConsistency(root = repoRoot) {
  const sources = readVersionSources(root);
  const mismatches = findVersionMismatches(sources);
  if (mismatches.length > 0) {
    throw new Error(
      `Version mismatch:\n${mismatches
        .map(
          ({ label, expected, actual }) =>
            `- ${label}: ${actual ?? '<missing>'} (expected ${expected})`
        )
        .join('\n')}`
    );
  }
  return sources['package.json'];
}

if (isDirectExecution(import.meta.url)) {
  try {
    console.log(`Version sources consistent: ${checkVersionConsistency()}`);
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
