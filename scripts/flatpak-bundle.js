#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    cwd: root,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function normalizeArch(raw) {
  const value = String(raw || '')
    .toLowerCase()
    .trim();
  if (value === 'x86_64' || value === 'amd64' || value === 'x64' || value === 'x86-64')
    return 'x64';
  if (value === 'aarch64' || value === 'arm64') return 'arm64';
  return value || 'unknown';
}

function detectArch() {
  const envArch = normalizeArch(process.env.FLATPAK_ARCH || '');
  if (envArch !== 'unknown') return envArch;
  const flatpakArch = normalizeArch(runCapture('flatpak', ['--default-arch']));
  if (flatpakArch !== 'unknown') return flatpakArch;
  return normalizeArch(process.arch);
}

function main() {
  if (process.platform !== 'linux')
    throw new Error('Flatpak bundling is only supported on Linux hosts.');

  run('flatpak-builder', [
    '--repo=flatpak-repo',
    '--force-clean',
    'flatpak-build',
    'com.burnttoasters.iyeris.yml',
  ]);

  const arch = detectArch();
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const bundlePath = path.join(distDir, `IYERIS-Linux-${arch}.flatpak`);

  run('flatpak', ['build-bundle', 'flatpak-repo', bundlePath, 'com.burnttoasters.iyeris']);
  console.log(`Created Flatpak bundle: ${bundlePath}`);
}

try {
  main();
} catch (error) {
  console.error(`Flatpak bundle failed: ${error?.message || error}`);
  process.exit(1);
}
