#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ICONS_ROOT = path.join(process.cwd(), 'src-tauri', 'icons');
const FALLBACK_PATTERNS = [
  /^(?:icon-)?(?:macOS(?:-macOS)?-Default-)(\d+x\d+)(?:@([12])x)?\.png$/i,
  /^(?:icon-)(\d+x\d+)(?:@([12])x)?\.png$/i,
];

function toCanonicalIconName(fileName) {
  if (!fileName.toLowerCase().endsWith('.png')) return null;
  if (fileName.startsWith('icon_')) return null;
  for (const pattern of FALLBACK_PATTERNS) {
    const match = fileName.match(pattern);
    if (!match) continue;
    const size = match[1];
    const scale = match[2] ?? '1';
    return `icon_${size}@${scale}x.png`;
  }
  return null;
}

function getIconsetDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.iconset'))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function normalizeIconset(iconsetDir) {
  const entries = fs.readdirSync(iconsetDir, { withFileTypes: true });
  let renamedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
    const targetName = toCanonicalIconName(entry.name);
    if (!targetName) continue;
    const sourcePath = path.join(iconsetDir, entry.name);
    const targetPath = path.join(iconsetDir, targetName);
    if (fs.existsSync(targetPath)) {
      console.warn(`Skipping ${entry.name} — ${targetName} already exists.`);
      continue;
    }
    fs.renameSync(sourcePath, targetPath);
    renamedCount += 1;
  }
  return renamedCount;
}

function main() {
  const iconsetDirs = getIconsetDirs(ICONS_ROOT);
  if (iconsetDirs.length === 0) {
    console.log('No .iconset directories found under src-tauri/icons.');
    return;
  }
  let totalRenamed = 0;
  for (const iconsetDir of iconsetDirs) {
    const renamed = normalizeIconset(iconsetDir);
    totalRenamed += renamed;
    if (renamed > 0)
      console.log(`Normalized ${renamed} file(s) in ${path.relative(process.cwd(), iconsetDir)}.`);
  }
  if (totalRenamed === 0) console.log('Iconsets are already normalized.');
}

main();
