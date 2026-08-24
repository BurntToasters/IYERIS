#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;

const tauriConf = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(tauriConf, 'utf-8'));
if (conf.version !== version) {
  conf.version = version;
  fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + '\n');
  console.log(`tauri.conf.json → ${version}`);
}

const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
let cargo = fs.readFileSync(cargoPath, 'utf-8');
const packageSectionPattern = /(\[package\][\s\S]*?)(\r?\n\[[^\]]+\]|$)/;
const packageSectionMatch = cargo.match(packageSectionPattern);

let updated = cargo;
if (packageSectionMatch) {
  const packageSection = packageSectionMatch[1];
  const nextPackageSection = packageSection.replace(
    /^(\s*version\s*=\s*)"[^"]*"/m,
    `$1"${version}"`
  );
  if (nextPackageSection !== packageSection) {
    updated = cargo.replace(packageSection, nextPackageSection);
  }
}

if (updated !== cargo) {
  fs.writeFileSync(cargoPath, updated);
  console.log(`Cargo.toml      → ${version}`);
}

const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');
if (fs.existsSync(cargoLockPath)) {
  const cargoLock = fs.readFileSync(cargoLockPath, 'utf-8');
  const packageNameMatch = (updated !== cargo ? updated : cargo).match(/^name\s*=\s*"([^"]+)"/m);
  const packageName = packageNameMatch?.[1] ?? 'iyeris';
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lockPackagePattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = )"[^"]*"`
  );
  const lockMatch = cargoLock.match(lockPackagePattern);
  if (lockMatch && !lockMatch[0].includes(`version = "${version}"`)) {
    fs.writeFileSync(cargoLockPath, cargoLock.replace(lockPackagePattern, `$1"${version}"`));
    console.log(`Cargo.lock      → ${version}`);
  }
}
