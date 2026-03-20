#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  ! Source not found: ${path.relative(root, src)}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyDirIfExists(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  ! Source dir not found: ${path.relative(root, src)}`);
    return false;
  }
  fs.cpSync(src, dest, { recursive: true, force: true });
  return true;
}

console.log('Copying vendor assets to public/...');

const hljsBase = path.dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
copyIfExists(
  path.join(hljsBase, 'highlight.min.js'),
  path.join(root, 'public', 'vendor', 'highlight.js')
);
copyIfExists(
  path.join(hljsBase, 'styles', 'atom-one-dark.min.css'),
  path.join(root, 'public', 'vendor', 'highlight.css')
);

const pdfjsBase = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
copyIfExists(
  path.join(pdfjsBase, 'pdf.min.mjs'),
  path.join(root, 'public', 'vendor', 'pdfjs', 'pdf.min.mjs')
);
copyIfExists(
  path.join(pdfjsBase, 'pdf.worker.min.mjs'),
  path.join(root, 'public', 'vendor', 'pdfjs', 'pdf.worker.min.mjs')
);

copyDirIfExists(path.join(root, 'assets', 'twemoji'), path.join(root, 'public', 'twemoji'));

for (const img of ['folder.png', 'folder-beta.png', 'icon.png']) {
  copyIfExists(path.join(root, 'assets', img), path.join(root, 'public', img));
}

console.log('Done.');
