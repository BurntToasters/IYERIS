const fs = require('fs');
const path = require('path');

const CLEAN_TARGETS = {
  clean: ['dist'],
  'clean-release': ['release'],
};

function cleanDirs(dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      const message = error && error.message ? error.message : String(error);
      throw new Error(`Failed to clean "${dir}": ${message}`);
    }
  }
}

function cleanBuildArtifacts(mode) {
  const targets = CLEAN_TARGETS[mode];
  if (!targets) {
    throw new Error(`Unknown clean mode "${mode}"`);
  }
  cleanDirs(targets);
}

function copyFileEnsuringDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRuntimeAssets() {
  copyFileEnsuringDir(
    path.join('src', 'css', 'twemoji.css'),
    path.join('dist', 'css', 'twemoji.css')
  );

  const highlightBase = path.dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
  copyFileEnsuringDir(
    path.join(highlightBase, 'highlight.min.js'),
    path.join('dist', 'vendor', 'highlight.js')
  );
  copyFileEnsuringDir(
    path.join(highlightBase, 'styles', 'atom-one-dark.min.css'),
    path.join('dist', 'vendor', 'highlight.css')
  );

  const pdfBase = path.dirname(require.resolve('pdfjs-dist/package.json'));
  copyFileEnsuringDir(
    path.join(pdfBase, 'build', 'pdf.min.mjs'),
    path.join('dist', 'vendor', 'pdfjs', 'pdf.min.mjs')
  );
  copyFileEnsuringDir(
    path.join(pdfBase, 'build', 'pdf.worker.min.mjs'),
    path.join('dist', 'vendor', 'pdfjs', 'pdf.worker.min.mjs')
  );
}

const mode = process.argv[2];

if (mode === 'clean' || mode === 'clean-release') {
  cleanBuildArtifacts(mode);
  process.exit(0);
}

if (mode === 'copy') {
  copyRuntimeAssets();
  process.exit(0);
}

console.error('Usage: node build/dist-tools.js <clean|clean-release|copy>');
process.exit(1);
